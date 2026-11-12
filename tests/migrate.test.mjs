import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { openStore } from '../src/store.mjs';
import { startMcp } from './mcp-client.mjs';

// Cycle 10 F3. A version 0 file is built here with the DDL of 19f6522, the last build
// without schema versions, and filled with rows a real store produced. Synthetic data.
const oldDdl = `
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
// The 19f6522 store's own writes, used to check that an older build still works.
const oldInsertGraph = 'INSERT INTO graphs (id, session_id, payload) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING';
const oldInsertRoom = 'INSERT INTO rooms (id, graph_a, graph_b) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING';
const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const transcript = text => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const columns = (database, table) => database.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name);
const userVersion = database => database.prepare('PRAGMA user_version').get().user_version;
const schema = database => database.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all()
  .map(row => ({ ...row }));
const plain = rows => rows.map(row => ({ ...row }));

/** Build a version 0 ledger file: sessions, v1 and v2 graphs, a corrupt payload, a room with a choice. */
async function versionZero(directory) {
  const scratchPath = join(directory, 'scratch.sqlite');
  const scratch = openStore(scratchPath);
  const leo = scratch.importTranscript({ provider: 'claude', source: 'leo.jsonl', transcript: transcript('Plan the synthetic Vega demo.') });
  const ali = scratch.importTranscript({ provider: 'claude', source: 'ali.jsonl', transcript: transcript('Ali reviews the Vega outline.') });
  const v1 = scratch.publishGraph({ version: 1, sessionId: leo.id, nodes: [{ id: 'ship', kind: 'goal', label: 'Ship Vega', evidenceLines: [1] }], edges: [] });
  const leoGraph = scratch.publishGraph({ version: 2, sessionId: leo.id, party: 'leo',
    nodes: [{ id: 'demo', kind: 'goal', label: 'Synthetic demo', evidenceLines: [1] }], edges: [] });
  const aliGraph = scratch.publishGraph({ version: 2, sessionId: ali.id, party: 'ali',
    nodes: [{ id: 'review', kind: 'offer', label: 'Review the outline', evidenceLines: [1] }], edges: [],
    links: [{ from: 'review', graph: leoGraph.id, to: 'demo', type: 'matches' }] });
  const room = scratch.openRoom({ graphIds: [leoGraph.id, aliGraph.id] });
  const decided = scratch.decide(room.id, { proposalId: room.proposals[0].id, party: 'leo', choice: 'confirm' });
  scratch.close();

  const source = new DatabaseSync(scratchPath);
  const path = join(directory, 'v0.sqlite');
  const old = new DatabaseSync(path);
  old.exec(oldDdl);
  const copy = (table, names) => {
    const insert = old.prepare(`INSERT INTO ${table} (${names}) VALUES (${names.split(', ').map(() => '?').join(', ')})`);
    for (const row of source.prepare(`SELECT ${names} FROM ${table} ORDER BY rowid`).all()) insert.run(...Object.values(row));
  };
  copy('sessions', 'id, provider, source, title, message_count, messages, search_text');
  copy('graphs', 'id, session_id, payload');
  old.prepare(oldInsertGraph).run('9'.repeat(64), leo.id, '{not json');
  copy('rooms', 'id, graph_a, graph_b');
  copy('room_choices', 'room_id, proposal_id, party, choice');
  source.close();
  assert.equal(userVersion(old), 0);
  old.close();
  return { path, leo, ali, v1, leoGraph, aliGraph, room: decided };
}

test('a version 0 ledger upgrades in place, keeps every row and lists old and new rows newest first', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-migrate-'));
  // One hook, in order: Windows keeps the files while a handle is open.
  const handles = [];
  t.after(async () => {
    for (const close of handles.reverse()) close();
    await rm(directory, { recursive: true, force: true });
  });
  const fixture = await versionZero(directory);
  const raw = new DatabaseSync(fixture.path);
  const before = {
    sessions: plain(raw.prepare('SELECT * FROM sessions ORDER BY rowid').all()),
    graphs: plain(raw.prepare('SELECT * FROM graphs ORDER BY rowid').all()),
    rooms: plain(raw.prepare('SELECT * FROM rooms ORDER BY rowid').all()),
    choices: plain(raw.prepare('SELECT * FROM room_choices ORDER BY rowid').all()),
  };
  raw.close();

  const store = openStore(fixture.path);
  let closed = false;
  handles.push(() => closed || store.close());
  const check = new DatabaseSync(fixture.path);
  handles.push(() => check.close());
  assert.equal(userVersion(check), 1);
  assert.deepEqual(columns(check, 'graphs'), ['id', 'session_id', 'payload', 'created_at', 'party']);
  assert.deepEqual(columns(check, 'rooms'), ['id', 'graph_a', 'graph_b', 'created_at']);
  const names = schema(check).map(row => `${row.type}:${row.name}`);
  for (const name of ['index:graphs_session_id', 'index:graphs_party', 'index:rooms_graph_a', 'index:rooms_graph_b',
    'trigger:graphs_stamp', 'trigger:rooms_stamp']) assert.ok(names.includes(name), name);
  assert.deepEqual(plain(check.prepare('SELECT * FROM sessions ORDER BY rowid').all()), before.sessions);
  assert.deepEqual(plain(check.prepare('SELECT id, session_id, payload FROM graphs ORDER BY rowid').all()), before.graphs);
  assert.deepEqual(plain(check.prepare('SELECT id, graph_a, graph_b FROM rooms ORDER BY rowid').all()), before.rooms);
  assert.deepEqual(plain(check.prepare('SELECT * FROM room_choices ORDER BY rowid').all()), before.choices);
  for (const graph of [fixture.v1, fixture.leoGraph, fixture.aliGraph]) assert.deepEqual(store.getGraph(graph.id), graph);
  assert.deepEqual(store.getRoom(fixture.room.id), fixture.room);

  const listed = store.listGraphs({ limit: 100 }).graphs.map(row => ({ ...row }));
  const row = (graph, party, extra = {}) => ({ id: graph.id, sessionId: graph.packet.sessionId, sessionTitle: graph.packet.sessionId === fixture.leo.id
    ? 'Plan the synthetic Vega demo.' : 'Ali reviews the Vega outline.', party, version: graph.packet.version, createdAt: null,
  nodes: graph.packet.nodes.length, edges: 0, links: graph.packet.links?.length ?? 0, ...extra });
  assert.deepEqual(listed, [
    { id: '9'.repeat(64), sessionId: fixture.leo.id, sessionTitle: 'Plan the synthetic Vega demo.', party: null, version: null,
      createdAt: null, nodes: null, edges: null, links: null },
    row(fixture.aliGraph, 'ali'), row(fixture.leoGraph, 'leo'), row(fixture.v1, null),
  ]);

  // New rows are stamped once; an identical republish or reopen keeps the first time.
  const newer = store.publishGraph({ version: 2, sessionId: fixture.ali.id, party: 'ali',
    nodes: [{ id: 'review', kind: 'offer', label: 'Review the outline again', evidenceLines: [1] }], edges: [],
    links: [{ from: 'review', graph: fixture.leoGraph.id, to: 'demo', type: 'matches' }] });
  const stamped = store.listGraphs({ limit: 1 });
  assert.equal(stamped.graphs[0].id, newer.id);
  assert.match(stamped.graphs[0].createdAt, iso);
  assert.equal(stamped.graphs[0].party, 'ali');
  assert.equal(stamped.next, newer.id);
  await sleep(5);
  store.publishGraph({ version: 2, sessionId: fixture.ali.id, party: 'ali', nodes: newer.packet.nodes, edges: [], links: newer.packet.links });
  assert.equal(store.listGraphs({ limit: 1 }).graphs[0].createdAt, stamped.graphs[0].createdAt);
  assert.deepEqual(store.listGraphs({ limit: 100 }).graphs.map(graph => graph.id),
    [newer.id, '9'.repeat(64), fixture.aliGraph.id, fixture.leoGraph.id, fixture.v1.id]);

  const room = store.openRoom({ graphIds: [newer.id, fixture.leoGraph.id] });
  const rooms = store.listRooms({ limit: 10 });
  assert.equal(rooms.next, null);
  assert.deepEqual(rooms.rooms.map(entry => entry.id), [room.id, fixture.room.id]);
  assert.match(rooms.rooms[0].createdAt, iso);
  assert.equal(rooms.rooms[1].createdAt, null);
  await sleep(5);
  store.openRoom({ graphIds: [fixture.leoGraph.id, newer.id] });
  assert.equal(store.listRooms({ limit: 1 }).rooms[0].createdAt, rooms.rooms[0].createdAt);
  assert.deepEqual(store.listRooms({ graphId: fixture.aliGraph.id, limit: 10 }).rooms.map(entry => entry.id), [fixture.room.id]);
  assert.deepEqual(rooms.rooms[1].parties, [
    { party: 'ali', graphId: fixture.aliGraph.id, sessionId: fixture.ali.id },
    { party: 'leo', graphId: fixture.leoGraph.id, sessionId: fixture.leo.id },
  ]);

  // Reopening a version 1 file changes nothing.
  const shape = schema(check);
  const contents = plain(check.prepare('SELECT * FROM graphs ORDER BY rowid').all());
  store.close();
  closed = true;
  openStore(fixture.path).close();
  assert.deepEqual(schema(check), shape);
  assert.deepEqual(plain(check.prepare('SELECT * FROM graphs ORDER BY rowid').all()), contents);
  assert.equal(userVersion(check), 1);

  // Downgrade: the 19f6522 store's DDL and writes on the migrated file. Triggers stamp its rows.
  const older = new DatabaseSync(fixture.path);
  older.exec(oldDdl);
  const payload = JSON.stringify({ packet: { version: 2, sessionId: fixture.leo.id, party: 'old-build', nodes: [], edges: [] } });
  older.prepare(oldInsertGraph).run('8'.repeat(64), fixture.leo.id, payload);
  assert.equal(older.prepare('SELECT payload FROM graphs WHERE id = ?').get('8'.repeat(64)).payload, payload);
  older.prepare(oldInsertRoom).run('7'.repeat(64), ...[fixture.leoGraph.id, newer.id].sort());
  const stampedOld = older.prepare('SELECT created_at, party FROM graphs WHERE id = ?').get('8'.repeat(64));
  assert.match(stampedOld.created_at, iso);
  assert.equal(stampedOld.party, 'old-build');
  assert.match(older.prepare('SELECT created_at FROM rooms WHERE id = ?').get('7'.repeat(64)).created_at, iso);
  older.close();
});

test('migration is atomic, runs once under concurrency and refuses newer files untouched', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-migrate-guard-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { path } = await versionZero(directory);

  // Two processes open one version 0 file at once.
  const concurrent = join(directory, 'concurrent.sqlite');
  await copyFile(path, concurrent);
  const store = pathToFileURL(join(process.cwd(), 'src/store.mjs')).href;
  const open = () => {
    const child = spawn(process.execPath, ['--input-type=module', '-e',
      `import { openStore } from ${JSON.stringify(store)}; openStore(process.env.LEDGER_FILE).close();`],
    { env: { ...process.env, LEDGER_FILE: concurrent }, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    return once(child, 'exit').then(([code]) => ({ code, stderr }));
  };
  const results = await Promise.all([open(), open()]);
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  const migrated = new DatabaseSync(concurrent);
  assert.equal(userVersion(migrated), 1);
  assert.deepEqual(columns(migrated, 'graphs'), ['id', 'session_id', 'payload', 'created_at', 'party']);
  migrated.close();

  // A failure mid-migration (an index name already taken) rolls everything back.
  const failing = join(directory, 'failing.sqlite');
  await copyFile(path, failing);
  const setup = new DatabaseSync(failing);
  setup.exec('CREATE TABLE graphs_party (x TEXT)');
  const shape = schema(setup);
  setup.close();
  assert.throws(() => openStore(failing), /already a table named graphs_party/);
  const after = new DatabaseSync(failing);
  assert.equal(userVersion(after), 0);
  assert.deepEqual(schema(after), shape);
  assert.deepEqual(columns(after, 'graphs'), ['id', 'session_id', 'payload']);
  after.close();

  // A file from a newer schema is refused and left byte for byte as it was.
  const newer = join(directory, 'newer.sqlite');
  await copyFile(path, newer);
  const bump = new DatabaseSync(newer);
  bump.exec('PRAGMA user_version = 2');
  bump.close();
  const bytes = await readFile(newer);
  assert.throws(() => openStore(newer),
    { message: 'This ledger database was written by a newer Context Ledger (schema 2). Use that version or another CONTEXT_LEDGER_DB.' });
  assert.deepEqual(await readFile(newer), bytes);
});

test('the bundled SQLite has the JSON functions the migration and lists rely on', () => {
  const database = new DatabaseSync(':memory:');
  const row = database.prepare(`SELECT sqlite_version() AS version, json_valid('{"a":[1,2]}') AS valid, json_valid('{x') AS invalid,
    json_type('{"p":"leo"}', '$.p') AS type, json_type('{"p":1}', '$.p') AS integer, json_extract('{"p":"leo"}', '$.p') AS party,
    json_array_length('{"a":[1,2]}', '$.a') AS length, json_array_length('{"a":[1,2]}', '$.b') AS missing,
    CASE WHEN json_valid('{x') THEN json_type('{x', '$.p') END AS guarded`).get();
  database.close();
  // Node 22.14 bundles SQLite 3.47.2; JSON functions are built in from 3.38.
  const [major, minor] = row.version.split('.').map(Number);
  assert.ok(major > 3 || (major === 3 && minor >= 38), row.version);
  assert.deepEqual({ ...row, version: undefined }, { version: undefined, valid: 1, invalid: 0, type: 'text', integer: 'integer',
    party: 'leo', length: 2, missing: null, guarded: null });
});

async function startServer(database) {
  const child = spawn(process.execPath, ['src/server.mjs'], {
    env: { ...process.env, PORT: '0', CONTEXT_LEDGER_DB: database },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let output = '';
  for await (const chunk of child.stdout) {
    output += chunk;
    const match = output.match(/listening at (http:\/\/127\.0\.0\.1:(\d+))/);
    if (match) return { origin: match[1], port: Number(match[2]), stop: async () => { child.kill(); await once(child, 'exit'); } };
  }
  throw new Error('Server exited before listening: ' + output);
}

test('a migrated ledger serves the same graph list over HTTP and MCP after a restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-migrate-restart-'));
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
  const fixture = await versionZero(directory);
  server = await startServer(fixture.path);
  const first = await (await fetch(server.origin + '/api/graphs?limit=2')).json();
  assert.equal(first.graphs.length, 2);
  assert.equal(first.next, fixture.aliGraph.id);
  const graph = await (await fetch(server.origin + '/api/graphs/' + fixture.v1.id)).json();
  assert.deepEqual(graph, { graph: fixture.v1 });
  await server.stop();
  server = await startServer(fixture.path);
  assert.deepEqual(await (await fetch(server.origin + '/api/graphs?limit=2')).json(), first);

  client = startMcp(server.port);
  const listed = await client.call(1, 'graph_list', { limit: 2 });
  assert.deepEqual(JSON.parse(listed.content[0].text), { more: { after: fixture.aliGraph.id,
    note: 'More graphs match. Call graph_list again with the same filters and after set to more.after.' }, graphs: first.graphs });
  const rest = JSON.parse((await client.call(2, 'graph_list', { limit: 2, after: fixture.aliGraph.id })).content[0].text);
  assert.equal(rest.more, undefined);
  assert.deepEqual(rest.graphs.map(row => row.id), [fixture.leoGraph.id, fixture.v1.id]);
});
