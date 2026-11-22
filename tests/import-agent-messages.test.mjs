import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { handoffMarkdown, turnHeading } from '../src/handoff.mjs';
import { redactSession } from '../src/secrets.mjs';
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

// P1c gives every turn a stable key; these tests check the rest of each turn.
const withoutKeys = messages => messages.map(({ key, ...message }) => message);

test('I3: agent messages import as agent turns with author, recipient, line and the text as written', () => {
  const store = openStore(':memory:');
  const finalAnswer = envelope('FINAL_ANSWER', '/root', '/root/worker', 'No regressions in the Orion build.');
  const { messages } = importCodex(store, [
    codexLine('user', 'Check the Orion build for regressions.'),
    agentLine('/root', '/root/worker', [{ type: 'input_text', text: envelope('NEW_TASK', '/root/worker', '/root', '') }, encrypted]),
    agentLine('/root/worker', '/root', [{ type: 'input_text', text: finalAnswer }]),
    codexLine('assistant', 'The worker found no regressions.'),
  ]);

  assert.ok(messages.every(message => /^h:[0-9a-f]{32}$/u.test(message.key)));
  assert.deepEqual(withoutKeys(messages), [
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
  assert.deepEqual(withoutKeys(store.get(id).messages), [{ role: 'user', text: 'Plan the Vega release.', line: 1 }]);
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

  const keys = store.get(id).messages.map(message => message.key);

  // Make the rows look as the parser before I3 stored them: no agent turn.
  const raw = new DatabaseSync(path);
  raw.exec('BEGIN');
  raw.prepare("DELETE FROM messages WHERE session_id = ? AND role = 'agent'").run(id);
  raw.prepare("UPDATE messages SET seq = 1 WHERE session_id = ? AND line = 3").run(id);
  raw.prepare('UPDATE sessions SET message_count = 2, search_text = ? WHERE id = ?').run('plan the mira release.', id);
  raw.exec('COMMIT');
  raw.close();
  assert.equal(store.get(id).messages.length, 2);
  assert.equal(store.list('notes are ready', 'codex').length, 0);

  const again = store.importTranscript({ provider: 'codex', source: 'mira.jsonl', transcript });
  assert.equal(again.id, id);
  assert.equal(again.messageCount, 3);
  assert.deepEqual(store.get(id).messages.map(message => message.line), [1, 2, 3]);
  assert.deepEqual(store.get(id).messages.map(message => message.key), keys, 'every turn keeps its key');
  // A third import changes nothing.
  assert.equal(store.importTranscript({ provider: 'codex', source: 'mira.jsonl', transcript }).messageCount, 3);
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

test('I3: schema version 6 keeps every version 5 row, and stores agent paths in their own columns', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-i3-v6-'));
  const path = join(directory, 'ledger.sqlite');
  const stores = [];
  t.after(async () => { for (const store of stores) store.close(); await rm(directory, { recursive: true, force: true }); });
  const first = openStore(path);
  stores.push(first);
  const { id } = first.importTranscript({ provider: 'codex', source: 'lyra.jsonl', transcript: [codexLine('user', 'Plan the Lyra launch.'), codexLine('assistant', 'Launch on Friday.')].join('\n') });
  const before = first.get(id).messages;
  first.close();
  stores.length = 0;

  // Turn the file back into version 5: the messages table without the I3 columns.
  const raw = new DatabaseSync(path);
  raw.exec(`
    BEGIN;
    DROP TRIGGER sessions_messages;
    CREATE TABLE old_messages (
      id INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
      seq INTEGER NOT NULL, line INTEGER NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      text_json TEXT NOT NULL, key TEXT NOT NULL,
      UNIQUE (session_id, key), UNIQUE (session_id, seq)
    ) STRICT;
    INSERT INTO old_messages SELECT id, session_id, seq, line, role, text_json, key FROM messages;
    DROP TABLE messages;
    ALTER TABLE old_messages RENAME TO messages;
    CREATE TRIGGER sessions_messages AFTER INSERT ON sessions
    WHEN NOT EXISTS (SELECT 1 FROM messages WHERE session_id = NEW.id) BEGIN
      INSERT INTO messages (session_id, seq, line, role, text_json, key)
      SELECT NEW.id, m.key, m.value ->> '$.line', m.value ->> '$.role', m.value -> '$.text', 'l:' || (m.value ->> '$.line')
      FROM json_each(NEW.messages) m ORDER BY m.key;
    END;
    PRAGMA user_version = 5;
    COMMIT;
  `);
  raw.close();

  const store = openStore(path);
  stores.push(store);
  assert.deepEqual(store.get(id).messages, before, 'the version 5 rows are kept as they were');
  const agent = store.importTranscript({ provider: 'codex', source: 'lyra-team.jsonl', transcript: [
    codexLine('user', 'Split the Lyra launch.'),
    agentLine('/root', '/root/worker', [{ type: 'input_text', text: 'Check the Lyra checklist.' }]),
  ].join('\n') });

  const check = new DatabaseSync(path);
  stores.push(check);
  assert.equal(check.prepare('PRAGMA user_version').get().user_version, 6);
  assert.deepEqual(check.prepare('SELECT role, author_json AS author, recipient_json AS recipient FROM messages WHERE session_id = ? ORDER BY seq').all(agent.id)
    .map(row => ({ ...row })), [
    { role: 'user', author: null, recipient: null },
    { role: 'agent', author: '"/root"', recipient: '"/root/worker"' },
  ]);
  // Builds from before versions read sessions.messages, and know only user and assistant turns.
  const legacy = JSON.parse(check.prepare('SELECT messages FROM sessions WHERE id = ?').get(agent.id).messages);
  assert.deepEqual(legacy.map(message => message.role), ['user']);
  // An agent row needs both paths, and only an agent row has them.
  assert.throws(() => check.prepare("INSERT INTO messages (session_id, seq, line, role, text_json, key, author_json) VALUES (?, 9, 9, 'agent', '\"x\"', 'l:9', '\"/root\"')").run(agent.id), /CHECK/u);
  assert.throws(() => check.prepare("INSERT INTO messages (session_id, seq, line, role, text_json, key, author_json, recipient_json) VALUES (?, 9, 9, 'user', '\"x\"', 'l:9', '\"/a\"', '\"/b\"')").run(agent.id), /CHECK/u);
  assert.throws(() => check.prepare("INSERT INTO messages (session_id, seq, line, role, text_json, key, author_json) VALUES (?, 9, 9, 'user', '\"x\"', 'l:9', '\"/a\"')").run(agent.id), /CHECK/u);
  assert.throws(() => check.prepare("INSERT INTO messages (session_id, seq, line, role, text_json, key, recipient_json) VALUES (?, 9, 9, 'assistant', '\"x\"', 'l:9', '\"/b\"')").run(agent.id), /CHECK/u);
  // The trigger for builds from before versions still gives a session they insert its rows.
  check.prepare("INSERT INTO sessions (id, provider, source, title, message_count, messages, search_text) VALUES ('old', 'codex', 'o.jsonl', 't', 1, ?, 't')")
    .run(JSON.stringify([{ role: 'user', text: 'Old build turn.', line: 1 }]));
  assert.equal(check.prepare("SELECT count(*) AS n FROM messages WHERE session_id = 'old'").get().n, 1);
});

test('I3 review 3: two deliveries, each written in both forms, stay two turns', () => {
  const store = openStore(':memory:');
  const text = 'Vela checks are done.';
  const rollout = { type: 'inter_agent_communication', payload: { author: '/root/worker', recipient: '/root', content: text } };
  const { messages } = importCodex(store, [
    codexLine('user', 'Run the Vela checks twice.'),
    agentLine('/root/worker', '/root', [{ type: 'input_text', text }]), JSON.stringify(rollout),
    agentLine('/root/worker', '/root', [{ type: 'input_text', text }]), JSON.stringify(rollout),
  ]);
  assert.deepEqual(messages.map(message => [message.role, message.line]), [['user', 1], ['agent', 2], ['agent', 4]]);
});

test('I3 review 3: a NUL in an agent path is kept, and shown escaped, not cut', async t => {
  const store = openStore(':memory:');
  const nul = String.fromCodePoint(0);
  const { summary, messages } = importCodex(store, [
    codexLine('user', 'Audit Hydra.'),
    agentLine(`/root${nul}/child`, '/root', [{ type: 'input_text', text: 'Hydra is clean.' }]),
  ]);
  assert.equal(messages[1].author, `/root${nul}/child`);
  // The escape's backslash is itself escaped for Markdown, as in the source name.
  assert.match(handoffMarkdown(store.get(summary.id)), /## agent \/root\\\\u0000\/child to \/root · line 2/u);
});

test('I3 review 3: a session migrated with l: keys gains its agent turns and keeps those keys', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-i3-legacy-'));
  const path = join(directory, 'ledger.sqlite');
  const stores = [];
  t.after(async () => { for (const store of stores) store.close(); await rm(directory, { recursive: true, force: true }); });
  const transcript = [codexLine('user', 'Plan the Ara release.'), agentLine('/root/worker', '/root', [{ type: 'input_text', text: 'Ara notes are ready.' }]), codexLine('assistant', 'Ship Ara on Tuesday.')].join('\n');
  const store = openStore(path);
  stores.push(store);
  const { id } = store.importTranscript({ provider: 'codex', source: 'ara.jsonl', transcript });

  // As the version 3 step leaves a session it copied: l:<line> keys, and no agent turn.
  const raw = new DatabaseSync(path);
  raw.exec('BEGIN');
  raw.prepare("DELETE FROM messages WHERE session_id = ? AND role = 'agent'").run(id);
  raw.prepare("UPDATE messages SET seq = 1 WHERE session_id = ? AND line = 3").run(id);
  raw.prepare("UPDATE messages SET key = 'l:' || line WHERE session_id = ?").run(id);
  raw.prepare('UPDATE sessions SET message_count = 2 WHERE id = ?').run(id);
  raw.exec('COMMIT');
  raw.close();

  assert.equal(store.importTranscript({ provider: 'codex', source: 'ara.jsonl', transcript }).messageCount, 3);
  const after = store.get(id).messages;
  assert.deepEqual(after.map(message => [message.line, message.role]), [[1, 'user'], [2, 'agent'], [3, 'assistant']]);
  assert.equal(after[0].key, 'l:1');
  assert.equal(after[2].key, 'l:3');
  assert.match(after[1].key, /^h:[0-9a-f]{32}$/u);
});

test('I3 review 3: a stored session whose turns differ in text is not rewritten', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-i3-differ-'));
  const path = join(directory, 'ledger.sqlite');
  const stores = [];
  t.after(async () => { for (const store of stores) store.close(); await rm(directory, { recursive: true, force: true }); });
  const transcript = [codexLine('user', 'Plan Cetus.'), agentLine('/root/worker', '/root', [{ type: 'input_text', text: 'Cetus is ready.' }])].join('\n');
  const store = openStore(path);
  stores.push(store);
  const { id } = store.importTranscript({ provider: 'codex', source: 'cetus.jsonl', transcript });
  const raw = new DatabaseSync(path);
  raw.exec('BEGIN');
  raw.prepare("DELETE FROM messages WHERE session_id = ? AND role = 'agent'").run(id);
  raw.prepare("UPDATE messages SET text_json = ? WHERE session_id = ?").run(JSON.stringify('Plan something else.'), id);
  raw.exec('COMMIT');
  raw.close();
  store.importTranscript({ provider: 'codex', source: 'cetus.jsonl', transcript });
  assert.deepEqual(store.get(id).messages.map(message => message.text), ['Plan something else.']);
});

test('I3 review 3: a session deleted after the duplicate check is imported again, not left half-written', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-i3-gone-'));
  const path = join(directory, 'ledger.sqlite');
  const stores = [];
  t.after(async () => { for (const store of stores) store.close(); await rm(directory, { recursive: true, force: true }); });
  const transcript = [codexLine('user', 'Plan Lepus.'), agentLine('/root/worker', '/root', [{ type: 'input_text', text: 'Lepus is ready.' }])].join('\n');
  const store = openStore(path);
  const other = openStore(path);
  stores.push(store, other);
  const { id } = store.importTranscript({ provider: 'codex', source: 'lepus.jsonl', transcript });
  // Another process deletes the session while this one is between its check and its lock.
  const realExec = DatabaseSync.prototype.exec;
  let once = true;
  t.after(() => { DatabaseSync.prototype.exec = realExec; });
  DatabaseSync.prototype.exec = function exec(sql) {
    if (once && sql === 'BEGIN IMMEDIATE') {
      once = false;
      DatabaseSync.prototype.exec = realExec;
      other.deleteSession(id);
    }
    return realExec.call(this, sql);
  };
  const again = store.importTranscript({ provider: 'codex', source: 'lepus.jsonl', transcript });
  DatabaseSync.prototype.exec = realExec;
  assert.equal(again.id, id);
  assert.equal(store.get(id).messages.length, 2);
});

test('I3 review 4: a key format in an agent path is redacted in the hand-off', () => {
  const store = openStore(':memory:');
  // A synthetic GitHub token shape, built so no literal key sits in the source.
  const token = 'ghp_' + 'A1b2C3d4E5'.repeat(3) + 'F6g7H8i9J0';
  const { summary } = importCodex(store, [
    codexLine('user', 'Audit Norma.'),
    agentLine(`/root/${token}`, `/root/${token}`, [{ type: 'input_text', text: 'Norma is clean.' }]),
  ]);
  const { session, findings } = redactSession(store.get(summary.id));
  assert.equal(findings.length, 2);
  assert.ok(findings.every(finding => finding.line === 2 && finding.kind === 'github-token'));
  const markdown = handoffMarkdown(session);
  assert.equal(markdown.includes(token), false);
  assert.ok(markdown.includes('## agent /root/\\[REDACTED github-token\\] to /root/\\[REDACTED github-token\\] · line 2'));
});

test('I3 review 4: a session deleted right after the re-import commits still returns its summary', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-i3-after-'));
  const path = join(directory, 'ledger.sqlite');
  const stores = [];
  t.after(async () => { for (const store of stores) store.close(); await rm(directory, { recursive: true, force: true }); });
  const transcript = [codexLine('user', 'Plan Mensa.'), agentLine('/root/worker', '/root', [{ type: 'input_text', text: 'Mensa is ready.' }])].join('\n');
  const store = openStore(path);
  const other = openStore(path);
  stores.push(store, other);
  const { id } = store.importTranscript({ provider: 'codex', source: 'mensa.jsonl', transcript });
  const realExec = DatabaseSync.prototype.exec;
  let armed = false;
  t.after(() => { DatabaseSync.prototype.exec = realExec; });
  DatabaseSync.prototype.exec = function exec(sql) {
    if (sql === 'BEGIN IMMEDIATE') armed = true;
    const result = realExec.call(this, sql);
    if (armed && sql === 'COMMIT') {
      armed = false;
      DatabaseSync.prototype.exec = realExec;
      other.deleteSession(id);
    }
    return result;
  };
  const again = store.importTranscript({ provider: 'codex', source: 'mensa.jsonl', transcript });
  DatabaseSync.prototype.exec = realExec;
  assert.equal(again.id, id);
  assert.equal(again.messageCount, 2);
});

test('I3 review 4: deliveries on either side of an unreadable line are not one pair', () => {
  const store = openStore(':memory:');
  const text = 'Ursa is clean.';
  const { messages } = importCodex(store, [
    codexLine('user', 'Audit Ursa.'),
    agentLine('/root/worker', '/root', [{ type: 'input_text', text }]),
    '{not json',
    JSON.stringify({ type: 'inter_agent_communication', payload: { author: '/root/worker', recipient: '/root', content: text } }),
  ]);
  assert.deepEqual(messages.map(message => [message.role, message.line]), [['user', 1], ['agent', 2], ['agent', 4]]);
});

test('I3 review 5: deliveries on either side of a blank line are not one pair', () => {
  const store = openStore(':memory:');
  const text = 'Lynx is clean.';
  const { messages } = importCodex(store, [
    codexLine('user', 'Audit Lynx.'),
    agentLine('/root/worker', '/root', [{ type: 'input_text', text }]),
    '   ',
    JSON.stringify({ type: 'inter_agent_communication', payload: { author: '/root/worker', recipient: '/root', content: text } }),
  ]);
  assert.deepEqual(messages.map(message => [message.role, message.line]), [['user', 1], ['agent', 2], ['agent', 4]]);
});
