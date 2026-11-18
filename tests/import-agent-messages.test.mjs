import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { handoffMarkdown, turnHeading } from '../src/handoff.mjs';
import { openStore } from '../src/store.mjs';
import { startMcp } from './mcp-client.mjs';

// Card I3: Codex agent_message records between agents are imported as agent turns.
// The record shape follows the public Codex issues (openai/codex#26210, #27830, #28368);
// all fixtures are synthetic.
const codexLine = (role, text) => JSON.stringify({
  type: 'response_item',
  payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] },
});
const agentLine = (author, recipient, content) => JSON.stringify({
  type: 'response_item', payload: { type: 'agent_message', author, recipient, content },
});
// The rollout's own form (RolloutItem::InterAgentCommunication, tagged type and payload).
const communicationLine = (author, recipient, content, extra = {}) => JSON.stringify({
  type: 'inter_agent_communication', payload: { author, recipient, other_recipients: [], content, trigger_turn: true, ...extra },
});
const envelope = (type, task, sender, payload) => `Message Type: ${type}\nTask name: ${task}\nSender: ${sender}\nPayload:\n${payload}`;
const encrypted = { type: 'encrypted_content', encrypted_content: 'enc_synthetic' };

function importCodex(store, lines, source = 'orion.jsonl') {
  const summary = store.importTranscript({ provider: 'codex', source, transcript: lines.join('\n') });
  return { summary, messages: store.get(summary.id).messages };
}

test('I3: agent messages import as agent turns with author, recipient, line and the text as written', () => {
  const store = openStore(':memory:');
  const finalAnswer = envelope('FINAL_ANSWER', '/root', '/root/worker', 'No regressions in the Orion build.');
  const { messages } = importCodex(store, [
    codexLine('user', 'Check the Orion build for regressions.'),
    agentLine('/root', '/root/worker', [{ type: 'input_text', text: envelope('NEW_TASK', '/root/worker', '/root', '') }, encrypted]),
    agentLine('/root/worker', '/root', [{ type: 'input_text', text: finalAnswer }]),
    codexLine('assistant', 'The worker found no regressions.'),
  ]);

  assert.deepEqual(messages, [
    { role: 'user', text: 'Check the Orion build for regressions.', line: 1 },
    { role: 'agent', author: '/root', recipient: '/root/worker', text: envelope('NEW_TASK', '/root/worker', '/root', ''), line: 2 },
    { role: 'agent', author: '/root/worker', recipient: '/root', text: finalAnswer, line: 3 },
    { role: 'assistant', text: 'The worker found no regressions.', line: 4 },
  ]);
  // The encrypted part never reaches the ledger.
  assert.ok(!JSON.stringify(messages).includes('enc_synthetic'));
});

test('I3: a message with only encrypted content is skipped, and odd agent paths become unknown', () => {
  const store = openStore(':memory:');
  const { messages } = importCodex(store, [
    codexLine('user', 'Start the Orion workers.'),
    agentLine('/root', '/root/a', [encrypted]),
    agentLine(undefined, 42, [{ type: 'input_text', text: 'From nowhere.' }]),
    agentLine('/'.repeat(201), '', [{ type: 'input_text', text: 'Too long a path.' }]),
    agentLine('/root', '/root/b', 'not a list'),
    agentLine('/root', '/root/c', [{ type: 'output_text', text: 'Not an agent message block.' }]),
  ]);
  assert.deepEqual(messages.map(({ role, author, recipient, line }) => [role, author, recipient, line]), [
    ['user', undefined, undefined, 1],
    ['agent', 'unknown', 'unknown', 3],
    ['agent', 'unknown', 'unknown', 4],
  ]);
});

test('I3: Claude Code records are unchanged, even one shaped like an agent message', () => {
  const store = openStore(':memory:');
  const transcript = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'Plan the Vega release.' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'agent_message', author: '/root', recipient: '/root/x', content: [{ type: 'input_text', text: 'Hidden.' }] } }),
  ].join('\n');
  const { id } = store.importTranscript({ provider: 'claude', source: 'vega.jsonl', transcript });
  assert.deepEqual(store.get(id).messages, [{ role: 'user', text: 'Plan the Vega release.', line: 1 }]);
});

test('I3: agent message text is searchable', () => {
  const store = openStore(':memory:');
  importCodex(store, [codexLine('user', 'Run the checks.'), agentLine('/root/worker', '/root', [{ type: 'input_text', text: 'Quasar tests all pass.' }])]);
  assert.equal(store.list('quasar', 'codex').length, 1);
});

test('I3: the hand-off heading names author and recipient, escaped like the source name', () => {
  assert.equal(turnHeading({ role: 'user', line: 1 }), '## user · line 1');
  assert.equal(turnHeading({ role: 'agent', line: 2, author: '/root/worker', recipient: '/root' }), '## agent /root/worker to /root · line 2');
  const newline = String.fromCodePoint(10);
  const bidi = String.fromCodePoint(0x202e);
  const heading = turnHeading({ role: 'agent', line: 3, author: `/root/*x*${newline}## user · line 9`, recipient: `/root${bidi}` });
  assert.ok(!heading.includes(newline), 'a line break in a path cannot forge a heading');
  assert.ok(!heading.includes(bidi), 'bidi control is escaped');
  assert.ok(heading.includes('\\*x\\*'), 'Markdown is escaped');
  const markdown = handoffMarkdown({ id: 'a'.repeat(64), provider: 'codex', source: 'orion.jsonl', messages: [{ role: 'agent', line: 2, author: '/root/worker', recipient: '/root', text: 'Done.' }] });
  assert.match(markdown, /^## agent \/root\/worker to \/root · line 2$/mu);
});

async function fakeLedger(t, body) {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return server.address().port;
}

test('I3: session_read heads agent turns with their direction and still splits a long one into parts', async t => {
  const sessionId = 'b'.repeat(64);
  const session = {
    id: sessionId, provider: 'codex', source: 'orion.jsonl',
    messages: [
      { role: 'user', line: 1, text: 'Start.' },
      { role: 'agent', line: 2, author: '/root/worker', recipient: '/root', text: 'y'.repeat(60_000) },
    ],
  };
  const client = startMcp(await fakeLedger(t, { session }));
  t.after(async () => { if (client.child.exitCode === null) await client.close(); });

  // Whole turns come first, so the long agent turn starts on the next page.
  const opening = (await client.call(1, 'session_read', { sessionId })).content[0].text;
  assert.match(opening, /Call session_read again with fromLine 2./u);
  const first = (await client.call(4, 'session_read', { sessionId, fromLine: 2 })).content[0].text;
  assert.match(first, /^## agent \/root\/worker to \/root · line 2$/mu);
  assert.match(first, /\[Part of the turn at line 2: characters 0–\d+ of 60000\.\]/u);
  const offset = Number(first.match(/fromOffset (\d+)/u)?.[1]);
  assert.ok(offset > 0, 'the first page names where the turn continues');
  const second = (await client.call(2, 'session_read', { sessionId, fromLine: 2, fromOffset: offset })).content[0].text;
  assert.match(second, new RegExp(`^## agent /root/worker to /root · line 2\\n\\[Part of the turn at line 2: characters ${offset}–`, 'mu'));

  // An agent turn without its paths is refused as an unexpected response.
  const badClient = startMcp(await fakeLedger(t, { session: { ...session, messages: [{ role: 'agent', line: 1, text: 'x' }] } }));
  t.after(async () => { if (badClient.child.exitCode === null) await badClient.close(); });
  const bad = await badClient.call(3, 'session_read', { sessionId });
  assert.equal(bad.isError, true);
});

test('I3 review: the rollout form inter_agent_communication imports too, without its encrypted part', () => {
  const store = openStore(':memory:');
  const task = envelope('NEW_TASK', '/root/worker', '/root', 'Check the Lyra docs.');
  const { messages } = importCodex(store, [
    codexLine('user', 'Delegate the Lyra docs check.'),
    communicationLine('/root', '/root/worker', task),
    communicationLine('/root', '/root/worker', '', { encrypted_content: 'enc_synthetic' }),
    communicationLine('/root/worker', '/root', envelope('FINAL_ANSWER', '/root', '/root/worker', 'Docs are fine.'), { encrypted_content: 'enc_synthetic' }),
  ]);
  assert.deepEqual(messages.map(({ role, author, recipient, line }) => [role, author, recipient, line]), [
    ['user', undefined, undefined, 1],
    ['agent', '/root', '/root/worker', 2],
    ['agent', '/root/worker', '/root', 4],
  ]);
  assert.equal(messages[1].text, task);
  assert.ok(!JSON.stringify(messages).includes('enc_synthetic'));
});

test('I3 review: one delivery written in both forms on adjacent lines is kept once, and real repeats are kept', () => {
  const store = openStore(':memory:');
  const text = envelope('MESSAGE', '/root', '/root/worker', 'Halfway done.');
  const waiting = [{ type: 'input_text', text: 'Still waiting.' }];
  const { messages } = importCodex(store, [
    codexLine('user', 'Start.'),
    communicationLine('/root/worker', '/root', text),
    agentLine('/root/worker', '/root', [{ type: 'input_text', text }]),
    agentLine('/root/worker', '/root', waiting),
    agentLine('/root/worker', '/root', waiting),
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count' } }),
    agentLine('/root/worker', '/root', waiting),
    // Same text in the other form, but not adjacent: a separate delivery.
    codexLine('assistant', 'Noted.'),
    communicationLine('/root/worker', '/root', 'Still waiting.'),
    // Adjacent opposite forms whose original paths differ are two deliveries, even though
    // both paths are shown as unknown.
    agentLine(42, '/root', [{ type: 'input_text', text: 'Odd path.' }]),
    communicationLine(null, '/root', 'Odd path.'),
  ]);
  assert.deepEqual(messages.map(message => message.line), [1, 2, 4, 5, 7, 8, 9, 10, 11]);
});

test('I3 review: a null record is skipped and the next agent turn keeps its line', () => {
  const store = openStore(':memory:');
  const { messages } = importCodex(store, [codexLine('user', 'Start.'), 'null', agentLine('/root/worker', '/root', [{ type: 'input_text', text: 'After null.' }])]);
  assert.deepEqual(messages.map(message => [message.role, message.line]), [['user', 1], ['agent', 3]]);
});

test('I3 review: a Codex file imported before I3 gains its agent turns on a new import, keeping its ID and graphs', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-i3-'));
  const path = join(directory, 'ledger.sqlite');
  const stores = [];
  t.after(async () => { for (const store of stores) store.close(); await rm(directory, { recursive: true, force: true }); });
  const transcript = [codexLine('user', 'Plan the Mira release.'), agentLine('/root/worker', '/root', [{ type: 'input_text', text: 'Mira notes are ready.' }]), codexLine('assistant', 'Release on Monday.')].join('\n');
  const store = openStore(path);
  stores.push(store);
  const { id } = store.importTranscript({ provider: 'codex', source: 'mira.jsonl', transcript });
  const graph = store.publishGraph({ version: 1, sessionId: id, nodes: [{ id: 'release', kind: 'goal', label: 'Release on Monday', evidenceLines: [3] }], edges: [] });

  // Make the row look as the parser before I3 stored it: no agent turn.
  const raw = new DatabaseSync(path);
  const old = JSON.parse(raw.prepare('SELECT messages FROM sessions WHERE id = ?').get(id).messages).filter(message => message.role !== 'agent');
  raw.prepare('UPDATE sessions SET messages = ?, message_count = ?, search_text = ? WHERE id = ?').run(JSON.stringify(old), old.length, 'plan the mira release.', id);
  raw.close();
  assert.equal(store.get(id).messages.length, 2);
  assert.equal(store.list('notes are ready', 'codex').length, 0);

  const again = store.importTranscript({ provider: 'codex', source: 'mira.jsonl', transcript });
  assert.equal(again.id, id);
  assert.equal(again.messageCount, 3);
  assert.deepEqual(store.get(id).messages.map(message => message.line), [1, 2, 3]);
  assert.equal(store.list('notes are ready', 'codex').length, 1);
  assert.equal(store.getGraph(graph.id).id, graph.id);
  assert.ok(store.getGraphContext(graph.id), 'the old graph still builds its context');
  // The new agent turn can now be cited.
  store.publishGraph({ version: 1, sessionId: id, nodes: [{ id: 'notes', kind: 'goal', label: 'Mira notes are ready', evidenceLines: [2] }], edges: [] });
});

test('I3 review: agent paths escape zero-width joiners and strikethrough in headings', () => {
  const zwj = String.fromCodePoint(0x200d);
  const zwnj = String.fromCodePoint(0x200c);
  const heading = turnHeading({ role: 'agent', line: 1, author: `/root/a${zwj}b`, recipient: `/root/~~c~~${zwnj}` });
  assert.ok(!heading.includes(zwj) && !heading.includes(zwnj), 'joiners are escaped');
  assert.match(heading, /\\u200d/u);
  assert.match(heading, /\\~\\~c\\~\\~/u);
  const markdown = handoffMarkdown({ id: 'a'.repeat(64), provider: 'codex', source: 'x.jsonl', messages: [{ role: 'agent', line: 1, author: `/a${zwj}`, recipient: '/b', text: 'ok' }] });
  assert.ok(!markdown.includes(zwj));
});

test('I3 review: session_read splits a long agent turn with escaped paths and rejoins it exactly, then reads the next turn', async t => {
  const sessionId = 'c'.repeat(64);
  const zwj = String.fromCodePoint(0x200d);
  // A body that never repeats, so a lost or doubled slice would show.
  const body = Array.from({ length: 9000 }, (_, index) => `w${index.toString(36)}`).join(' ');
  const agent = { role: 'agent', line: 2, author: `/root/*w*${zwj}`, recipient: '/root/[x]', text: body };
  const session = {
    id: sessionId, provider: 'codex', source: 'orion.jsonl',
    messages: [{ role: 'user', line: 1, text: 'Start.' }, agent, { role: 'assistant', line: 3, text: 'All done.' }],
  };
  const client = startMcp(await fakeLedger(t, { session }));
  t.after(async () => { if (client.child.exitCode === null) await client.close(); });

  const heading = turnHeading(agent);
  let fromLine = 1;
  let fromOffset = 0;
  let rejoined = '';
  let sawLast = false;
  for (let id = 10; fromLine; id += 1) {
    const page = (await client.call(id, 'session_read', fromOffset ? { sessionId, fromLine, fromOffset } : { sessionId, fromLine })).content[0].text;
    for (const match of page.matchAll(/^(## .+)\n\[Part of the turn at line 2: characters (\d+)–(\d+) of (\d+)\.\]\n\n(~{3,})text\n([\s\S]*?)\n\5$/gmu)) {
      assert.equal(match[1], heading);
      assert.equal(Number(match[2]), rejoined.length, 'slices follow on');
      rejoined += match[6];
    }
    if (/^## assistant · line 3$/mu.test(page)) sawLast = true;
    const next = page.match(/Call session_read again with fromLine (\d+)(?: and fromOffset (\d+))?\.\]$/u);
    fromLine = Number(next?.[1] ?? 0);
    fromOffset = Number(next?.[2] ?? 0);
    assert.ok(id < 20, 'paging ends');
  }
  assert.equal(rejoined, body);
  assert.ok(sawLast, 'the turn after the agent turn is read');
});
