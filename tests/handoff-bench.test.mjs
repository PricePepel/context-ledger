import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { parseClaudeStream, parseCodexEvents } from '../evals/handoff/agents.mjs';
import { agreement, labelled } from '../evals/handoff/agreement.mjs';
import { beatLines, facts, handoffQuestion, lateOnlyMarkers, party, referenceGraph, transcript } from '../evals/handoff/fixtures.mjs';
import { keywordGrader } from '../evals/handoff/grade-keyword.mjs';
import { valueGrader } from '../evals/handoff/grade-values.mjs';
import { gradeReply } from '../evals/handoff/reply.mjs';
import { armOrder } from '../evals/handoff/run.mjs';
import { summarize } from '../evals/handoff/spend.mjs';
import { bearer, ledgerToken } from './ledger-auth.mjs';
import { startMcp } from './mcp-client.mjs';

// Card G10: the handoff benchmark's offline parts. All data is synthetic.
const run = promisify(execFile);
const runner = ['evals/handoff/run.mjs'];
const fake = 'evals/handoff/fake-cli.mjs';

async function startServer(database) {
  const child = spawn(process.execPath, ['src/server.mjs'], {
    env: { ...process.env, PORT: '0', CONTEXT_LEDGER_DB: database },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let output = '';
  for await (const chunk of child.stdout) {
    output += chunk;
    const match = output.match(/listening at (http:\/\/127\.0\.0\.1:(\d+))/u);
    if (match) return { origin: match[1], port: Number(match[2]), database, headers: bearer(await ledgerToken(database, Number(match[2]))), stop: async () => { child.kill(); await once(child, 'exit'); } };
  }
  throw new Error('Server exited before listening: ' + output);
}

async function post({ origin, headers }, path, body) {
  const response = await fetch(origin + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...headers }, body: JSON.stringify(body),
  });
  assert.equal(response.status, 200, `${path}: ${await response.clone().text()}`);
  return response.json();
}

test('the fixture has 14 facts: 6 changed, 7 with a late current value, 4 not on page 1 at all', () => {
  assert.ok(facts.length >= 12);
  assert.ok(facts.filter(fact => fact.superseded.length).length >= 3);
  assert.ok(facts.filter(fact => fact.late).length >= 4);
  assert.ok(facts.filter(fact => fact.lateOnly).length >= 4);
  assert.deepEqual(Object.keys(lateOnlyMarkers).sort(), facts.filter(fact => fact.lateOnly).map(fact => fact.key).sort());
  const records = transcript.split('\n').map(line => JSON.parse(line));
  for (const record of records) {
    assert.ok(['user', 'assistant'].includes(record.type));
    assert.equal(record.message.role, record.type);
  }
  for (const fact of facts) {
    assert.match(handoffQuestion, new RegExp(`"${fact.key}"`, 'u'));
    // The current value is stated in the fact's last beat, every old value in an earlier one.
    const said = fact.beats.map(name => beatLines[name].map(line => records[line - 1].message.content).join(' '));
    assert.ok(said.at(-1).toLowerCase().includes(fact.current.toLowerCase()), `${fact.key}: ${fact.current}`);
    for (const old of fact.superseded) assert.ok(said.slice(0, -1).join(' ').toLowerCase().includes(old.toLowerCase()), `${fact.key}: ${old}`);
    // Both graders accept the current value as written and refuse every old one.
    assert.equal(keywordGrader[fact.key](fact.current), true, `A on ${fact.key}`);
    assert.equal(valueGrader[fact.key](fact.current), true, `B on ${fact.key}`);
    for (const old of fact.superseded) {
      assert.equal(keywordGrader[fact.key](old), false, `A on old ${fact.key}`);
      assert.equal(valueGrader[fact.key](old), false, `B on old ${fact.key}`);
    }
  }
  assert.equal(Object.keys(keywordGrader).length, facts.length);
  assert.deepEqual(Object.keys(valueGrader).sort(), Object.keys(keywordGrader).sort());
});

test('the benchmark uses its own fixtures and never imports demo/', async () => {
  const directory = new URL('../evals/handoff/', import.meta.url);
  for (const name of await readdir(directory)) {
    const text = await readFile(new URL(name, directory), 'utf8');
    assert.doesNotMatch(text, /from ['"][./]*demo\//u, name);
  }
});

test('session_read pages the long transcript, and the late facts appear only after page 1', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-handoff-bench-'));
  let server;
  let client;
  t.after(async () => {
    try {
      if (client && client.child.exitCode === null) await client.close();
    } finally {
      try {
        await server?.stop();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });
  server = await startServer(join(directory, 'ledger.sqlite'));
  const { session } = await post(server, '/api/import', { provider: party.provider, source: party.source, transcript });
  const { graph } = await post(server, '/api/graphs', referenceGraph(session.id));
  client = startMcp(server.port, { CONTEXT_LEDGER_DB: server.database });
  await client.request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} });

  // Follow the real tool's continuation notes to the end.
  const pages = [];
  let position = {};
  for (let id = 2; id < 50; id += 1) {
    const result = await client.call(id, 'session_read', { sessionId: session.id, ...position });
    assert.equal(result.isError, undefined, result.content[0].text);
    const page = result.content[0].text;
    pages.push(page);
    const next = page.match(/Call session_read again with fromLine (\d+)(?: and fromOffset (\d+))?\.\]$/u);
    if (!next) break;
    position = { fromLine: Number(next[1]), ...(next[2] ? { fromOffset: Number(next[2]) } : {}) };
  }
  assert.ok(pages.length >= 2, `session_read returned ${pages.length} page(s)`);
  assert.match(pages[0], /^\[Partial result: \d+ more turns remain\./u);
  // Turn text only: the header's session ID and the "## user · line 45" headings hold
  // digits that could look like a value.
  const turns = page => page.slice(page.indexOf('\n## ')).split('\n').filter(line => !line.startsWith('## ')).join('\n');
  const [first, ...rest] = pages.map(turns);
  const later = rest.join('\n');
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const states = (text, value) => new RegExp(`(?<![\\w-])${escape(value)}(?![\\w-])`, 'iu').test(text);
  // Card P2b: a heading may end with the turn's key.
  const lastLineOnFirst = Math.max(...[...pages[0].matchAll(/^## \w+ · line (\d+)(?: · key \S+)?$/gmu)].map(match => Number(match[1])));
  t.diagnostic(`${pages.length} pages; page 1 ends at line ${lastLineOnFirst} of ${transcript.split('\n').length}`);

  for (const fact of facts) {
    const lastBeat = beatLines[fact.beats.at(-1)];
    if (fact.late) {
      assert.ok(lastBeat[0] > lastLineOnFirst, `${fact.key} is stated after page 1`);
      assert.ok(!states(first, fact.current), `page 1 must not state ${fact.key}`);
      assert.ok(states(later, fact.current), `a later page states ${fact.key}`);
    } else {
      assert.ok(lastBeat[1] <= lastLineOnFirst, `${fact.key} is on page 1`);
      assert.ok(states(first, fact.current), `page 1 states ${fact.key}`);
    }
  }
  for (const [key, markers] of Object.entries(lateOnlyMarkers)) {
    for (const marker of markers) assert.ok(!states(first, marker), `page 1 mentions ${key} (${marker})`);
  }

  // The graph arm can answer every fact: the briefing states each current value.
  const briefing = await client.call(60, 'context_for', { graphId: graph.id });
  assert.equal(briefing.isError, undefined);
  for (const fact of facts) assert.ok(briefing.content[0].text.toLowerCase().includes(fact.current.toLowerCase()), `briefing has ${fact.key}`);
});

test('labelled set: grader A and grader B against 82 hand labels and each other', t => {
  assert.ok(labelled.length >= 60);
  const kinds = new Set(labelled.map(item => item.kind));
  for (const kind of ['right', 'paraphrase', 'superseded', 'negated', 'missing', 'added-false-detail']) assert.ok(kinds.has(kind), kind);
  for (const fact of facts) assert.ok(labelled.some(item => item.fact === fact.key), fact.key);
  assert.equal(new Set(labelled.map(item => item.id)).size, labelled.length, 'unique ids');
  for (const item of labelled) assert.ok(['right', 'wrong'].includes(item.label), item.id);

  const report = agreement();
  t.diagnostic(`A with labels ${report.aWithLabels}/${report.items}, B with labels ${report.bWithLabels}/${report.items}, A with B ${report.aWithB}/${report.items}`);
  // The numbers recorded in docs/evals.md. A grader change must re-measure and re-record them.
  assert.deepEqual(
    [report.items, report.aWithLabels, report.bWithLabels, report.aWithB, report.aFalseAccepts, report.aFalseRejects, report.bFalseAccepts, report.bFalseRejects],
    [82, 60, 79, 63, 22, 0, 3, 0],
  );
  // B's three misses are claims of another type, which it does not look for.
  assert.deepEqual(report.disagreements.filter(row => row.b !== row.label).map(row => row.id), ['launch-5', 'retry-3', 'flag-3']);
  // Neither grader refuses a right answer.
  assert.equal(report.aFalseRejects + report.bFalseRejects, 0);
});

test('review regressions: grader B refuses unknown names, other intervals, and an answered or denied question', () => {
  // Codex review of 9cf3895: these passed grader B. They stay out of the labelled set,
  // which was written before the graders and is kept as it was.
  assert.equal(valueGrader.reviewer('Priya and Alice'), false);
  assert.equal(valueGrader.onCall('Dana, backed up by Marta'), false);
  assert.equal(valueGrader.backup('every 6 hours and every 30 minutes'), false);
  assert.equal(valueGrader.backup('every 6 hours, full copy every 2 days'), false);
  assert.equal(valueGrader.questionForTomas('Alice signs the vendor contract'), false);
  assert.equal(valueGrader.questionForTomas('No vendor contract signature question remains open'), false);
  assert.equal(valueGrader.questionForTomas('Who signs the vendor contract? It was answered: Tomas does'), false);
  // Right answers still pass.
  assert.equal(valueGrader.reviewer('Priya reviews it, since Jonas is away launch week'), true);
  assert.equal(valueGrader.onCall('Dana (Ravi is on leave)'), true);
  assert.equal(valueGrader.backup('every six hours (was daily)'), true);
  assert.equal(valueGrader.questionForTomas('Who signs the vendor contract? Not answered yet.'), true);
  assert.equal(valueGrader.questionForTomas('Tomas, who will sign the vendor contract?'), true);
});

test('a CLI that cannot start is a failed run, not a crash', async () => {
  const { ask } = await import('../evals/handoff/agents.mjs');
  const result = await ask({
    agent: 'codex', cli: { command: 'no-such-handoff-cli-g10', prefix: [], shell: false }, model: 'm', prompt: 'x',
    tools: ['session_read'], work: tmpdir(), mcpPath: 'src/mcp.mjs', port: 1, timeoutMs: 5000,
  });
  assert.deepEqual([result.ok, result.timedOut, result.reply, result.costUsd], [false, false, '', null]);
  assert.match(result.error, /^could not start: ENOENT$/u);
});

test('both graders read the answer object out of prose and score a whole reply', () => {
  const right = Object.fromEntries(facts.map(fact => [fact.key, fact.current]));
  const reply = `Here it is {as asked}:\n${JSON.stringify(right, null, 2)}\nDone {ok}.`;
  assert.deepEqual([gradeReply(reply, keywordGrader).score, gradeReply(reply, valueGrader).score], [14, 14]);
  const stale = { ...right, port: '5210 or 5100', database: 'SQLite for now, Postgres later', flag: null };
  const a = gradeReply(JSON.stringify(stale), keywordGrader);
  const b = gradeReply(JSON.stringify(stale), valueGrader);
  assert.deepEqual([a.score, b.score], [13, 11]);
  assert.equal(gradeReply('I could not find it.', valueGrader).score, 0);
  assert.equal(gradeReply('{"port": 5210', valueGrader).score, 0);
  assert.equal(JSON.stringify(b).includes('5100'), false, 'a grade holds no answer text');
});

test('the CLI parsers count tokens, cost and every tool call', () => {
  const claude = parseClaudeStream([
    JSON.stringify({ type: 'system', subtype: 'init' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__context-ledger__session_read' }] } }),
    'not json',
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__context-ledger__session_read' }, { type: 'text', text: 'x' }] } }),
    JSON.stringify({ type: 'result', is_error: false, result: '{}', total_cost_usd: 0.5, usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 7 } }),
  ].join('\n'));
  assert.deepEqual(claude.toolCalls, { 'mcp__context-ledger__session_read': 2 });
  assert.deepEqual(claude.tokens, { input: 115, cached: 100, output: 7 });
  assert.equal(claude.costUsd, 0.5);
  assert.equal(claude.isError, false);
  assert.equal(parseClaudeStream('').isError, true, 'no result event is an error');

  const codex = parseCodexEvents([
    JSON.stringify({ type: 'item.started', item: { type: 'mcp_tool_call', server: 'context-ledger', tool: 'context_for' } }),
    JSON.stringify({ type: 'item.started', item: { type: 'command_execution' } }),
    JSON.stringify({ type: 'item.started', item: { type: 'reasoning' } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 50, cached_input_tokens: 20, output_tokens: 3 } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 5, cached_input_tokens: 0, output_tokens: 1 } }),
  ].join('\n'));
  assert.deepEqual(codex.toolCalls, { 'mcp__context-ledger__context_for': 1, command_execution: 1 });
  assert.deepEqual(codex.tokens, { input: 55, cached: 20, output: 4 });
  assert.equal(codex.costUsd, null);
});

test('dry run prints the plan with alternating arm order and starts nothing', async () => {
  assert.deepEqual([armOrder(0), armOrder(1), armOrder(2)], [['transcript', 'graph'], ['graph', 'transcript'], ['transcript', 'graph']]);
  const { stdout } = await run(process.execPath, [...runner, '--agent', 'codex', '--model', 'm', '--runs', '3', '--dry-run']);
  const plan = JSON.parse(stdout);
  assert.deepEqual(plan.runs.map(entry => entry.order[0]), ['transcript', 'graph', 'transcript']);
  assert.deepEqual(plan.tools, ['mcp__context-ledger__session_read', 'mcp__context-ledger__context_for']);
  assert.equal(plan.facts, facts.length);
  assert.equal(plan.timeoutS, 300);
  await assert.rejects(run(process.execPath, [...runner, '--agent', 'claude']), /--model is required/u);
});

const forbidden = ['5210', '5100', 'Priya', 'Jonas', 'Postgres', 'SQLite', 'beta_checkout', 'Heron', 'eu-central-1', 'vendor', 'Dana', 'every 6 hours', 'once a day'];

test('fake-CLI runs append one aggregate-only spend line per run, and the summary prints only aggregates', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-handoff-spend-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const log = join(directory, 'spend.jsonl');
  await run(process.execPath, [...runner, '--agent', 'codex', '--fake-cli', fake, '--runs', '2', '--spend-log', log]);
  await run(process.execPath, [...runner, '--agent', 'claude', '--fake-cli', fake, '--runs', '1', '--spend-log', log]);
  const text = await readFile(log, 'utf8');
  const rows = text.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rows.length, 6);
  assert.deepEqual(rows.map(row => `${row.agent} ${row.index} ${row.arm}`), [
    'codex 1 transcript', 'codex 1 graph', 'codex 2 graph', 'codex 2 transcript', 'claude 1 transcript', 'claude 1 graph',
  ]);
  const fields = ['v', 'date', 'runId', 'index', 'position', 'arm', 'agent', 'model', 'timeoutS', 'ok', 'timedOut', 'offToolCalls',
    'crossToolCalls', 'valid', 'tokens', 'costUsd', 'ms', 'score', 'facts', 'graderDisagreements'];
  for (const row of rows) {
    assert.deepEqual(Object.keys(row), fields);
    assert.ok(!Number.isNaN(Date.parse(row.date)));
    assert.equal(row.valid, true);
    assert.equal(row.score.total, 14);
    assert.ok(row.ms > 0);
  }
  assert.deepEqual(rows.map(row => row.score.b), [7, 14, 14, 7, 7, 14]);
  assert.deepEqual(rows.filter(row => row.agent === 'claude').map(row => row.tokens), [
    { input: 32120, cached: 30000, output: 310 }, { input: 4620, cached: 4000, output: 310 },
  ]);
  assert.deepEqual(rows.map(row => row.costUsd), [null, null, null, null, 0.0421, 0.0113]);
  for (const word of forbidden) assert.ok(!text.includes(word), `the spend log holds no answer text (${word})`);

  const { stdout } = await run(process.execPath, [...runner, '--summary', '--spend-log', log]);
  for (const word of forbidden) assert.ok(!stdout.includes(word), `the summary holds no answer text (${word})`);
  assert.match(stdout, /codex fake transcript: 2\/2 valid/u);
  assert.match(stdout, /claude fake graph: 1\/1 valid .*\n {2}score 14\/14 by grader B/u);
  const { stdout: json } = await run(process.execPath, [...runner, '--summary', '--json', '--spend-log', log]);
  const summary = JSON.parse(json);
  assert.deepEqual(summary, summarize(rows));
  assert.equal(summary.find(group => group.agent === 'codex' && group.arm === 'transcript').factPassRate.port, 0);

  const { stdout: empty } = await run(process.execPath, [...runner, '--summary', '--spend-log', join(directory, 'none.jsonl')]);
  assert.equal(empty.trim(), 'No benchmark runs logged yet.');
});

test('failed, timed-out and cross-arm runs are logged, counted and scored 0', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-handoff-modes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const log = join(directory, 'spend.jsonl');
  const fakeRun = (mode, extra = []) => run(process.execPath, [...runner, '--agent', 'claude', '--fake-cli', fake, '--spend-log', log, ...extra],
    { env: { ...process.env, FAKE_HANDOFF_MODE: mode } });
  await fakeRun('cross');
  await fakeRun('fail');
  await fakeRun('hang', ['--timeout-s', '1']);
  const rows = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(rows.map(row => [row.ok, row.timedOut, row.crossToolCalls, row.valid]), [
    [true, false, 1, false], [true, false, 1, false],
    [false, false, 0, false], [false, false, 0, false],
    [false, true, 0, false], [false, true, 0, false],
  ]);
  const [transcriptGroup] = summarize(rows).filter(group => group.arm === 'transcript');
  assert.deepEqual([transcriptGroup.runs, transcriptGroup.valid, transcriptGroup.failed, transcriptGroup.timedOut, transcriptGroup.invalid],
    [3, 0, 2, 1, 1]);
  assert.equal(transcriptGroup.meanScore, 0, 'a run that is not valid scores 0');
  assert.equal(transcriptGroup.meanMs, null, 'times are averaged over valid runs only');
  // The cross-arm run was paid for, so the spend total counts it; the per-valid-run mean has nothing to average.
  assert.deepEqual(transcriptGroup.costUsd, { total: 0.0421, reported: 1, meanValid: null, reportedValid: 0 });
});

test('the default spend log is under a folder Git ignores', async () => {
  const { defaultSpendLog } = await import('../evals/handoff/spend.mjs');
  const { stdout } = await run('git', ['check-ignore', defaultSpendLog]).catch(error => error);
  assert.ok(stdout.trim().length > 0, `${defaultSpendLog} must be ignored by Git`);
});
