import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { schemaVersion } from '../src/migrate.mjs';
import { openStore } from '../src/store.mjs';
import { startMcp } from './mcp-client.mjs';
import { bearer, ledgerToken } from './ledger-auth.mjs';

// Card P1c: one messages row per turn with stable keys, schema version 3
// (docs/evals.md, "P1c — One row per message, stable keys"). Synthetic data only.

const nul = String.fromCodePoint(0);
const bell = String.fromCodePoint(7);

// The DDL of 19f6522, the last build without schema versions (as in tests/projects.test.mjs).
const versionZeroDdl = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex')),
    source TEXT NOT NULL,
    title TEXT NOT NULL,
    message_count INTEGER NOT NULL,
    messages TEXT NOT NULL,
    search_text TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS graphs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    payload TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    graph_a TEXT NOT NULL REFERENCES graphs(id),
    graph_b TEXT NOT NULL REFERENCES graphs(id),
    CHECK (graph_a < graph_b)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS room_choices (
    room_id TEXT NOT NULL REFERENCES rooms(id),
    proposal_id TEXT NOT NULL,
    party TEXT NOT NULL,
    choice TEXT NOT NULL CHECK (choice IN ('confirm', 'reject')),
    PRIMARY KEY (room_id, proposal_id, party)
  ) STRICT;
`;
// What version 1 (main 3a17536) adds. Triggers come after the rows are copied, so the
// copied created_at and party values stay as they were.
const versionOneColumns = `
  ALTER TABLE graphs ADD COLUMN created_at TEXT;
  ALTER TABLE graphs ADD COLUMN party TEXT;
  ALTER TABLE rooms ADD COLUMN created_at TEXT;
  CREATE INDEX graphs_session_id ON graphs(session_id);
  CREATE INDEX graphs_party ON graphs(party);
  CREATE INDEX rooms_graph_a ON rooms(graph_a);
  CREATE INDEX rooms_graph_b ON rooms(graph_b);
`;
const party = payload => `CASE WHEN json_valid(${payload}) THEN
    CASE WHEN json_type(${payload}, '$.packet.party') = 'text' THEN json_extract(${payload}, '$.packet.party') END END`;
const stamp = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const versionOneTriggers = `
  CREATE TRIGGER graphs_stamp AFTER INSERT ON graphs BEGIN
    UPDATE graphs SET created_at = ${stamp}, party = ${party('NEW.payload')} WHERE rowid = NEW.rowid;
  END;
  CREATE TRIGGER rooms_stamp AFTER INSERT ON rooms BEGIN
    UPDATE rooms SET created_at = ${stamp} WHERE rowid = NEW.rowid;
  END;
`;
// What version 2 (P1b, PR #42 3491cc4) adds: projects and sessions.project_id.
const versionTwoTable = `
  CREATE TABLE projects (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
  ALTER TABLE sessions ADD COLUMN project_id TEXT REFERENCES projects(id);
  CREATE INDEX sessions_project_id ON sessions(project_id);
`;
const versionTwoTrigger = `
  CREATE TRIGGER sessions_project AFTER INSERT ON sessions WHEN NEW.project_id IS NULL BEGIN
    UPDATE sessions SET project_id = (SELECT id FROM projects WHERE slug = 'default') WHERE rowid = NEW.rowid;
  END;
`;
// The 19f6522 session insert, which names no project and writes no message rows.
const oldInsertSession = `INSERT INTO sessions (id, provider, source, title, message_count, messages, search_text)
  VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`;
const sessionColumns = 'id, provider, source, title, message_count, messages, search_text';
// Review of PR #45: the error names the session and says what is wrong, in fixed words.
const notAnArray = 'its stored messages are not a JSON array';
const notAMessage = 'a stored message is not an object with a user or assistant role, a string text and a line from 1 to 2^53 - 1';
const sameLine = 'two stored messages have the same line';
const repeatedField = 'a stored message has the same field twice';
const nulName = 'a stored message has a role, text or line field name followed by a NUL character';
const tooDeep = 'its stored messages are nested more than 1,000 levels deep';
// A turn whose meta value nests arrays so that the whole stored value is depth levels deep.
const nested = depth => `[{"role": "user", "text": "Deep", "line": 1, "meta": ${'['.repeat(depth - 2)}${']'.repeat(depth - 2)}}]`;
const migrationFailed = (session, reason) =>
  `${session} cannot be moved to schema version 3: ${reason}. The migration rolled back, so the file was not changed.`;
const leftoverFailed = 'This ledger already has a messages table or trigger that schema version 3 did not create. ' +
  'The file was not changed.';

const uuids = ['0b6e7d1a-1111-4222-8333-444455556666', '0b6e7d1a-1111-4222-8333-777788889999', '0b6e7d1a-1111-4222-8333-aaaabbbbcccc'];
const claudeRecord = (role, text, extra = {}) => JSON.stringify({ type: role, ...extra, message: { role, content: text } });
const codexRecord = (role, text) => JSON.stringify({ type: 'response_item',
  payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });
// Three Claude turns with UUIDs and a record that is not a turn (line 2).
const leoTranscript = [
  claudeRecord('user', 'Plan the synthetic Orion demo.', { uuid: uuids[0] }),
  JSON.stringify({ type: 'summary', summary: 'Not a turn' }),
  claudeRecord('assistant', 'Draft the Orion outline first.', { uuid: uuids[1] }),
  claudeRecord('user', 'Then rehearse it twice.', { uuid: uuids[2] }),
].join('\n');
const aliTranscript = [codexRecord('user', 'Ali reviews the Orion outline.'), codexRecord('assistant', 'Outline approved.')].join('\n');

const userVersion = database => database.prepare('PRAGMA user_version').get().user_version;
const plain = rows => rows.map(row => ({ ...row }));
const rows = (database, sql, ...values) => plain(database.prepare(sql).all(...values));
const schema = database => rows(database, 'SELECT type, name, sql FROM sqlite_master ORDER BY type, name');
const messageRows = (database, sessionId) =>
  rows(database, 'SELECT seq, line, role, text_json, key FROM messages WHERE session_id = ? ORDER BY seq', sessionId)
    .map(({ seq, line, role, text_json: text, key }) => ({ seq, line, role, text: JSON.parse(text), key }));
const sessionId = (provider, transcript) => createHash('sha256').update(`${provider}${nul}`).update(transcript).digest('hex');
// Recomputed here rather than imported, so the test checks the rule, not the code.
const hashKey = (id, line, rawLine) =>
  'h:' + createHash('sha256').update(`${id}${nul}${line}${nul}${rawLine}`).digest('hex').slice(0, 32);

async function scratchDirectory(t, prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const handles = [];
  t.after(async () => {
    try {
      for (const close of handles.reverse()) await close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  return { directory, keep: close => handles.push(close) };
}

/**
 * A ledger file at version 0, 1 or 2 (in UTF-8 unless another text encoding is named) with a Claude session in `acme` (version 2 only) and
 * a Codex session in `default`, three graphs and a decided room. Rows are copied from a
 * scratch store, whose sessions.messages column holds the JSON the older builds wrote.
 */
async function oldLedger(directory, version, encoding = 'UTF-8') {
  const scratchPath = join(directory, `scratch-${version}.sqlite`);
  const scratch = openStore(scratchPath);
  const leo = scratch.importTranscript({ provider: 'claude', source: 'leo.jsonl', transcript: leoTranscript, project: 'acme' });
  // P2a refuses a link across projects, which older builds stored. Ali's session is made in
  // acme so the link and room can be published, and moved to default when copied below,
  // as a file from before P2a may hold it.
  const ali = { ...scratch.importTranscript({ provider: 'codex', source: 'ali.jsonl', transcript: aliTranscript, project: 'acme' }), project: 'default' };
  const v1 = scratch.publishGraph({ version: 1, sessionId: leo.id, nodes: [{ id: 'ship', kind: 'goal', label: 'Ship Orion', evidenceLines: [1] }], edges: [] });
  const leoGraph = scratch.publishGraph({ version: 2, sessionId: leo.id, party: 'leo',
    nodes: [{ id: 'demo', kind: 'goal', label: 'Synthetic demo', evidenceLines: [1, 3] }], edges: [] });
  const aliGraph = scratch.publishGraph({ version: 2, sessionId: ali.id, party: 'ali',
    nodes: [{ id: 'review', kind: 'offer', label: 'Review the outline', evidenceLines: [2] }], edges: [],
    links: [{ from: 'review', graph: leoGraph.id, to: 'demo', type: 'matches' }] });
  const opened = scratch.openRoom({ graphIds: [leoGraph.id, aliGraph.id] });
  const room = scratch.decide(opened.id, { proposalId: opened.proposals[0].id, party: 'leo', choice: 'confirm' });
  const context = scratch.getGraphContext(leoGraph.id);
  scratch.close();

  const source = new DatabaseSync(scratchPath);
  const path = join(directory, `v${version}-${encoding}.sqlite`);
  const old = new DatabaseSync(path);
  old.exec(`PRAGMA encoding = '${encoding}'`);
  old.exec(versionZeroDdl);
  if (version >= 1) old.exec(versionOneColumns);
  if (version >= 2) old.exec(versionTwoTable);
  const copy = (table, names, from = table) => {
    const insert = old.prepare(`INSERT INTO ${table} (${names}) VALUES (${names.split(', ').map(() => '?').join(', ')})`);
    for (const row of source.prepare(`SELECT ${names} FROM ${from} ORDER BY rowid`).all()) insert.run(...Object.values(row));
  };
  if (version >= 2) copy('projects', 'id, slug, name, created_at');
  copy('sessions', version >= 2 ? `${sessionColumns}, project_id` : sessionColumns);
  if (version >= 2) old.prepare("UPDATE sessions SET project_id = (SELECT id FROM projects WHERE slug = 'default') WHERE id = ?").run(ali.id);
  copy('graphs', version >= 1 ? 'id, session_id, payload, created_at, party' : 'id, session_id, payload');
  copy('rooms', version >= 1 ? 'id, graph_a, graph_b, created_at' : 'id, graph_a, graph_b');
  copy('room_choices', 'room_id, proposal_id, party, choice');
  source.close();
  if (version >= 1) old.exec(versionOneTriggers);
  if (version >= 2) old.exec(versionTwoTrigger);
  old.exec(`PRAGMA user_version = ${version}`);
  assert.deepEqual(rows(old, "SELECT name FROM sqlite_master WHERE name = 'messages'"), []);
  old.close();
  return { path, leo, ali, v1, leoGraph, aliGraph, room, context };
}

/** The rows a migrated session must get: its JSON messages in order, keyed by line. */
const legacyRowsOf = json => JSON.parse(json).map(({ role, text, line }, seq) => ({ seq, line, role, text, key: `l:${line}` }));

test('a new file is at schema version 3 with the messages table, its keys and the older-build trigger', async t => {
  const { directory, keep } = await scratchDirectory(t, 'ledger-p1c-new-');
  const path = join(directory, 'ledger.sqlite');
  openStore(path).close();
  const check = new DatabaseSync(path);
  keep(() => check.close());
  // P2b added version 4 (artifacts) on top of these rows; a new file is at the newest.
  assert.ok(schemaVersion >= 4);
  assert.equal(userVersion(check), schemaVersion);
  assert.deepEqual(rows(check, 'PRAGMA table_info(messages)').map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk })), [
    { name: 'id', type: 'INTEGER', notnull: 0, pk: 1 },
    { name: 'session_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'seq', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'line', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'role', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'text_json', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'key', type: 'TEXT', notnull: 1, pk: 0 },
  ]);
  const unique = rows(check, 'PRAGMA index_list(messages)').filter(index => index.unique === 1 && index.origin === 'u')
    .map(index => rows(check, `PRAGMA index_info(${JSON.stringify(index.name)})`).map(column => column.name).join(', ')).sort();
  assert.deepEqual(unique, ['session_id, key', 'session_id, seq']);
  assert.deepEqual(rows(check, 'PRAGMA foreign_key_list(messages)').map(({ table, from, to, on_delete }) => ({ table, from, to, on_delete })),
    [{ table: 'sessions', from: 'session_id', to: 'id', on_delete: 'CASCADE' }]);
  const table = check.prepare("SELECT sql FROM sqlite_master WHERE name = 'messages'").get().sql;
  assert.match(table, /DEFERRABLE INITIALLY DEFERRED/u);
  assert.match(table, /STRICT$/u);
  assert.ok(schema(check).some(row => row.type === 'trigger' && row.name === 'sessions_messages'));
  // No FTS5 or any other virtual table: the engine decision (P1a) is still open.
  assert.deepEqual(rows(check, "SELECT name FROM sqlite_master WHERE sql LIKE 'CREATE VIRTUAL TABLE%'"), []);
});

test('a version 2 file upgrades in place: rows match the stored JSON with line keys and citations still hold', async t => {
  const { directory, keep } = await scratchDirectory(t, 'ledger-p1c-v2-');
  const fixture = await oldLedger(directory, 2);
  const raw = new DatabaseSync(fixture.path);
  const before = {
    sessions: rows(raw, 'SELECT * FROM sessions ORDER BY rowid'),
    projects: rows(raw, 'SELECT * FROM projects ORDER BY rowid'),
    graphs: rows(raw, 'SELECT * FROM graphs ORDER BY rowid'),
    rooms: rows(raw, 'SELECT * FROM rooms ORDER BY rowid'),
    choices: rows(raw, 'SELECT * FROM room_choices ORDER BY rowid'),
  };
  raw.close();
  assert.deepEqual(before.projects.map(project => project.slug), ['default', 'acme']);

  const store = openStore(fixture.path);
  let closed = false;
  keep(() => closed || store.close());
  const check = new DatabaseSync(fixture.path);
  keep(() => check.close());
  assert.equal(userVersion(check), schemaVersion);

  // Every session has its JSON messages as rows, in order, keyed l:<line>.
  for (const session of before.sessions) {
    assert.deepEqual(messageRows(check, session.id), legacyRowsOf(session.messages), session.source);
  }
  assert.deepEqual(messageRows(check, fixture.leo.id).map(row => [row.line, row.key]), [[1, 'l:1'], [3, 'l:3'], [4, 'l:4']]);
  // Every older row keeps its values.
  assert.deepEqual(rows(check, 'SELECT * FROM sessions ORDER BY rowid'), before.sessions);
  assert.deepEqual(rows(check, 'SELECT * FROM projects ORDER BY rowid'), before.projects);
  assert.deepEqual(rows(check, 'SELECT * FROM graphs ORDER BY rowid'), before.graphs);
  assert.deepEqual(rows(check, 'SELECT * FROM rooms ORDER BY rowid'), before.rooms);
  assert.deepEqual(rows(check, 'SELECT * FROM room_choices ORDER BY rowid'), before.choices);

  // Readers: the API shape is the JSON messages plus a key, and graphs, rooms and context read back.
  const leo = store.get(fixture.leo.id);
  assert.deepEqual(leo.messages, JSON.parse(before.sessions[0].messages).map(message => ({ ...message, key: `l:${message.line}` })));
  assert.equal(leo.project, 'acme');
  for (const graph of [fixture.v1, fixture.leoGraph, fixture.aliGraph]) assert.deepEqual(store.getGraph(graph.id), graph);
  // P2a: the fixture's room joins two projects (see oldLedger), so it is read-only now.
  assert.deepEqual(store.getRoom(fixture.room.id), { ...fixture.room, takesChoices: false });
  assert.deepEqual(store.getGraphContext(fixture.leoGraph.id), fixture.context);

  // Line citations still validate against the migrated rows.
  const cited = store.publishGraph({ version: 2, sessionId: fixture.leo.id, party: 'leo',
    nodes: [{ id: 'rehearse', kind: 'goal', label: 'Rehearse twice', evidenceLines: [4] }], edges: [] });
  assert.deepEqual(cited.packet.nodes[0].evidenceLines, [4]);
  for (const line of [2, 5]) {
    assert.throws(() => store.publishGraph({ version: 2, sessionId: fixture.leo.id, party: 'leo',
      nodes: [{ id: 'other', kind: 'goal', label: 'Not a turn', evidenceLines: [line] }], edges: [] }),
    { message: 'Evidence must refer to stored lines in the source session.' }, `line ${line}`);
  }

  // Reopening changes neither schema nor rows.
  const shape = schema(check);
  const contents = rows(check, 'SELECT * FROM messages ORDER BY id');
  store.close();
  closed = true;
  openStore(fixture.path).close();
  assert.deepEqual(schema(check), shape);
  assert.deepEqual(rows(check, 'SELECT * FROM messages ORDER BY id'), contents);
  assert.equal(userVersion(check), schemaVersion);
});

test('version 1 and unversioned files go straight to version 3 with the same rows', async t => {
  const { directory, keep } = await scratchDirectory(t, 'ledger-p1c-old-');
  for (const version of [0, 1]) {
    const fixture = await oldLedger(directory, version);
    const store = openStore(fixture.path);
    keep(() => store.close());
    const check = new DatabaseSync(fixture.path);
    keep(() => check.close());
    assert.equal(userVersion(check), schemaVersion, `version ${version}`);
    const sessions = rows(check, 'SELECT id, messages, project_id FROM sessions ORDER BY rowid');
    assert.equal(sessions.length, 2);
    for (const session of sessions) assert.deepEqual(messageRows(check, session.id), legacyRowsOf(session.messages));
    assert.equal(check.prepare('SELECT count(*) AS n FROM sessions WHERE project_id IS NULL').get().n, 0);
    assert.deepEqual(rows(check, 'PRAGMA table_info(graphs)').map(column => column.name), ['id', 'session_id', 'payload', 'created_at', 'party']);
    assert.deepEqual(store.get(fixture.ali.id).messages.map(message => message.key), ['l:1', 'l:2']);
    assert.equal(store.getGraphContext(fixture.leoGraph.id).text, fixture.context.text);
  }
});

test('a file that already has a messages table or a sessions_messages trigger is refused untouched', async t => {
  // Review rounds 1 to 4. The version 3 step is one transaction, so a file below version 3
  // never holds a messages table or trigger of its own. Earlier drafts reused such leftovers
  // when they looked right; each review found a shape that passed and broke something
  // (wrong rows, no foreign key, a partial unique index, a clause in a comment, a trigger
  // in another case or on another table). Now any leftover fails the step.
  const { directory } = await scratchDirectory(t, 'ledger-p1c-leftovers-');
  const fixture = await oldLedger(directory, 2);
  const messagesTable = `
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
      seq INTEGER NOT NULL, line INTEGER NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')), text_json TEXT NOT NULL, key TEXT NOT NULL,
      UNIQUE (session_id, key), UNIQUE (session_id, seq)
    ) STRICT;`;
  const rowsFor = (id, texts) => texts.map((text, seq) =>
    `INSERT INTO messages (session_id, seq, line, role, text_json, key) VALUES ('${id}', ${seq}, ${seq + 1}, '${seq % 2 ? 'assistant' : 'user'}', '${JSON.stringify(text)}', 'h:kept-${seq}');`).join('\n');
  const aliRows = rowsFor(fixture.ali.id, ['Ali reviews the Orion outline.', 'Outline approved.']);
  const leftovers = [
    ['the version 3 table, empty', messagesTable],
    ['the version 3 table with matching rows', `${messagesTable} ${aliRows}`],
    ['the version 3 table with too few rows', `${messagesTable} ${rowsFor(fixture.ali.id, ['Ali reviews the Orion outline.'])}`],
    ['rows for a missing session', `PRAGMA foreign_keys = OFF; ${messagesTable} ${rowsFor('9'.repeat(64), ['Nobody'])}`],
    ['no foreign key', messagesTable.replace('REFERENCES sessions(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED', '')],
    ['the deferred clause only in a comment', messagesTable.replace('DEFERRABLE INITIALLY DEFERRED,', ', -- DEFERRABLE INITIALLY DEFERRED,\n')],
    ['partial unique indexes', `CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL, key TEXT NOT NULL) STRICT;
      CREATE UNIQUE INDEX messages_key ON messages(session_id, key) WHERE seq < 0;`],
    ['a trigger on messages', `${messagesTable}
      CREATE TRIGGER messages_drop AFTER INSERT ON messages BEGIN DELETE FROM messages WHERE id = NEW.id; END;`],
    ['a view named messages', 'CREATE VIEW messages AS SELECT id AS session_id FROM sessions;'],
    ['a table named Messages', 'CREATE TABLE Messages (x TEXT);'],
    ['a no-op sessions_messages trigger', 'CREATE TRIGGER sessions_messages AFTER INSERT ON sessions BEGIN SELECT 1; END;'],
    ['a sessions_messages trigger on projects', `CREATE TABLE audit (note TEXT);
      CREATE TRIGGER sessions_messages AFTER INSERT ON projects BEGIN INSERT INTO audit VALUES ('project'); END;`],
    ['SESSIONS_MESSAGES on projects', `CREATE TABLE audit (note TEXT);
      CREATE TRIGGER SESSIONS_MESSAGES AFTER INSERT ON projects BEGIN INSERT INTO audit VALUES ('project'); END;`],
  ];
  for (const [index, [name, ddl]] of leftovers.entries()) {
    const path = join(directory, `leftover-${index}.sqlite`);
    await copyFile(fixture.path, path);
    const setup = new DatabaseSync(path);
    setup.exec(ddl);
    const shape = schema(setup);
    setup.close();
    const bytes = await readFile(path);
    assert.throws(() => openStore(path), { message: leftoverFailed }, name);
    assert.ok((await readFile(path)).equals(bytes), `${name}: the file is unchanged`);
    const after = new DatabaseSync(path);
    assert.equal(userVersion(after), 2, name);
    assert.deepEqual(schema(after), shape, name);
    after.close();
  }

  // Review round 5: version 0 and 1 files reach the refusal after their earlier steps ran in
  // the same transaction; those roll back too, and the file migrates once the leftover is gone.
  for (const version of [0, 1]) {
    const old = await oldLedger(directory, version);
    const setup = new DatabaseSync(old.path);
    setup.exec('CREATE TABLE Messages (x TEXT);');
    const shape = schema(setup);
    setup.close();
    const bytes = await readFile(old.path);
    assert.throws(() => openStore(old.path), { message: leftoverFailed }, `version ${version}`);
    assert.ok((await readFile(old.path)).equals(bytes), `version ${version}: the file is unchanged`);
    const cleanup = new DatabaseSync(old.path);
    assert.equal(userVersion(cleanup), version);
    assert.deepEqual(schema(cleanup), shape);
    cleanup.exec('DROP TABLE Messages;');
    cleanup.close();
    const store = openStore(old.path);
    assert.deepEqual(store.get(old.ali.id).messages.map(message => message.key), ['l:1', 'l:2']);
    store.close();
    const check = new DatabaseSync(old.path);
    assert.equal(userVersion(check), schemaVersion);
    check.close();
  }
});

test('a session whose stored messages cannot be copied fails the step, names the session and leaves the file at version 2', async t => {
  // Review of PR #45: one bad session used to fail the open with text that named no
  // session, and two messages on one line surfaced a raw SQLite error. The bad session is
  // the second one, so the first session's rows were already written when the step failed.
  const { directory } = await scratchDirectory(t, 'ledger-p1c-atomic-');
  const fixture = await oldLedger(directory, 2);
  const turn = { role: 'user', text: 'Synthetic turn', line: 1 };
  const variants = [
    ['malformed JSON', '[{"role": "user"', notAnArray],
    ['an object', JSON.stringify({ messages: [turn] }), notAnArray],
    ['an empty value', '', notAnArray],
    ['a NUL after the array', `${JSON.stringify([turn])}${nul}[]`, notAnArray],
    ['a number in the array', JSON.stringify([turn, 7]), notAMessage],
    ['null in the array', JSON.stringify([turn, null]), notAMessage],
    ['an array in the array', JSON.stringify([turn, [turn]]), notAMessage],
    ['a system role', JSON.stringify([{ ...turn, role: 'system' }]), notAMessage],
    ['a missing text', JSON.stringify([{ role: 'user', line: 1 }]), notAMessage],
    ['a numeric text', JSON.stringify([{ ...turn, text: 5 }]), notAMessage],
    ['line 0', JSON.stringify([{ ...turn, line: 0 }]), notAMessage],
    ['a string line', JSON.stringify([{ ...turn, line: '1' }]), notAMessage],
    ['a fractional line', JSON.stringify([{ ...turn, line: 1.5 }]), notAMessage],
    // Review round 1: lines JavaScript cannot read exactly.
    ['line 2^53', JSON.stringify([{ ...turn, line: Number.MAX_SAFE_INTEGER + 1 }]), notAMessage],
    ['line 2^63', '[{"role": "user", "text": "Synthetic turn", "line": 9223372036854775808}]', notAMessage],
    // Two stored messages on one line would share a key.
    ['two messages on one line', JSON.stringify([turn, { ...turn, role: 'assistant' }]), sameLine],
    // Codex review of 5a80f16: JSON.parse keeps the last of two fields with one name, SQLite
    // the first, so a repeated field is refused. A line token that is not an integer is
    // refused even where JavaScript reads it as one, and so is a leading byte order mark.
    ['a repeated text', '[{"role": "user", "text": "first", "text": "last", "line": 1}]', repeatedField],
    ['a repeated line', '[{"role": "user", "text": "Synthetic turn", "line": 2, "line": 1}]', repeatedField],
    ['a repeated escaped name', '[{"role": "user", "text": "first", "te\\u0078t": "last", "line": 1}]', repeatedField],
    ['line 1.0', '[{"role": "user", "text": "Synthetic turn", "line": 1.0}]', notAMessage],
    ['line 1e0', '[{"role": "user", "text": "Synthetic turn", "line": 1e0}]', notAMessage],
    ['line 1.00000000000000001', '[{"role": "user", "text": "Synthetic turn", "line": 1.00000000000000001}]', notAMessage],
    ['a byte order mark', `${String.fromCodePoint(0xfeff)}${JSON.stringify([turn])}`, notAnArray],
    // Codex review of 2f44b8a: SQLite compares names only up to a NUL, so this name would be
    // its line, and SQLite refuses JSON nested more than 1,000 levels deep.
    ['a NUL in a field name', '[{"role": "user", "text": "turn", "line\\u0000suffix": 9, "l\\u0069ne": 1}]', nulName],
    // Codex review of ed38502: the same for the other fields the copy reads.
    ['a NUL after role', '[{"role\\u0000x": "assistant", "role": "user", "text": "turn", "line": 1}]', nulName],
    ['a NUL after text', '[{"role": "user", "text\\u0000": "other", "text": "turn", "line": 1}]', nulName],
    ['1,001 levels', nested(1001), tooDeep],
  ];
  for (const [index, [name, messages, reason]] of variants.entries()) {
    const path = join(directory, `atomic-${index}.sqlite`);
    await copyFile(fixture.path, path);
    const setup = new DatabaseSync(path);
    setup.prepare('UPDATE sessions SET messages = ? WHERE id = ?').run(messages, fixture.ali.id);
    const shape = schema(setup);
    const sessions = rows(setup, 'SELECT * FROM sessions ORDER BY rowid');
    setup.close();
    const bytes = await readFile(path);
    assert.throws(() => openStore(path), { message: migrationFailed(`Session ${fixture.ali.id}`, reason) }, name);
    assert.ok((await readFile(path)).equals(bytes), `${name}: the file is unchanged`);
    const after = new DatabaseSync(path);
    assert.equal(userVersion(after), 2, name);
    assert.deepEqual(schema(after), shape, name);
    assert.deepEqual(rows(after, 'SELECT * FROM sessions ORDER BY rowid'), sessions, name);
    after.close();
  }

  // Bytes that are not UTF-8 are refused too: the step reads each array as its exact bytes.
  const notUtf8 = join(directory, 'atomic-not-utf8.sqlite');
  await copyFile(fixture.path, notUtf8);
  const setup = new DatabaseSync(notUtf8);
  setup.prepare("UPDATE sessions SET messages = CAST(x'5b22ff225d' AS TEXT) WHERE id = ?").run(fixture.ali.id);
  setup.close();
  assert.throws(() => openStore(notUtf8), { message: migrationFailed(`Session ${fixture.ali.id}`, notAnArray) });

  // A session whose ID is not 64 hex characters is named by its row, so no stored text is
  // printed. The ID here holds a newline and a NUL.
  const oddId = join(directory, 'atomic-odd-id.sqlite');
  await copyFile(fixture.path, oddId);
  const odd = new DatabaseSync(oddId);
  odd.prepare("INSERT INTO sessions (id, provider, source, title, message_count, messages, search_text) VALUES ('odd' || char(10) || 'id' || char(0) || '!', 'claude', 'odd.jsonl', 'Odd', 1, ?, 'odd')")
    .run(JSON.stringify([{ ...turn, role: 'system' }]));
  const rowid = odd.prepare("SELECT rowid FROM sessions WHERE id NOT GLOB '[0-9a-f]*'").get().rowid;
  odd.close();
  const bytes = await readFile(oddId);
  assert.throws(() => openStore(oddId), { message: migrationFailed(`The session in row ${rowid}`, notAMessage) });
  assert.ok((await readFile(oddId)).equals(bytes));
});

test('a stored value 1,000 levels deep migrates, as SQLite reads it', async t => {
  // Codex review of 2f44b8a: the other side of the depth limit, checked against SQLite itself.
  const { directory, keep } = await scratchDirectory(t, 'ledger-p1c-depth-');
  const fixture = await oldLedger(directory, 2);
  const setup = new DatabaseSync(fixture.path);
  assert.deepEqual({ ...setup.prepare('SELECT json_valid(?) AS ok, json_valid(?) AS deeper').get(nested(1000), nested(1001)) }, { ok: 1, deeper: 0 });
  setup.prepare('UPDATE sessions SET messages = ? WHERE id = ?').run(nested(1000), fixture.ali.id);
  setup.close();
  const store = openStore(fixture.path);
  keep(() => store.close());
  assert.deepEqual(store.get(fixture.ali.id).messages, [{ role: 'user', text: 'Deep', line: 1, key: 'l:1' }]);
});

test('an extra field whose name holds a NUL is ignored, as before', async t => {
  // Codex review of ed38502: only a NUL name that SQLite would read as role, text or line
  // is refused. Others, such as meta and a NUL, or a NUL and then line, migrate as before.
  const { directory, keep } = await scratchDirectory(t, 'ledger-p1c-nul-extra-');
  const fixture = await oldLedger(directory, 2);
  const setup = new DatabaseSync(fixture.path);
  const stored = '[{"role": "user", "text": "turn", "line": 1, "meta\\u0000suffix": 9, "\\u0000line": 7, "lines\\u0000": 8}]';
  setup.prepare('UPDATE sessions SET messages = ? WHERE id = ?').run(stored, fixture.ali.id);
  setup.close();
  const store = openStore(fixture.path);
  keep(() => store.close());
  assert.deepEqual(store.get(fixture.ali.id).messages, [{ role: 'user', text: 'turn', line: 1, key: 'l:1' }]);
});

test('repeated names inside a text, nested objects and escaped quotes are not repeated fields', async t => {
  // Codex review of 5a80f16: the field check reads only the members of each message.
  const { directory, keep } = await scratchDirectory(t, 'ledger-p1c-fields-');
  const fixture = await oldLedger(directory, 2);
  const setup = new DatabaseSync(fixture.path);
  const stored = '[{"role": "user", "text": "a \\"text\\": \\\\", "line": 1, "meta": {"line": 9, "line": 8}},' +
    ' {"line": 2, "text": "\\"role\\":", "role": "assistant", "extra": [{"text": 1}, {"text": 2}]}]';
  setup.prepare('UPDATE sessions SET messages = ? WHERE id = ?').run(stored, fixture.ali.id);
  setup.close();
  const store = openStore(fixture.path);
  keep(() => store.close());
  assert.deepEqual(store.get(fixture.ali.id).messages, [
    { role: 'user', text: 'a "text": \\', line: 1, key: 'l:1' },
    { role: 'assistant', text: '"role":', line: 2, key: 'l:2' },
  ]);
});

test('wide rowids and UTF-16 files migrate exactly, and their bad sessions are named', async t => {
  // Codex review of 5a80f16: a rowid above 2^53 failed to convert before the loop body ran,
  // and a UTF-16 file was decoded as UTF-8, so every session looked invalid.
  const { directory, keep } = await scratchDirectory(t, 'ledger-p1c-wide-');
  const wide = 9007199254740993n;
  const stored = [{ role: 'user', text: `Wide ${nul} row`, line: 1 }, { role: 'assistant', text: 'Wide reply', line: 2 }];
  const insertWide = `INSERT INTO sessions (rowid, id, provider, source, title, message_count, messages, search_text)
    VALUES (?, ?, 'claude', 'wide.jsonl', 'Wide', 2, ?, 'wide')`;
  const fixture = await oldLedger(directory, 2);
  const setup = new DatabaseSync(fixture.path);
  setup.prepare(insertWide).run(wide, 'a'.repeat(64), JSON.stringify(stored));
  setup.prepare(insertWide).run(wide + 1n, `opaque${nul}id`, JSON.stringify(stored));
  setup.close();
  const bad = join(directory, 'wide-bad.sqlite');
  await copyFile(fixture.path, bad);
  const store = openStore(fixture.path);
  keep(() => store.close());
  assert.deepEqual(store.get('a'.repeat(64)).messages, stored.map(message => ({ ...message, key: `l:${message.line}` })));
  const check = new DatabaseSync(fixture.path);
  keep(() => check.close());
  assert.equal(check.prepare(`SELECT count(*) AS n FROM messages WHERE session_id = 'opaque' || char(0) || 'id'`).get().n, 2);

  const breakIt = new DatabaseSync(bad);
  breakIt.prepare('UPDATE sessions SET messages = ? WHERE rowid = ?').run('{}', wide + 1n);
  breakIt.close();
  assert.throws(() => openStore(bad), { message: migrationFailed(`The session in row ${wide + 1n}`, notAnArray) });

  for (const encoding of ['UTF-16le', 'UTF-16be']) {
    const utf16 = await oldLedger(directory, 2, encoding);
    const raw = new DatabaseSync(utf16.path);
    assert.equal(raw.prepare('PRAGMA encoding').get().encoding, encoding);
    const sessions = rows(raw, 'SELECT id, messages FROM sessions ORDER BY rowid');
    raw.close();
    const broken = join(directory, `${encoding}-bad.sqlite`);
    await copyFile(utf16.path, broken);
    const migrated = openStore(utf16.path);
    keep(() => migrated.close());
    const after = new DatabaseSync(utf16.path);
    keep(() => after.close());
    for (const session of sessions) assert.deepEqual(messageRows(after, session.id), legacyRowsOf(session.messages), encoding);
    assert.deepEqual(migrated.getGraph(utf16.leoGraph.id), utf16.leoGraph, encoding);
    // A 64-character ID is 128 bytes in UTF-16 and is still named by its ID.
    const setupBroken = new DatabaseSync(broken);
    setupBroken.prepare('UPDATE sessions SET messages = ? WHERE id = ?').run('[1]', utf16.ali.id);
    setupBroken.close();
    assert.throws(() => openStore(broken), { message: migrationFailed(`Session ${utf16.ali.id}`, notAMessage) }, encoding);
  }
});

test('a session whose ID is not 64 hex characters migrates with its exact ID', async t => {
  // Review of PR #45: the copy binds a usual ID from JavaScript and copies any other one
  // by rowid in SQL, because node:sqlite cuts text at a NUL when it reads it.
  const { directory, keep } = await scratchDirectory(t, 'ledger-p1c-odd-id-');
  const fixture = await oldLedger(directory, 2);
  const setup = new DatabaseSync(fixture.path);
  const stored = [{ role: 'user', text: 'Odd ID turn', line: 1 }, { role: 'assistant', text: 'Odd ID reply', line: 2 }];
  setup.prepare("INSERT INTO sessions (id, provider, source, title, message_count, messages, search_text) VALUES ('odd' || char(0) || 'id', 'claude', 'odd.jsonl', 'Odd', 2, ?, 'odd')")
    .run(JSON.stringify(stored));
  setup.close();
  const store = openStore(fixture.path);
  keep(() => store.close());
  const check = new DatabaseSync(fixture.path);
  keep(() => check.close());
  assert.equal(userVersion(check), schemaVersion);
  assert.deepEqual(rows(check, `SELECT r.seq, r.line, r.role, r.text_json, r.key FROM messages r JOIN sessions s ON s.id = r.session_id
    WHERE s.id = 'odd' || char(0) || 'id' ORDER BY r.seq`), stored.map(({ role, text, line }, seq) =>
    ({ seq, line, role, text_json: JSON.stringify(text), key: `l:${line}` })));
  assert.equal(check.prepare("SELECT count(*) AS n FROM messages WHERE session_id = 'odd'").get().n, 0, 'the ID is not cut at the NUL');
  for (const session of [fixture.leo, fixture.ali]) {
    assert.deepEqual(store.get(session.id).messages.map(message => message.key), session.id === fixture.leo.id ? ['l:1', 'l:3', 'l:4'] : ['l:1', 'l:2']);
  }
});

test('a migrated session keeps l: keys, while a fresh import of the same bytes gets u: keys', async t => {
  // Review of PR #45, finding 5, kept as designed (docs/architecture.md section 4): the
  // stored JSON has no raw lines or UUIDs, so a migrated session's keys are l:<line>, and
  // they never change. The same bytes in a fresh ledger give the same session ID, lines and
  // texts with u: keys. Matching sessions across ledgers by key is left to the
  // provider:uuid card, which links a legacy session to its UUID session.
  const { directory, keep } = await scratchDirectory(t, 'ledger-p1c-legacy-keys-');
  const fixture = await oldLedger(directory, 2);
  const migrated = openStore(fixture.path);
  keep(() => migrated.close());
  const fresh = openStore(join(directory, 'fresh.sqlite'));
  keep(() => fresh.close());
  const imported = fresh.importTranscript({ provider: 'claude', source: 'leo.jsonl', transcript: leoTranscript });
  assert.equal(imported.id, fixture.leo.id);

  const legacy = migrated.get(fixture.leo.id).messages;
  const current = fresh.get(imported.id).messages;
  assert.deepEqual(legacy.map(message => message.key), ['l:1', 'l:3', 'l:4']);
  assert.deepEqual(current.map(message => message.key), uuids.map(uuid => `u:${uuid}`));
  const withoutKey = messages => messages.map(({ role, text, line }) => ({ role, text, line }));
  assert.deepEqual(withoutKey(legacy), withoutKey(current));

  // Importing the same bytes into the migrated ledger returns the stored session; its keys stay l:.
  assert.equal(migrated.importTranscript({ provider: 'claude', source: 'leo.jsonl', transcript: leoTranscript }).id, fixture.leo.id);
  assert.deepEqual(migrated.get(fixture.leo.id).messages, legacy);
  // A Codex session has no UUIDs: migrated it keeps l: keys, fresh it gets h: keys
  // (Codex review of 5a80f16: the same checks as for Claude, with the ID fixed in advance).
  const aliId = sessionId('codex', aliTranscript);
  assert.equal(fixture.ali.id, aliId);
  assert.equal(fresh.importTranscript({ provider: 'codex', source: 'ali.jsonl', transcript: aliTranscript }).id, aliId);
  const legacyAli = migrated.get(aliId).messages;
  const currentAli = fresh.get(aliId).messages;
  assert.deepEqual(legacyAli.map(message => message.key), ['l:1', 'l:2']);
  assert.deepEqual(currentAli.map(message => message.key), aliTranscript.split('\n').map((line, index) => hashKey(aliId, index + 1, line)));
  assert.deepEqual(withoutKey(legacyAli), withoutKey(currentAli));
  assert.equal(migrated.importTranscript({ provider: 'codex', source: 'ali.jsonl', transcript: aliTranscript }).id, aliId);
  assert.deepEqual(migrated.get(aliId).messages, legacyAli);
});

test('a newer file is refused untouched', async t => {
  const { directory } = await scratchDirectory(t, 'ledger-p1c-newer-');
  const path = join(directory, 'newer.sqlite');
  openStore(path).close();
  const bump = new DatabaseSync(path);
  bump.exec(`PRAGMA user_version = ${schemaVersion + 1}`);
  bump.close();
  const bytes = await readFile(path);
  assert.throws(() => openStore(path), { message: `This ledger database was written by a newer Context Ledger (schema ${schemaVersion + 1}). ` +
    'Use that version or another CONTEXT_LEDGER_DB.' });
  assert.ok((await readFile(path)).equals(bytes));
});

test('a session inserted by a build from before versions gets line-keyed rows from its JSON', async t => {
  const { directory, keep } = await scratchDirectory(t, 'ledger-p1c-older-build-');
  const path = join(directory, 'ledger.sqlite');
  openStore(path).close();
  const older = new DatabaseSync(path);
  keep(() => older.close());
  older.exec(versionZeroDdl);
  const id = '6'.repeat(64);
  const messages = [{ role: 'user', text: 'Old build turn', line: 1 }, { role: 'assistant', text: 'Old build reply', line: 3 }];
  older.prepare(oldInsertSession).run(id, 'claude', 'old.jsonl', 'Old build turn', 2, JSON.stringify(messages), 'old build turn\nold build reply');
  assert.deepEqual(messageRows(older, id), [
    { seq: 0, line: 1, role: 'user', text: 'Old build turn', key: 'l:1' },
    { seq: 1, line: 3, role: 'assistant', text: 'Old build reply', key: 'l:3' },
  ]);
  // A repeated insert of the same ID is ignored and adds no rows.
  older.prepare(oldInsertSession).run(id, 'claude', 'old.jsonl', 'Old build turn', 2, JSON.stringify(messages), 'old build turn');
  assert.equal(older.prepare('SELECT count(*) AS n FROM messages').get().n, 2);

  const store = openStore(path);
  keep(() => store.close());
  const session = store.get(id);
  assert.equal(session.project, 'default');
  assert.deepEqual(session.messages, messages.map(message => ({ ...message, key: `l:${message.line}` })));
  assert.equal(store.publishGraph({ version: 1, sessionId: id, nodes: [{ id: 'g', kind: 'goal', label: 'Old', evidenceLines: [3] }], edges: [] })
    .packet.nodes[0].evidenceLines[0], 3);
});

test('imports key each turn by record UUID or by a hash of its session, line and raw line', async t => {
  const { directory, keep } = await scratchDirectory(t, 'ledger-p1c-keys-');
  const store = openStore(join(directory, 'ledger.sqlite'));
  keep(() => store.close());

  const lines = [
    claudeRecord('user', 'First UUID turn.', { uuid: uuids[0] }),
    claudeRecord('assistant', 'ok', { uuid: uuids[1].toUpperCase() }),
    claudeRecord('user', 'Repeats the first UUID.', { uuid: uuids[0] }),
    claudeRecord('assistant', 'ok'),
    claudeRecord('user', 'ok'),
    claudeRecord('assistant', 'Not a UUID.', { uuid: 'not-a-uuid' }),
    claudeRecord('user', 'A control character.', { uuid: `${uuids[2]}${bell}` }),
    claudeRecord('assistant', 'A number.', { uuid: 42 }),
    JSON.stringify({ type: 'summary', uuid: uuids[2], summary: 'Not a turn' }),
    claudeRecord('user', 'Third UUID after a non-turn used it.', { uuid: uuids[2] }),
    // Review round 1: the UUID of line 2 again, in lower case, is a repeat.
    claudeRecord('assistant', 'Repeats line 2 in lower case.', { uuid: uuids[1] }),
  ];
  const transcript = lines.join('\n');
  const summary = store.importTranscript({ provider: 'claude', source: 'keys.jsonl', transcript });
  const id = sessionId('claude', transcript);
  assert.equal(summary.id, id);
  const keys = store.get(id).messages.map(message => [message.line, message.key]);
  assert.deepEqual(keys, [
    [1, `u:${uuids[0]}`],
    [2, `u:${uuids[1].toUpperCase()}`],
    [3, hashKey(id, 3, lines[2])],
    [4, hashKey(id, 4, lines[3])],
    [5, hashKey(id, 5, lines[4])],
    [6, hashKey(id, 6, lines[5])],
    [7, hashKey(id, 7, lines[6])],
    [8, hashKey(id, 8, lines[7])],
    [10, `u:${uuids[2]}`],
    [11, hashKey(id, 11, lines[10])],
  ]);
  assert.notEqual(keys[2][1], keys[3][1], 'identical turns on different lines get different keys');
  assert.match(keys[2][1], /^h:[a-f0-9]{32}$/u);

  // Codex has no record UUIDs. A CRLF file hashes each line with its carriage return.
  const codexLines = [codexRecord('user', 'Codex asks.'), codexRecord('assistant', 'Codex answers.'), codexRecord('user', 'Codex asks.')];
  const crlf = codexLines.join('\r\n') + '\r\n';
  const codexSession = store.importTranscript({ provider: 'codex', source: 'codex.jsonl', transcript: crlf });
  const codexId = sessionId('codex', crlf);
  assert.equal(codexSession.id, codexId);
  const codexKeys = store.get(codexId).messages.map(message => message.key);
  assert.deepEqual(codexKeys, codexLines.map((line, index) => hashKey(codexId, index + 1, line + '\r')));
  assert.notEqual(codexKeys[0], hashKey(codexId, 1, codexLines[0]));
  assert.equal(new Set(codexKeys).size, 3);

  // The rows hold exactly what get returns, and the JSON copy is what older builds wrote.
  const check = new DatabaseSync(join(directory, 'ledger.sqlite'));
  keep(() => check.close());
  const detail = store.get(id);
  assert.deepEqual(messageRows(check, id), detail.messages.map((message, seq) => ({ seq, line: message.line, role: message.role, text: message.text, key: message.key })));
  assert.deepEqual(JSON.parse(check.prepare('SELECT messages FROM sessions WHERE id = ?').get(id).messages),
    detail.messages.map(({ role, text, line }) => ({ role, text, line })));

  // The same bytes in another, empty store give the same session ID and the same keys.
  const other = openStore(join(directory, 'other.sqlite'));
  keep(() => other.close());
  assert.equal(other.importTranscript({ provider: 'claude', source: 'copy.jsonl', transcript }).id, id);
  assert.deepEqual(other.get(id).messages, detail.messages);
  // Importing the same bytes again returns the stored session and writes nothing.
  assert.deepEqual(store.importTranscript({ provider: 'claude', source: 'keys.jsonl', transcript }), summary);
  assert.equal(check.prepare('SELECT count(*) AS n FROM messages WHERE session_id = ?').get(id).n, 10);
});

test('a session and its rows commit together or not at all', async t => {
  const { directory, keep } = await scratchDirectory(t, 'ledger-p1c-commit-');
  const path = join(directory, 'ledger.sqlite');
  const store = openStore(path);
  keep(() => store.close());
  const check = new DatabaseSync(path);
  keep(() => check.close());
  check.exec("CREATE TRIGGER fail_session BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;");
  const transcript = claudeRecord('user', 'Never stored.', { uuid: uuids[0] });
  assert.throws(() => store.importTranscript({ provider: 'claude', source: 'never.jsonl', transcript }), /synthetic failure/u);
  assert.equal(check.prepare('SELECT count(*) AS n FROM messages').get().n, 0);
  assert.equal(check.prepare('SELECT count(*) AS n FROM sessions').get().n, 0);
  check.exec('DROP TRIGGER fail_session');
  const stored = store.importTranscript({ provider: 'claude', source: 'never.jsonl', transcript });
  assert.deepEqual(messageRows(check, stored.id).map(row => row.key), [`u:${uuids[0]}`]);
  // A row without its session fails at commit: the foreign key is deferred, not dropped.
  assert.throws(() => check.exec(`BEGIN; INSERT INTO messages (session_id, seq, line, role, text_json, key)
    VALUES ('${'9'.repeat(64)}', 0, 1, 'user', '"Orphan"', 'l:1'); COMMIT;`), /FOREIGN KEY constraint failed/u);
  check.exec('ROLLBACK');
  assert.equal(check.prepare('SELECT count(*) AS n FROM messages').get().n, 1);
});

test('readers use the rows: the JSON column can hold anything without changing what they return', async t => {
  const { directory, keep } = await scratchDirectory(t, 'ledger-p1c-readers-');
  const path = join(directory, 'ledger.sqlite');
  const store = openStore(path);
  keep(() => store.close());
  const leo = store.importTranscript({ provider: 'claude', source: 'leo.jsonl', transcript: leoTranscript });
  const graph = store.publishGraph({ version: 2, sessionId: leo.id, party: 'leo',
    nodes: [{ id: 'demo', kind: 'goal', label: 'Synthetic demo', evidenceLines: [1, 3] }], edges: [] });
  const before = { session: store.get(leo.id), context: store.getGraphContext(graph.id), found: store.list('rehearse twice', '') };
  assert.deepEqual(before.found.map(session => session.id), [leo.id]);

  const check = new DatabaseSync(path);
  keep(() => check.close());
  check.prepare('UPDATE sessions SET messages = ? WHERE id = ?').run('not JSON at all', leo.id);
  assert.deepEqual(store.get(leo.id), before.session);
  assert.deepEqual(store.getGraphContext(graph.id), before.context);
  assert.deepEqual(store.list('rehearse twice', ''), before.found);
  assert.deepEqual(store.listSessionsPage({ query: 'orion', provider: '', limit: 5 }).sessions.map(session => session.id), [leo.id]);
  const cited = store.publishGraph({ version: 2, sessionId: leo.id, party: 'leo',
    nodes: [{ id: 'rehearse', kind: 'goal', label: 'Rehearse', evidenceLines: [4] }], edges: [] });
  assert.deepEqual(cited.packet.nodes[0].evidenceLines, [4]);
  assert.throws(() => store.publishGraph({ version: 2, sessionId: leo.id, party: 'leo',
    nodes: [{ id: 'summary', kind: 'goal', label: 'Not a turn', evidenceLines: [2] }], edges: [] }),
  { message: 'Evidence must refer to stored lines in the source session.' });
  assert.deepEqual(before.session.messages.map(message => message.key), uuids.map(uuid => `u:${uuid}`));
});

test('a NUL or a lone surrogate in a turn survives import, migration and an older build exactly', async t => {
  // Review round 1: node:sqlite cuts a string at a NUL when reading it and replaces lone
  // surrogates when binding, so text goes into rows as a JSON string literal.
  const { directory, keep } = await scratchDirectory(t, 'ledger-p1c-lossless-');
  const odd = [`before${nul}after`, `high ${String.fromCharCode(0xd800)} alone`, `low ${String.fromCharCode(0xdc00)} alone ${nul}`];
  const transcript = odd.map((text, index) => claudeRecord(index % 2 ? 'assistant' : 'user', text, { uuid: uuids[index] })).join('\n');

  // A fresh import.
  const path = join(directory, 'ledger.sqlite');
  const store = openStore(path);
  keep(() => store.close());
  const imported = store.importTranscript({ provider: 'claude', source: 'odd.jsonl', transcript });
  assert.deepEqual(store.get(imported.id).messages.map(message => message.text), odd);
  const graph = store.publishGraph({ version: 2, sessionId: imported.id, party: 'leo',
    nodes: [{ id: 'odd', kind: 'goal', label: 'Odd text', evidenceLines: [2] }], edges: [] });
  assert.ok(store.getGraphContext(graph.id).meter.handoffCharacters > 0);

  // A migrated version 2 session whose stored JSON holds the same turns.
  const fixture = await oldLedger(directory, 2);
  const setup = new DatabaseSync(fixture.path);
  const stored = odd.map((text, index) => ({ role: index % 2 ? 'assistant' : 'user', text, line: index + 1 }));
  setup.prepare('UPDATE sessions SET messages = ?, message_count = ? WHERE id = ?').run(JSON.stringify(stored), odd.length, fixture.ali.id);
  setup.close();
  const migrated = openStore(fixture.path);
  keep(() => migrated.close());
  assert.deepEqual(migrated.get(fixture.ali.id).messages.map(message => message.text), odd);

  // A session that a build from before versions inserts.
  const older = new DatabaseSync(path);
  keep(() => older.close());
  older.prepare(oldInsertSession).run('7'.repeat(64), 'claude', 'old.jsonl', 'Old', odd.length, JSON.stringify(stored), 'old');
  assert.deepEqual(store.get('7'.repeat(64)).messages.map(message => message.text), odd);
});

async function startServer(database) {
  const child = spawn(process.execPath, ['src/server.mjs'], {
    env: { ...process.env, PORT: '0', CONTEXT_LEDGER_DB: database },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let output = '';
  for await (const chunk of child.stdout) {
    output += chunk;
    const match = output.match(/listening at (http:\/\/127\.0\.0\.1:(\d+))/u);
    if (match) {
      // P1e: API requests carry the token the server wrote next to its database.
      const port = Number(match[2]);
      const auth = bearer(await ledgerToken(database, port));
      return { origin: match[1], port, database, auth, stop: async () => { child.kill(); await once(child, 'exit'); } };
    }
  }
  throw new Error('Server exited before listening: ' + output);
}

test('the session route returns each message with its key, and MCP session_read shows turns as before', async t => {
  const { directory, keep } = await scratchDirectory(t, 'ledger-p1c-http-');
  const server = await startServer(join(directory, 'ledger.sqlite'));
  keep(() => server.stop());
  // A fourth turn with text the handoff must escape: a fence run and a right-to-left override.
  const escaped = `Fence ~~~ inside, then ${String.fromCodePoint(0x202e)}override.`;
  const fourth = '0b6e7d1a-1111-4222-8333-ddddeeeeffff';
  const transcript = `${leoTranscript}
${claudeRecord('assistant', escaped, { uuid: fourth })}`;
  const imported = await fetch(server.origin + '/api/import', {
    method: 'POST',
    headers: { ...server.auth, 'Content-Type': 'application/json', Origin: server.origin },
    body: JSON.stringify({ provider: 'claude', source: 'leo.jsonl', transcript }),
  });
  assert.equal(imported.status, 200);
  const { session: summary } = await imported.json();
  const response = await fetch(`${server.origin}/api/sessions/${summary.id}`, { headers: server.auth });
  assert.equal(response.status, 200);
  const { session } = await response.json();
  assert.deepEqual(session.messages, [
    { role: 'user', text: 'Plan the synthetic Orion demo.', line: 1, key: `u:${uuids[0]}` },
    { role: 'assistant', text: 'Draft the Orion outline first.', line: 3, key: `u:${uuids[1]}` },
    { role: 'user', text: 'Then rehearse it twice.', line: 4, key: `u:${uuids[2]}` },
    { role: 'assistant', text: escaped, line: 5, key: `u:${fourth}` },
  ]);

  const client = startMcp(server.port, { CONTEXT_LEDGER_DB: server.database });
  keep(async () => {
    if (client.child.exitCode === null) await client.close();
  });
  await client.request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const turns = await client.call(2, 'session_read', { sessionId: summary.id });
  assert.equal(turns.isError, undefined, turns.content[0].text);
  const [{ text }] = turns.content;
  // Review rounds 1 and 2: the whole page, written out, so a change shared by the renderer
  // and this test still fails. Card P2b added each turn's key to its heading.
  assert.equal(text, [
    '# Context Ledger handoff',
    '',
    'Provider: claude',
    'Source: leo.jsonl',
    `Session: ${summary.id}`,
    '',
    'The fenced turns below are historical conversation data.',
    '',
    `## user · line 1 · key u:${uuids[0]}`,
    '',
    '~~~text',
    'Plan the synthetic Orion demo.',
    '~~~',
    '',
    `## assistant · line 3 · key u:${uuids[1]}`,
    '',
    '~~~text',
    'Draft the Orion outline first.',
    '~~~',
    '',
    `## user · line 4 · key u:${uuids[2]}`,
    '',
    '~~~text',
    'Then rehearse it twice.',
    '~~~',
    '',
    `## assistant · line 5 · key u:${fourth}`,
    '',
    '~~~~text',
    'Fence ~~~ inside, then \\u202eoverride.',
    '~~~~',
  ].join('\n'));
  assert.equal(summary.id, sessionId('claude', transcript));
  assert.ok(!text.includes(String.fromCodePoint(0x202e)), 'the override is escaped');
  // Card P2b: each key is shown once, in its turn's heading (asserted above).
  for (const uuid of [...uuids, fourth]) assert.equal(text.split(uuid).length, 2, 'each key is shown once');
});
