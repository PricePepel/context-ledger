import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildRecording, recordingText } from '../demo/console-recording.mjs';
import { createModel, evidenceTurns, nodeMark, partyKey, visibleText } from '../public/console/model.mjs';
import { visibleText as serverVisibleText } from '../src/text.mjs';
import { bearer, ledgerToken } from './ledger-auth.mjs';

// Card U1: the console's demo recording, its state model and how the server serves it.
// Synthetic data only: the recording is built from the committed Orbit demo transcripts.
const consoleDir = new URL('../public/console/', import.meta.url);
const recording = JSON.parse(await readFile(new URL('demo-recording.json', consoleDir), 'utf8'));

function play(events, { workingMs = 8000 } = {}) {
  const model = createModel({ workingMs });
  const start = Date.now();
  const moves = events.map(event => model.apply({
    summary: event.summary,
    graph: event.graph,
    meter: event.meter,
    provider: recording.sessions[event.graph.packet.sessionId].provider,
    at: start + event.atMs,
  }));
  return { model, moves, start };
}

test('the committed demo recording is what the real store produces from the demo transcripts', async () => {
  const rebuilt = recordingText(await buildRecording());
  // A Windows checkout with core.autocrlf has CR LF line ends; the content is what counts.
  const crlf = String.fromCodePoint(13, 10);
  const committed = (await readFile(new URL('demo-recording.json', consoleDir), 'utf8')).replaceAll(crlf, '\n');
  assert.equal(committed, rebuilt,
    'Run node demo/console-recording.mjs and commit the result.');
  const providers = Object.values(recording.sessions).map(session => session.provider).sort();
  assert.deepEqual(providers, ['claude', 'codex']);
  assert.ok(recording.events.every((event, index) => index === 0 || event.atMs > recording.events[index - 1].atMs));
  assert.ok(recording.events.at(-1).atMs < recording.durationMs);
});

test('a publish moves only what changed: new nodes, changed nodes and linked nodes', () => {
  const { moves } = play(recording.events);
  assert.deepEqual(moves[0].added, ['party:leo/orbit-live', 'party:leo/port-4400']);
  assert.deepEqual(moves[1].added.sort(), ['party:leo/mcp-pairing', 'party:leo/record-video']);
  assert.deepEqual(moves[1].changed, []);
  // Ali's second graph links to two of Leo's nodes: the dashed read lines.
  assert.deepEqual(moves[4].read.sort(), ['party:leo/mcp-pairing', 'party:leo/orbit-live']);
  // Leo's last graph moves the recording to Saturday and adds the question for Ali.
  assert.deepEqual(moves[5].changed, ['party:leo/record-video']);
  assert.deepEqual(moves[5].added, ['party:leo/gpu-owner']);
  assert.deepEqual(moves[5].read, ['party:ali/which-port']);
  // Replaying a graph already seen moves nothing.
  const { model } = play(recording.events);
  const again = model.apply({ ...recording.events[5], provider: 'claude', at: Date.now() + 99_000 });
  assert.deepEqual([again.added, again.changed, again.read], [[], [], []]);
});

test('the finished demo numbers match values computed from the recording', () => {
  const { model, start } = play(recording.events);
  const last = new Map();
  for (const event of recording.events) last.set(partyKey(event.graph.packet), event);
  const tokens = [...last.values()].reduce((sum, event) => sum + event.meter.savedTokens, 0);
  let superseded = 0;
  for (const { graph } of last.values()) {
    const replaced = new Set(graph.packet.edges.filter(edge => edge.type === 'supersedes').map(edge => edge.to));
    superseded += graph.packet.nodes.filter(node => node.kind === 'decision' && replaced.has(node.id)).length;
  }
  const numbers = model.numbers(start + recording.durationMs);
  assert.equal(numbers.handoffs, recording.events.length);
  assert.equal(numbers.tokensSaved, tokens);
  assert.equal(numbers.metered, 2);
  assert.equal(numbers.superseded, superseded);
  assert.equal(superseded, 1);
  // A graph from yesterday is not a hand-off today.
  const yesterday = createModel();
  yesterday.apply({ ...recording.events[0], provider: 'claude', at: Date.now() - 2 * 86_400_000 });
  assert.equal(yesterday.numbers(Date.now()).handoffs, 0);
  assert.equal(yesterday.numbers(Date.now()).tokensSaved, 0);
});

test('agents are working right after a publish, waiting on an unanswered question, idle otherwise', () => {
  const { model, start } = play(recording.events.slice(0, 5));
  const at = ms => Object.fromEntries(model.agents(start + ms).map(agent => [agent.label, agent.state]));
  // Ali published at 20 s and has asked Leo which port; Leo has not answered yet.
  assert.deepEqual(at(24_000), { leo: 'idle', ali: 'working' });
  assert.deepEqual(at(30_000), { leo: 'idle', ali: 'waiting' });
  const full = play(recording.events);
  const end = Object.fromEntries(full.model.agents(full.start + recording.durationMs).map(agent => [agent.label, agent.state]));
  // Leo's last graph answers Ali by link and asks Ali who owns the GPU box.
  assert.deepEqual(end, { leo: 'waiting', ali: 'idle' });
  assert.deepEqual(full.model.agents(0).map(agent => agent.provider).sort(), ['claude', 'codex']);
});

test('the graph view marks superseded decisions and answered questions, and reads the G7 mark only if present', () => {
  const { model } = play(recording.events);
  const { columns, edges } = model.graph();
  assert.deepEqual(columns.map(column => column.label), ['leo', 'ali']);
  const nodes = new Map(columns.flatMap(column => column.nodes).map(node => [node.key, node]));
  assert.equal(nodes.get('party:leo/port-4400').superseded, true);
  assert.equal(nodes.get('party:leo/port-4317').superseded, false);
  assert.equal(nodes.get('party:ali/which-port').answered, true);
  assert.equal(nodes.get('party:leo/gpu-owner').answered, false);
  assert.ok([...nodes.values()].every(node => node.mark === null));
  assert.ok(edges.some(edge => edge.link && edge.from === 'party:ali/benchmark' && edge.to === 'party:leo/mcp-pairing'));
  assert.equal(nodeMark({ grounding: 'quoted' }), 'quoted');
  assert.equal(nodeMark({ mark: 'inferred' }), 'inferred');
  assert.equal(nodeMark({ mark: 'constructor' }), null);
});

test('evidence shows each cited turn with the turns around it, in order', () => {
  const messages = [1, 2, 3, 4, 5, 6].map(line => ({ role: line % 2 ? 'user' : 'assistant', text: `t${line}`, line: line * 2 }));
  assert.deepEqual(evidenceTurns(messages, [6]).map(turn => [turn.line, turn.cited]), [[4, false], [6, true], [8, false]]);
  assert.deepEqual(evidenceTurns(messages, [2, 12]).map(turn => turn.line), [2, 4, 10, 12]);
  assert.deepEqual(evidenceTurns(messages, [99]), []);
  const rlo = String.fromCodePoint(0x202e);
  const spoof = [{ role: 'user', text: `pay ${rlo}evil`, line: 1 }];
  assert.equal(evidenceTurns(spoof, [1])[0].text, `pay ${String.fromCodePoint(0x5c)}u202eevil`);
});

test('the console shows hidden characters exactly as the CLI and handoff do', () => {
  const c = String.fromCodePoint;
  const samples = ['plain', `tab${c(9)}and${c(10)}line`, `crlf${c(13, 10)}end`, `bell${c(7)}`, `del${c(0x7f)}`, `c1${c(0x85)}`,
    `rlo${c(0x202e)} x`, `lri${c(0x2066)}`, `zw${c(0x200b)}`, `zwj${c(0x200d)} ok`, `zwnj${c(0x200c)} ok`,
    `ls${c(0x2028)}ps${c(0x2029)}`, `tag${c(0xe0041)}`, `bom${c(0xfeff)}`];
  for (const sample of samples) assert.equal(visibleText(sample), serverVisibleText(sample), JSON.stringify(sample));
});

test('console files stay light and never parse transcript text as HTML', async () => {
  let total = 0;
  for (const name of await readdir(consoleDir)) {
    const text = await readFile(new URL(name, consoleDir), 'utf8');
    total += (await stat(new URL(name, consoleDir))).size;
    // Tab, newline and carriage return are the only control or format characters allowed.
    assert.doesNotMatch(text, /[[\p{Cc}\p{Cf}]--[\t\n\r]]/v, name);
    if (name.endsWith('.mjs')) {
      assert.doesNotMatch(text, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/u, name);
      assert.doesNotMatch(text, /method:\s*['"](?:POST|PUT|PATCH|DELETE)/iu, `${name} must only read`);
      // Browser-only modules are not imported by node tests, so check that each parses.
      const check = spawnSync(process.execPath, ['--check', fileURLToPath(new URL(name, consoleDir))], { encoding: 'utf8' });
      assert.equal(check.status, 0, `${name}: ${check.stderr}`);
    }
  }
  assert.ok(total < 300 * 1024, `console files are ${total} bytes`);
});

function raw(port, { method = 'GET', path, headers = {} }) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, method, path, headers: { Host: `127.0.0.1:${port}`, ...headers }, agent: false }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end();
  });
}

test('the server serves exactly the console files, read-only, with the usual headers', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-console-'));
  const child = spawn(process.execPath, ['src/server.mjs'], {
    env: { ...process.env, PORT: '0', CONTEXT_LEDGER_DB: join(directory, 'ledger.sqlite') },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await once(child, 'exit');
    }
    await rm(directory, { recursive: true, force: true });
  });
  let output = '';
  let port;
  for await (const chunk of child.stdout) {
    output += chunk;
    port = Number(output.match(/listening at http:\/\/127\.0\.0\.1:(\d+)/)?.[1]);
    if (port) break;
  }

  const files = await readdir(consoleDir);
  const types = { '.html': 'text/html', '.css': 'text/css', '.mjs': 'text/javascript', '.json': 'application/json' };
  for (const name of files) {
    const path = name === 'index.html' ? '/console/' : `/console/${name}`;
    const response = await raw(port, { path });
    assert.equal(response.status, 200, path);
    assert.equal(response.headers['content-type'], `${types[name.slice(name.lastIndexOf('.'))]}; charset=utf-8`, path);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.match(response.headers['content-security-policy'], /script-src 'self'/u);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.body, await readFile(new URL(name, consoleDir), 'utf8'), path);
    assert.equal((await raw(port, { method: 'POST', path })).status, 404, `POST ${path}`);
  }
  assert.equal((await raw(port, { path: '/console' })).status, 200);
  // P1e: only the listed files are open; any other path needs the token, and then is 404.
  const auth = bearer(await ledgerToken(join(directory, 'ledger.sqlite'), port));
  for (const path of ['/console/index.html', '/console/nope.mjs', '/console/console.mjs/', '/console/%2e%2e/src/server.mjs', '/public/console/console.mjs']) {
    assert.equal((await raw(port, { path })).status, 401, path);
    assert.equal((await raw(port, { path, headers: auth })).status, 404, path);
  }
});
