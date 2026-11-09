import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync, symlinkSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { verdict } from '../claude/hooks/require-ledger-handoff.mjs';
import { readTranscriptFile } from '../src/importer.mjs';
import { ensureLedger } from '../src/launcher.mjs';
import { openStore } from '../src/store.mjs';
import { startMcp } from './mcp-client.mjs';

const run = promisify(execFile);
const sessionId = '0fdcfa98-73da-47b1-8894-d29975aaf76d';
const line = (type, content, extra = {}) => JSON.stringify({ type, message: { role: type, content }, ...extra });
// A Claude Code transcript with the bookkeeping records real sessions carry around the turns.
const transcript = [
  JSON.stringify({ type: 'queue-operation', operation: 'enqueue' }),
  line('user', 'Build the bakery site. Use the accent colour #1E6FD9 for links.'),
  line('assistant', [{ type: 'text', text: 'Noted the accent colour.' }]),
  line('user', 'Change of plan: the accent colour is now “green #2F7D4F” — not blue.'),
  line('user', '<task-notification>\n<task-id>abc</task-id>\nA subagent finished.\n</task-notification>'),
  line('user', 'Internal caveat', { isMeta: true }),
  line('assistant', [{ type: 'text', text: 'Switched to green.' }, { type: 'tool_use', id: 't1', name: 'Agent', input: {} }]),
].join('\n');

async function projects(t) {
  const root = await mkdtemp(join(tmpdir(), 'ledger-projects-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '-Users-me-site'));
  const path = join(root, '-Users-me-site', `${sessionId}.jsonl`);
  await writeFile(path, transcript);
  return { root, path };
}

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('a transcript is read only from inside the projects folder, as a regular .jsonl file', async t => {
  const { root, path } = await projects(t);
  const read = await readTranscriptFile(path, { root });
  assert.equal(read.name, `${sessionId}.jsonl`);
  assert.equal(read.text, transcript);

  const outside = await mkdtemp(join(tmpdir(), 'ledger-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'secret.jsonl'), transcript);
  await assert.rejects(readTranscriptFile(join(outside, 'secret.jsonl'), { root }), /Claude Code projects folder/);
  symlinkSync(join(outside, 'secret.jsonl'), join(root, '-Users-me-site', 'link.jsonl'));
  await assert.rejects(readTranscriptFile(join(root, '-Users-me-site', 'link.jsonl'), { root }), /Claude Code projects folder/);
  await assert.rejects(readTranscriptFile(join(root, '-Users-me-site', '..', '-Users-me-site', 'x.txt'), { root }), /\.jsonl/);
  await assert.rejects(readTranscriptFile('relative.jsonl', { root }), /absolute path/);
  await assert.rejects(readTranscriptFile(path, { root, maxBytes: 100 }), /exceeds/);
});

test('Claude Code notices and meta records are not imported as the user\'s words', () => {
  const store = openStore(':memory:');
  const { id } = store.importTranscript({ provider: 'claude', source: 's.jsonl', transcript });
  const turns = store.get(id).messages.map(message => [message.line, message.role]);
  assert.deepEqual(turns, [[2, 'user'], [3, 'assistant'], [4, 'user'], [7, 'assistant']]);
});

test('quote evidence resolves to the latest turn that contains it and is stored as line numbers', () => {
  const store = openStore(':memory:');
  const { id } = store.importTranscript({ provider: 'claude', source: 's.jsonl', transcript });
  const packet = quotes => ({
    version: 2, sessionId: id, party: 'lead', edges: [],
    nodes: [{ id: 'accent', kind: 'decision', label: 'Accent colour is green #2F7D4F', ...quotes }],
  });
  // Typographic quotes and dashes in the transcript, plain ones and other case in the quote.
  const quoted = store.publishGraph(packet({ evidenceQuotes: ['THE ACCENT COLOUR is now "green #2F7D4F" - not blue'] }));
  assert.deepEqual(quoted.packet.nodes[0].evidenceLines, [4]);
  assert.equal(Object.hasOwn(quoted.packet.nodes[0], 'evidenceQuotes'), false);
  const byLine = store.publishGraph(packet({ evidenceLines: [4] }));
  assert.equal(quoted.id, byLine.id, 'a quote and the line it resolves to give the same graph');
  // A phrase said twice cites the latest turn.
  assert.deepEqual(store.publishGraph(packet({ evidenceQuotes: ['the accent colour'] })).packet.nodes[0].evidenceLines, [4]);

  const secret = 'never said anywhere in this session';
  assert.throws(() => store.publishGraph(packet({ evidenceQuotes: ['the accent colour', secret] })), error => {
    assert.match(error.message, /^Node 1, quote 2: not found/);
    assert.equal(error.message.includes(secret), false, 'the quote is not echoed');
    return true;
  });
  assert.throws(() => store.publishGraph(packet({ evidenceQuotes: ['short'] })), /quote 1: a quote is 8 to 400 characters/);
  assert.throws(() => store.publishGraph(packet({})), /Invalid version 2 graph packet/);
});

test('the delegation hook lets graph handoffs and opt-outs through and refuses retold context', () => {
  const agent = prompt => ({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { prompt } });
  assert.equal(verdict(agent(`Build menu.html. Context Ledger graph ${'a'.repeat(64)}: call context_for first.`)).allow, true);
  assert.equal(verdict(agent('[no-ledger] Build menu.html with green #2F7D4F.')).allow, true);
  assert.equal(verdict({ ...agent('Build it'), tool_name: 'Task' }).allow, false);
  const refused = verdict(agent('Build menu.html. The accent colour is green #2F7D4F.'));
  assert.equal(refused.allow, false);
  assert.match(refused.reason, /handoff_publish/);
  assert.match(refused.reason, /\[no-ledger\]/);
  assert.equal(verdict({ tool_name: 'Write', tool_input: { content: 'x' } }).allow, true);
  assert.equal(verdict(null).allow, true);
  assert.equal(verdict({ tool_name: 'Agent', tool_input: {} }).allow, true);
});

test('the hook script exits 2 with a reason only for a retold delegation, and 0 for unreadable input', async () => {
  const script = 'claude/hooks/require-ledger-handoff.mjs';
  const call = input => new Promise(resolve => {
    const child = execFile(process.execPath, [script], (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stderr }));
    child.stdin.end(input);
  });
  const refused = await call(JSON.stringify({ tool_name: 'Agent', tool_input: { prompt: 'Use green.' } }));
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /handoff_publish/);
  assert.equal((await call(JSON.stringify({ tool_name: 'Agent', tool_input: { prompt: '[no-ledger] Use green.' } }))).code, 0);
  assert.equal((await call('not json')).code, 0);
});

test('the installer adds the hook once, keeps other settings and removes only its own hook', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ledger-settings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const settingsPath = join(dir, 'settings.json');
  const other = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo other' }] };
  await writeFile(settingsPath, JSON.stringify({ model: 'opus', hooks: { PreToolUse: [other] } }));
  const env = { ...process.env, CLAUDE_SETTINGS_PATH: settingsPath };
  await run(process.execPath, ['claude/install.mjs'], { env });
  await run(process.execPath, ['claude/install.mjs'], { env });
  let settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.equal(settings.model, 'opus');
  assert.equal(settings.hooks.PreToolUse.length, 2, 'installing twice adds one hook');
  assert.equal(settings.hooks.PreToolUse[1].matcher, 'Agent|Task');
  assert.match(settings.hooks.PreToolUse[1].hooks[0].command, /require-ledger-handoff\.mjs/);
  await run(process.execPath, ['claude/install.mjs', '--remove'], { env });
  settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.deepEqual(settings.hooks.PreToolUse, [other]);
});

test('handoff_publish imports the current Claude Code session and publishes a graph subagents can read', async t => {
  const { root } = await projects(t);
  const data = await mkdtemp(join(tmpdir(), 'ledger-handoff-'));
  const port = await freePort();
  const env = { ...process.env, CONTEXT_LEDGER_TRANSCRIPT_ROOT: root };
  await ensureLedger({ port, database: join(data, 'ledger.sqlite'), env });
  const pid = Number(readFileSync(join(data, 'ledger.pid'), 'utf8'));
  t.after(async () => {
    try { process.kill(pid, 'SIGTERM'); } catch {}
    await rm(data, { recursive: true, force: true });
  });

  const client = startMcp(port, { CLAUDE_CODE_SESSION_ID: sessionId, CONTEXT_LEDGER_TRANSCRIPT_ROOT: root });
  t.after(async () => { if (client.child.exitCode === null) await client.close(); });
  const init = await client.request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.match(init.result.instructions, /before you delegate work to a subagent/);
  assert.match(init.result.instructions, /\[no-ledger\]/);

  const published = await client.call(2, 'handoff_publish', {
    nodes: [
      { id: 'site', kind: 'goal', label: 'Build the bakery site', evidenceQuotes: ['Build the bakery site'] },
      { id: 'green', kind: 'decision', label: 'Accent colour green #2F7D4F', evidenceQuotes: ['accent colour is now "green #2F7D4F"'] },
      { id: 'blue', kind: 'decision', label: 'Accent colour #1E6FD9', evidenceQuotes: ['accent colour #1E6FD9'] },
    ],
    edges: [{ from: 'green', to: 'blue', type: 'supersedes' }],
  });
  assert.notEqual(published.isError, true, published.content?.[0]?.text);
  const graphId = published.content[0].text.match(/[a-f0-9]{64}/u)[0];
  assert.match(published.content[1].text, new RegExp(`Context Ledger graph ${graphId}: before anything else, call the context_for tool`));

  const briefing = await client.call(3, 'context_for', { graphId });
  assert.notEqual(briefing.isError, true);
  assert.match(briefing.content[0].text, /green: Accent colour green #2F7D4F \(L4\)/);
  assert.match(briefing.content[0].text, /current decisions: green/);

  const outside = startMcp(port, { CLAUDE_CODE_SESSION_ID: '' });
  t.after(async () => { if (outside.child.exitCode === null) await outside.close(); });
  const refused = await outside.call(4, 'handoff_publish', { nodes: [{ id: 'x', kind: 'goal', label: 'x', evidenceQuotes: ['xxxxxxxx'] }] });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /works inside Claude Code/);
});

test('file import is same-origin only and refuses paths outside the projects folder', async t => {
  const { root, path } = await projects(t);
  const data = await mkdtemp(join(tmpdir(), 'ledger-import-'));
  const port = await freePort();
  await ensureLedger({ port, database: join(data, 'ledger.sqlite'), env: { ...process.env, CONTEXT_LEDGER_TRANSCRIPT_ROOT: root } });
  const pid = Number(readFileSync(join(data, 'ledger.pid'), 'utf8'));
  t.after(async () => {
    try { process.kill(pid, 'SIGTERM'); } catch {}
    await rm(data, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${port}`;
  const post = (body, headers = { Origin: origin }) => fetch(`${origin}/api/import-file`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  const ok = await post({ provider: 'claude', path });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).session.messageCount, 4);
  assert.equal((await post({ provider: 'claude', path }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post({ provider: 'claude', path: '/etc/hosts.jsonl' })).status, 400);
  assert.equal((await post({ provider: 'codex', path })).status, 400);
});
