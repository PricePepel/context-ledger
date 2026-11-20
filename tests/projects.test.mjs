import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { defaultProject, schemaVersion } from '../src/migrate.mjs';
import { InputError, openStore } from '../src/store.mjs';
import { bearer, ledgerToken } from './ledger-auth.mjs';

// Card P1b: projects as schema version 2 (docs/evals.md, "P1b — Projects"). Synthetic data.

// The DDL of 19f6522, the last build without schema versions (as in tests/migrate.test.mjs).
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
// What version 1 (main 3a17536) adds on top. Its triggers are created after the rows are
// copied, so the copied created_at and party values are kept as they were.
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
  PRAGMA user_version = 1;
`;
// The 19f6522 session insert, which names no project.
const oldInsertSession = `INSERT INTO sessions (id, provider, source, title, message_count, messages, search_text)
  VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`;
const sessionColumns = 'id, provider, source, title, message_count, messages, search_text';
const slugRule = 'Project must be a slug of at most 64 lowercase letters, digits and single hyphens.';
const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

const claude = text => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
const codex = text => JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
const userVersion = database => database.prepare('PRAGMA user_version').get().user_version;
// The P1b tests were written at version 2; P1c (version 3) makes them relative to the current version.
const newerVersion = schemaVersion + 1;
const newerMessage = new RegExp(`written by a newer Context Ledger \\(schema ${newerVersion}\\)`, 'u');
const columns = database => database.prepare('PRAGMA table_info(sessions)').all().map(column => column.name);
const schema = database => database.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY type, name').all().map(row => ({ ...row }));
const plain = rows => rows.map(row => ({ ...row }));
const rows = (database, sql) => plain(database.prepare(sql).all());
const projectRows = database => rows(database, 'SELECT id, slug, name FROM projects ORDER BY rowid');

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

/** A version 0 or version 1 ledger file with two sessions, three graphs and a decided room. */
async function oldLedger(directory, version) {
  const scratchPath = join(directory, `scratch-${version}.sqlite`);
  const scratch = openStore(scratchPath);
  const leo = scratch.importTranscript({ provider: 'claude', source: 'leo.jsonl', transcript: claude('Plan the synthetic Orion demo.') });
  const ali = scratch.importTranscript({ provider: 'codex', source: 'ali.jsonl', transcript: codex('Ali reviews the Orion outline.') });
  const v1 = scratch.publishGraph({ version: 1, sessionId: leo.id, nodes: [{ id: 'ship', kind: 'goal', label: 'Ship Orion', evidenceLines: [1] }], edges: [] });
  const leoGraph = scratch.publishGraph({ version: 2, sessionId: leo.id, party: 'leo',
    nodes: [{ id: 'demo', kind: 'goal', label: 'Synthetic demo', evidenceLines: [1] }], edges: [] });
  const aliGraph = scratch.publishGraph({ version: 2, sessionId: ali.id, party: 'ali',
    nodes: [{ id: 'review', kind: 'offer', label: 'Review the outline', evidenceLines: [1] }], edges: [],
    links: [{ from: 'review', graph: leoGraph.id, to: 'demo', type: 'matches' }] });
  const opened = scratch.openRoom({ graphIds: [leoGraph.id, aliGraph.id] });
  const room = scratch.decide(opened.id, { proposalId: opened.proposals[0].id, party: 'leo', choice: 'confirm' });
  scratch.close();

  const source = new DatabaseSync(scratchPath);
  const path = join(directory, `v${version}.sqlite`);
  const old = new DatabaseSync(path);
  old.exec(versionZeroDdl);
  if (version === 1) old.exec(versionOneColumns);
  const copy = (table, names) => {
    const insert = old.prepare(`INSERT INTO ${table} (${names}) VALUES (${names.split(', ').map(() => '?').join(', ')})`);
    for (const row of source.prepare(`SELECT ${names} FROM ${table} ORDER BY rowid`).all()) insert.run(...Object.values(row));
  };
  copy('sessions', sessionColumns);
  copy('graphs', version === 1 ? 'id, session_id, payload, created_at, party' : 'id, session_id, payload');
  copy('rooms', version === 1 ? 'id, graph_a, graph_b, created_at' : 'id, graph_a, graph_b');
  copy('room_choices', 'room_id, proposal_id, party, choice');
  source.close();
  if (version === 1) old.exec(versionOneTriggers);
  assert.equal(userVersion(old), version);
  assert.ok(!columns(old).includes('project_id'));
  old.close();
  // Summaries as a version 2 store returns them for the default project.
  return { path, leo, ali, v1, leoGraph, aliGraph, room };
}

test('a version 1 ledger becomes version 2 in place and every session joins the default project', async t => {
  const { directory, keep } = await scratchDirectory(t, 'ledger-p1b-v1-');
  const fixture = await oldLedger(directory, 1);
  const raw = new DatabaseSync(fixture.path);
  const before = {
    sessions: rows(raw, `SELECT ${sessionColumns} FROM sessions ORDER BY rowid`),
    graphs: rows(raw, 'SELECT * FROM graphs ORDER BY rowid'),
    rooms: rows(raw, 'SELECT * FROM rooms ORDER BY rowid'),
    choices: rows(raw, 'SELECT * FROM room_choices ORDER BY rowid'),
  };
  raw.close();
  assert.ok(before.graphs.every(graph => graph.created_at), 'the version 1 rows carry their stamps');

  const store = openStore(fixture.path);
  let closed = false;
  keep(() => closed || store.close());
  const check = new DatabaseSync(fixture.path);
  keep(() => check.close());
  assert.ok(schemaVersion >= 2);
  assert.equal(defaultProject, 'default');
  assert.equal(userVersion(check), schemaVersion);
  assert.deepEqual(rows(check, 'PRAGMA table_info(projects)').map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk })), [
    { name: 'id', type: 'TEXT', notnull: 1, pk: 1 },
    { name: 'slug', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'name', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'created_at', type: 'TEXT', notnull: 1, pk: 0 },
  ]);
  assert.ok(rows(check, 'PRAGMA index_list(projects)').some(index => index.unique === 1 && index.origin === 'u'), 'slug is unique');
  assert.deepEqual(columns(check), [...sessionColumns.split(', '), 'project_id']);
  assert.deepEqual(rows(check, 'PRAGMA foreign_key_list(sessions)').map(({ table, from, to }) => ({ table, from, to })),
    [{ table: 'projects', from: 'project_id', to: 'id' }]);
  const names = schema(check).map(row => `${row.type}:${row.name}`);
  for (const name of ['table:projects', 'index:sessions_project_id', 'trigger:sessions_project', 'trigger:graphs_stamp', 'trigger:rooms_stamp']) {
    assert.ok(names.includes(name), name);
  }

  // One default project; every session is in it and every other row is as it was.
  const projects = projectRows(check);
  assert.equal(projects.length, 1);
  assert.match(projects[0].id, /^[a-f0-9]{32}$/u);
  assert.deepEqual({ slug: projects[0].slug, name: projects[0].name }, { slug: 'default', name: 'Default' });
  assert.match(check.prepare('SELECT created_at FROM projects').get().created_at, iso);
  assert.deepEqual(rows(check, 'SELECT DISTINCT project_id FROM sessions'), [{ project_id: projects[0].id }]);
  assert.deepEqual(rows(check, `SELECT ${sessionColumns} FROM sessions ORDER BY rowid`), before.sessions);
  assert.deepEqual(rows(check, 'SELECT * FROM graphs ORDER BY rowid'), before.graphs);
  assert.deepEqual(rows(check, 'SELECT * FROM rooms ORDER BY rowid'), before.rooms);
  assert.deepEqual(rows(check, 'SELECT * FROM room_choices ORDER BY rowid'), before.choices);
  for (const graph of [fixture.v1, fixture.leoGraph, fixture.aliGraph]) assert.deepEqual(store.getGraph(graph.id), graph);
  assert.deepEqual(store.getRoom(fixture.room.id), fixture.room);
  assert.deepEqual(plain(store.list('', '')), [{ ...fixture.ali }, { ...fixture.leo }]);
  assert.deepEqual(plain(store.list('', '', 'default')), [{ ...fixture.ali }, { ...fixture.leo }]);
  assert.equal(store.get(fixture.leo.id).project, 'default');

  // Reopening a version 2 file changes nothing.
  const shape = schema(check);
  const contents = { sessions: rows(check, 'SELECT * FROM sessions ORDER BY rowid'), projects: rows(check, 'SELECT * FROM projects') };
  store.close();
  closed = true;
  openStore(fixture.path).close();
  assert.deepEqual(schema(check), shape);
  assert.deepEqual({ sessions: rows(check, 'SELECT * FROM sessions ORDER BY rowid'), projects: rows(check, 'SELECT * FROM projects') }, contents);
  assert.equal(userVersion(check), schemaVersion);

  // The 19f6522 insert names no project; the trigger puts the session in the default one.
  const older = new DatabaseSync(fixture.path);
  keep(() => older.close());
  older.exec(versionZeroDdl);
  older.prepare(oldInsertSession).run('6'.repeat(64), 'claude', 'old.jsonl', 'Old build', 1, '[]', 'old build');
  assert.equal(older.prepare('SELECT project_id FROM sessions WHERE id = ?').get('6'.repeat(64)).project_id, projects[0].id);
});

test('an unversioned ledger goes straight to version 2', async t => {
  const { directory, keep } = await scratchDirectory(t, 'ledger-p1b-v0-');
  const fixture = await oldLedger(directory, 0);
  const store = openStore(fixture.path);
  keep(() => store.close());
  const check = new DatabaseSync(fixture.path);
  keep(() => check.close());
  assert.equal(userVersion(check), schemaVersion);
  assert.deepEqual(rows(check, 'PRAGMA table_info(graphs)').map(column => column.name), ['id', 'session_id', 'payload', 'created_at', 'party']);
  assert.deepEqual(projectRows(check).map(project => project.slug), ['default']);
  assert.equal(check.prepare('SELECT count(*) AS n FROM sessions WHERE project_id IS NULL').get().n, 0);
  assert.deepEqual(plain(store.list('', '', 'default')).map(session => session.id), [fixture.ali.id, fixture.leo.id]);
  assert.equal(store.listGraphs({ party: 'ali', limit: 5 }).graphs[0].id, fixture.aliGraph.id);
});

test('the version 2 step is safe to repeat, atomic, and newer files are refused untouched', async t => {
  const { directory } = await scratchDirectory(t, 'ledger-p1b-guard-');
  const { path } = await oldLedger(directory, 1);

  // A step that already ran: projects and its default row exist, the version is still 1.
  const repeated = join(directory, 'repeated.sqlite');
  await copyFile(path, repeated);
  const partial = new DatabaseSync(repeated);
  partial.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
    INSERT INTO projects VALUES ('${'a'.repeat(32)}', 'default', 'Default', '2026-11-17T00:00:00.000Z');`);
  partial.close();
  openStore(repeated).close();
  const afterRepeat = new DatabaseSync(repeated);
  assert.equal(userVersion(afterRepeat), schemaVersion);
  assert.deepEqual(projectRows(afterRepeat), [{ id: 'a'.repeat(32), slug: 'default', name: 'Default' }]);
  assert.deepEqual(rows(afterRepeat, 'SELECT DISTINCT project_id FROM sessions'), [{ project_id: 'a'.repeat(32) }]);
  afterRepeat.close();

  // A failure inside the step (the index name is taken) rolls back to version 1 as it was.
  const failing = join(directory, 'failing.sqlite');
  await copyFile(path, failing);
  const setup = new DatabaseSync(failing);
  setup.exec('CREATE TABLE sessions_project_id (x TEXT)');
  const shape = schema(setup);
  setup.close();
  assert.throws(() => openStore(failing), /already a table named sessions_project_id/u);
  const afterFailure = new DatabaseSync(failing);
  assert.equal(userVersion(afterFailure), 1);
  assert.deepEqual(schema(afterFailure), shape);
  assert.deepEqual(columns(afterFailure), sessionColumns.split(', '));
  afterFailure.close();

  // Version 3 is refused and left byte for byte as it was.
  const newer = join(directory, 'newer.sqlite');
  await copyFile(path, newer);
  const bump = new DatabaseSync(newer);
  bump.exec(`PRAGMA user_version = ${newerVersion}`);
  bump.close();
  const bytes = await readFile(newer);
  assert.throws(() => openStore(newer),
    { message: `This ledger database was written by a newer Context Ledger (schema ${newerVersion}). Use that version or another CONTEXT_LEDGER_DB.` });
  assert.ok((await readFile(newer)).equals(bytes), 'the newer file is unchanged');

  // Review round 1: a newer file whose schema no longer has the legacy tables gets no DDL
  // before it is refused (openStore used to create sessions, graphs and rooms first).
  const reshaped = join(directory, 'reshaped.sqlite');
  const future = new DatabaseSync(reshaped);
  future.exec(`CREATE TABLE messages (id INTEGER PRIMARY KEY, text TEXT NOT NULL) STRICT; PRAGMA user_version = ${newerVersion};`);
  future.close();
  const reshapedBytes = await readFile(reshaped);
  assert.throws(() => openStore(reshaped), newerMessage);
  // Compared with equals: a deepEqual diff of two database files can exhaust the heap.
  assert.ok((await readFile(reshaped)).equals(reshapedBytes), 'the reshaped file is unchanged');
  const reopened = new DatabaseSync(reshaped);
  assert.deepEqual(rows(reopened, "SELECT name FROM sqlite_master WHERE type = 'table'"), [{ name: 'messages' }]);
  reopened.close();
});

test('a current file opens without the write lock while another connection holds it', async t => {
  // Review round 3: the lock is taken only when a migration may run, so a writer holding
  // it does not stall or fail a store opening a version 2 file.
  const { directory, keep } = await scratchDirectory(t, 'ledger-p1b-lockfree-');
  const path = join(directory, 'ledger.sqlite');
  const first = openStore(path);
  first.importTranscript({ provider: 'claude', source: 'held.jsonl', transcript: claude('Held lock.'), project: 'acme' });
  first.close();
  const holder = new DatabaseSync(path);
  keep(() => holder.close());
  holder.exec('BEGIN IMMEDIATE');
  keep(() => holder.exec('ROLLBACK'));
  const started = Date.now();
  const store = openStore(path);
  keep(() => store.close());
  assert.ok(Date.now() - started < 2000, `opening took ${Date.now() - started} ms`);
  assert.deepEqual(plain(store.list('', '', 'acme')).map(session => session.source), ['held.jsonl']);
});

test('a failed session insert leaves no new project behind and the store keeps working', async t => {
  // Review round 1, finding 3: the project and the session commit together or not at all.
  const { directory, keep } = await scratchDirectory(t, 'ledger-p1b-rollback-');
  const path = join(directory, 'ledger.sqlite');
  const store = openStore(path);
  keep(() => store.close());
  const check = new DatabaseSync(path);
  keep(() => check.close());
  check.exec("CREATE TRIGGER test_refuse BEFORE INSERT ON sessions WHEN NEW.source = 'refused.jsonl' BEGIN SELECT RAISE(ABORT, 'refused for the test'); END;");
  assert.throws(() => store.importTranscript({ provider: 'claude', source: 'refused.jsonl', transcript: claude('Never stored.'), project: 'fresh' }),
    /refused for the test/u);
  assert.deepEqual(rows(check, 'SELECT slug FROM projects ORDER BY rowid'), [{ slug: 'default' }]);
  assert.equal(check.prepare('SELECT count(*) AS n FROM sessions').get().n, 0);
  // No transaction was left open: the next import commits and another connection sees it.
  const next = store.importTranscript({ provider: 'claude', source: 'kept.jsonl', transcript: claude('Stored.'), project: 'fresh' });
  assert.equal(next.project, 'fresh');
  assert.deepEqual(rows(check, 'SELECT slug FROM projects ORDER BY rowid'), [{ slug: 'default' }, { slug: 'fresh' }]);
});

test('two processes racing to import the same bytes into two projects create only the winner\'s project', async t => {
  // Review rounds 1 and 2. Each child stops at its import's BEGIN IMMEDIATE, so both have
  // looked the session up and missed before either takes the lock; the test then releases
  // both. Without the second lookup under the lock, the loser would create its project.
  const { directory, keep } = await scratchDirectory(t, 'ledger-p1b-race-');
  const path = join(directory, 'ledger.sqlite');
  const release = join(directory, 'release');
  openStore(path).close();
  const storeUrl = pathToFileURL(join(process.cwd(), 'src/store.mjs')).href;
  const transcript = claude('Raced synthetic transcript.');
  const script = `import { existsSync, writeSync } from 'node:fs';
    import { DatabaseSync } from 'node:sqlite';
    import { openStore } from ${JSON.stringify(storeUrl)};
    const exec = DatabaseSync.prototype.exec;
    let armed = false;
    DatabaseSync.prototype.exec = function (sql) {
      if (armed && sql === 'BEGIN IMMEDIATE') {
        armed = false;
        writeSync(1, 'gate\\n');
        const deadline = Date.now() + 20000;
        const pause = new Int32Array(new SharedArrayBuffer(4));
        while (!existsSync(process.env.RELEASE)) {
          if (Date.now() > deadline) throw new Error('never released');
          Atomics.wait(pause, 0, 0, 10);
        }
      }
      return exec.call(this, sql);
    };
    const store = openStore(process.env.LEDGER_FILE);
    armed = true;
    const summary = store.importTranscript({ provider: 'claude', source: 'race.jsonl', transcript: process.env.TRANSCRIPT, project: process.env.PROJECT });
    writeSync(1, JSON.stringify(summary) + '\\n');
    store.close();`;
  const start = project => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script],
      { env: { ...process.env, LEDGER_FILE: path, RELEASE: release, TRANSCRIPT: transcript, PROJECT: project }, stdio: ['ignore', 'pipe', 'pipe'] });
    keep(() => child.exitCode === null && child.kill());
    let stdout = '';
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const exit = once(child, 'exit').then(([code]) => ({ code, stderr, stdout }));
    const gated = new Promise((resolve, reject) => {
      child.stdout.on('data', chunk => {
        stdout += chunk;
        if (stdout.startsWith('gate\n')) resolve();
      });
      exit.then(result => reject(new Error(`a child exited before the gate: ${result.stderr}`)));
    });
    return { gated, exit };
  };
  const children = [start('left'), start('right')];
  await Promise.all(children.map(child => child.gated));
  const check = new DatabaseSync(path);
  keep(() => check.close());
  assert.equal(check.prepare('SELECT count(*) AS n FROM sessions').get().n, 0, 'both children missed the first lookup');
  await writeFile(release, '');
  const results = await Promise.all(children.map(child => child.exit));
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  const [left, right] = results.map(result => JSON.parse(result.stdout.split('\n')[1]));
  assert.deepEqual(left, right);
  assert.ok(['left', 'right'].includes(left.project));
  assert.deepEqual(rows(check, 'SELECT slug FROM projects ORDER BY rowid'), [{ slug: 'default' }, { slug: left.project }]);
  assert.equal(check.prepare('SELECT count(*) AS n FROM sessions').get().n, 1);
});

test('a file that a newer build upgrades while this one opens it gets no DDL', async t => {
  // Review rounds 2 and 3. The child stops right after its first read of user_version;
  // a newer build (the holder) then drops a version 0 table, moves the file to version 3
  // and commits before the child goes on. Any DDL from the child would recreate the table.
  const { directory, keep } = await scratchDirectory(t, 'ledger-p1b-upgrade-race-');
  const storeUrl = pathToFileURL(join(process.cwd(), 'src/store.mjs')).href;
  const script = `import { existsSync, writeSync } from 'node:fs';
    import { DatabaseSync } from 'node:sqlite';
    import { openStore } from ${JSON.stringify(storeUrl)};
    const prepare = DatabaseSync.prototype.prepare;
    let armed = true;
    DatabaseSync.prototype.prepare = function (sql) {
      const statement = prepare.call(this, sql);
      if (!armed || sql !== 'PRAGMA user_version') return statement;
      armed = false;
      return { get: () => {
        const row = statement.get();
        writeSync(1, 'read ' + row.user_version + '\\n');
        const deadline = Date.now() + 20000;
        const pause = new Int32Array(new SharedArrayBuffer(4));
        while (!existsSync(process.env.RELEASE)) {
          if (Date.now() > deadline) throw new Error('never released');
          Atomics.wait(pause, 0, 0, 10);
        }
        return row;
      } };
    };
    openStore(process.env.LEDGER_FILE).close();`;
  const cases = [
    // A version 1 file needs the migration: the child rereads the version under the lock and refuses.
    { version: 1, make: async () => (await oldLedger(directory, 1)).path, stderr: newerMessage },
    // A current file needs no lock and gets no DDL; the child then fails on the missing table.
    { version: schemaVersion, make: async () => { const path = join(directory, 'current.sqlite'); openStore(path).close(); return path; }, stderr: /room_choices/u },
    // Review round 4: an upgrade that keeps every table is refused by the check before openStore returns.
    { version: schemaVersion, keepTables: true, make: async () => { const path = join(directory, 'compatible.sqlite'); openStore(path).close(); return path; },
      stderr: newerMessage },
  ];
  for (const [index, { version, keepTables = false, make, stderr: expected }] of cases.entries()) {
    const path = await make();
    const release = join(directory, `release-${index}`);
    const child = spawn(process.execPath, ['--input-type=module', '-e', script],
      { env: { ...process.env, LEDGER_FILE: path, RELEASE: release }, stdio: ['ignore', 'pipe', 'pipe'] });
    keep(() => child.exitCode === null && child.kill());
    let stdout = '';
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const exit = once(child, 'exit');
    await Promise.race([
      new Promise(resolve => child.stdout.on('data', chunk => {
        stdout += chunk;
        if (stdout.includes('\n')) resolve();
      })),
      exit.then(() => assert.fail(`the child exited before its first read: ${stderr}`)),
    ]);
    assert.equal(stdout, `read ${version}\n`);
    const holder = new DatabaseSync(path);
    holder.exec(`BEGIN IMMEDIATE; ${keepTables ? '' : 'DROP TABLE room_choices;'} PRAGMA user_version = ${newerVersion}; COMMIT;`);
    await writeFile(release, '');
    const [code] = await exit;
    assert.equal(code, 1, `case ${index}: ${stderr}`);
    assert.match(stderr, expected, `case ${index}`);
    assert.deepEqual(rows(holder, "SELECT name FROM sqlite_master WHERE name = 'room_choices'"), keepTables ? [{ name: 'room_choices' }] : [],
      `case ${index}`);
    assert.equal(userVersion(holder), newerVersion);
    holder.close();
  }
});

test('an upgrade that keeps every table, committed after the last statement is prepared, is refused', async t => {
  // Review round 5. The child stops right after openStore prepares its last statement
  // (the graph list), so the upgrade lands after preparation and before the final
  // version read. A recheck moved ahead of preparation would let the store open.
  const { directory, keep } = await scratchDirectory(t, 'ledger-p1b-late-upgrade-');
  const path = join(directory, 'ledger.sqlite');
  const release = join(directory, 'release');
  openStore(path).close();
  const storeUrl = pathToFileURL(join(process.cwd(), 'src/store.mjs')).href;
  const script = `import { existsSync, writeSync } from 'node:fs';
    import { DatabaseSync } from 'node:sqlite';
    import { openStore } from ${JSON.stringify(storeUrl)};
    const prepare = DatabaseSync.prototype.prepare;
    let phase = 'before';
    DatabaseSync.prototype.prepare = function (sql) {
      // Nothing but the version read may follow the gate inside openStore.
      if (phase === 'after' && sql !== 'PRAGMA user_version') throw new Error('a statement was prepared after the gate');
      const statement = prepare.call(this, sql);
      if (phase === 'before' && sql.includes('ORDER BY g.rowid DESC LIMIT $n')) {
        phase = 'after';
        writeSync(1, 'prepared\\n');
        const deadline = Date.now() + 20000;
        const pause = new Int32Array(new SharedArrayBuffer(4));
        while (!existsSync(process.env.RELEASE)) {
          if (Date.now() > deadline) throw new Error('never released');
          Atomics.wait(pause, 0, 0, 10);
        }
      }
      return statement;
    };
    const store = openStore(process.env.LEDGER_FILE);
    phase = 'done';
    writeSync(1, 'opened\\n');
    store.close();`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script],
    { env: { ...process.env, LEDGER_FILE: path, RELEASE: release }, stdio: ['ignore', 'pipe', 'pipe'] });
  // Review round 6: wait for the child to end before the folder is removed (Windows keeps the file open).
  keep(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const ended = once(child, 'close');
      child.kill();
      await ended;
    }
  });
  let stdout = '';
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  // Review round 6: close, not exit, so stdout and stderr have drained before they are checked.
  const exit = once(child, 'close');
  await Promise.race([
    new Promise(resolve => child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.includes('\n')) resolve();
    })),
    exit.then(() => assert.fail(`the child exited before the gate: ${stderr}`)),
  ]);
  assert.equal(stdout, 'prepared\n');
  const holder = new DatabaseSync(path);
  keep(() => holder.close());
  holder.exec(`BEGIN IMMEDIATE; PRAGMA user_version = ${newerVersion}; COMMIT;`);
  await writeFile(release, '');
  const [code] = await exit;
  assert.equal(stdout, 'prepared\n', 'the store must not open');
  assert.equal(code, 1, stderr);
  assert.match(stderr, newerMessage);
  assert.equal(userVersion(holder), newerVersion);
  assert.deepEqual(rows(holder, "SELECT name FROM sqlite_master WHERE name = 'room_choices'"), [{ name: 'room_choices' }]);
});

test('an import names its project, a new slug creates it once, and the default is default', () => {
  const store = openStore(':memory:');
  const first = store.importTranscript({ provider: 'claude', source: 'a.jsonl', transcript: claude('Acme kickoff notes.'), project: 'acme' });
  const second = store.importTranscript({ provider: 'claude', source: 'b.jsonl', transcript: claude('Acme follow-up.'), project: 'acme' });
  const plainImport = store.importTranscript({ provider: 'claude', source: 'c.jsonl', transcript: claude('No project named.') });
  const nullImport = store.importTranscript({ provider: 'claude', source: 'd.jsonl', transcript: claude('Project is null.'), project: null });
  const longest = 'a1-'.repeat(21) + 'z';
  const long = store.importTranscript({ provider: 'claude', source: 'e.jsonl', transcript: claude('Longest slug.'), project: longest });
  assert.equal(longest.length, 64);
  assert.deepEqual({ ...first }, { id: first.id, provider: 'claude', source: 'a.jsonl', title: 'Acme kickoff notes.', messageCount: 1, project: 'acme' });
  assert.equal(second.project, 'acme');
  assert.equal(plainImport.project, 'default');
  assert.equal(nullImport.project, 'default');
  assert.equal(long.project, longest);
  assert.equal(store.get(first.id).project, 'acme');
  assert.deepEqual(plain(store.list('', '', 'acme')).map(session => session.id), [second.id, first.id]);
  store.close();
});

test('invalid project slugs are refused before anything is written', async t => {
  const { directory, keep } = await scratchDirectory(t, 'ledger-p1b-slugs-');
  const path = join(directory, 'ledger.sqlite');
  const store = openStore(path);
  keep(() => store.close());
  const check = new DatabaseSync(path);
  keep(() => check.close());
  const counts = () => check.prepare('SELECT (SELECT count(*) FROM sessions) AS sessions, (SELECT count(*) FROM projects) AS projects').get();
  const start = { ...counts() };
  const bad = ['Acme', 'a b', 'a--b', '-a', 'a-', 'a_b', '', 'x'.repeat(65), `acme${String.fromCodePoint(0x200b)}`, 7, {}, ['acme'], true];
  for (const [index, project] of bad.entries()) {
    assert.throws(() => store.importTranscript({ provider: 'claude', source: 'x.jsonl', transcript: claude(`Bad slug ${index}.`), project }),
      error => error instanceof InputError && error.message === slugRule, JSON.stringify(project));
  }
  assert.deepEqual({ ...counts() }, start);
  assert.deepEqual(start, { sessions: 0, projects: 1 });
});

test('the same bytes in a second project keep the session where it is and create nothing', async t => {
  const { directory, keep } = await scratchDirectory(t, 'ledger-p1b-duplicate-');
  const path = join(directory, 'ledger.sqlite');
  const store = openStore(path);
  keep(() => store.close());
  const check = new DatabaseSync(path);
  keep(() => check.close());
  const transcript = claude('Shared synthetic transcript.');
  const stored = store.importTranscript({ provider: 'claude', source: 'shared.jsonl', transcript, project: 'acme' });
  const again = store.importTranscript({ provider: 'claude', source: 'renamed.jsonl', transcript, project: 'beta' });
  // Review round 2: no beta row at all, not just a beta with no sessions.
  assert.deepEqual(rows(check, 'SELECT slug FROM projects ORDER BY rowid'), [{ slug: 'default' }, { slug: 'acme' }]);
  assert.deepEqual({ ...again }, { ...stored });
  assert.equal(again.project, 'acme');
  assert.deepEqual(plain(store.list('', '', 'acme')).map(session => session.id), [stored.id]);
  assert.deepEqual(plain(store.list('', '', 'beta')), []);
  // beta was never created: a later import into it is its first session.
  const firstBeta = store.importTranscript({ provider: 'claude', source: 'beta.jsonl', transcript: claude('Beta only.'), project: 'beta' });
  assert.deepEqual(plain(store.list('', '', 'beta')).map(session => session.id), [firstBeta.id]);
  // The provider is part of the ID, so the same bytes from Codex are another session.
  const codexCopy = codex('Shared synthetic transcript.');
  const other = store.importTranscript({ provider: 'codex', source: 'shared.jsonl', transcript: codexCopy, project: 'beta' });
  assert.equal(other.project, 'beta');
});

test('search filters by project with the query, the provider and paging', () => {
  const store = openStore(':memory:');
  const acme = [];
  const other = [];
  for (let index = 0; index < 5; index += 1) {
    acme.push(store.importTranscript({ provider: index % 2 ? 'codex' : 'claude', source: `acme-${index}.jsonl`,
      transcript: (index % 2 ? codex : claude)(`Orion ${index} acme`), project: 'acme' }).id);
    other.push(store.importTranscript({ provider: 'claude', source: `other-${index}.jsonl`, transcript: claude(`Orion ${index} other`) }).id);
  }
  const ids = list => plain(list).map(session => session.id);
  assert.deepEqual(ids(store.list('orion', '', 'acme')), [...acme].reverse());
  assert.deepEqual(ids(store.list('orion', '', 'default')), [...other].reverse());
  assert.equal(store.list('orion', '', '').length, 10);
  assert.deepEqual(ids(store.list('orion', 'codex', 'acme')), [acme[3], acme[1]]);
  assert.deepEqual(ids(store.list('orion 2', '', 'acme')), [acme[2]]);
  assert.deepEqual(ids(store.list('orion', 'codex', 'default')), []);
  assert.deepEqual(ids(store.list('', '', 'nobody')), []);
  assert.ok(store.list('', '', 'acme').every(session => session.project === 'acme'));

  // Paging inside a project: newest first, cursors stay valid, the other project never shows.
  const seen = [];
  let after;
  for (let pages = 0; pages < 5; pages += 1) {
    const page = store.listSessionsPage({ query: '', provider: '', project: 'acme', limit: 2, after });
    seen.push(...ids(page.sessions));
    assert.ok(page.sessions.every(session => session.project === 'acme'));
    if (page.next === null) break;
    after = page.next;
  }
  assert.deepEqual(seen, [...acme].reverse());
  // A cursor from the default project still pages acme by position.
  const fromOther = store.listSessionsPage({ query: '', provider: '', project: 'acme', limit: 10, after: other[2] });
  assert.deepEqual(ids(fromOther.sessions), [acme[2], acme[1], acme[0]]);
  store.close();
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

async function runCli(args, port, database) {
  // The CLI finds the server's token from PORT and CONTEXT_LEDGER_DB (P1e).
  const env = { ...process.env, PORT: String(port), ...(database === undefined ? {} : { CONTEXT_LEDGER_DB: database }) };
  const child = spawn(process.execPath, ['src/cli.mjs', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [code] = await once(child, 'exit');
  return { code, stdout, stderr };
}

test('HTTP import takes a project, the session list filters by it, and the CLI searches one project', async t => {
  const { directory, keep } = await scratchDirectory(t, 'ledger-p1b-http-');
  const database = join(directory, 'ledger.sqlite');
  const server = await startServer(database);
  keep(() => server.stop());
  const { origin, auth } = server;
  const post = async (body, headers = {}) => {
    const response = await fetch(origin + '/api/import', { method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json', Origin: origin, ...headers }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const get = async path => {
    const response = await fetch(origin + path, { headers: auth });
    return { status: response.status, body: await response.json() };
  };
  const imported = async (source, text, project) => {
    const response = await post({ provider: 'claude', source, transcript: claude(text), ...(project === undefined ? {} : { project }) });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body.session;
  };

  const a1 = await imported('a1.jsonl', 'Vega launch acme one', 'acme');
  const plainOne = await imported('p1.jsonl', 'Vega launch default one');
  const a2 = await imported('a2.jsonl', 'Vega launch acme two', 'acme');
  assert.equal(a1.project, 'acme');
  assert.equal(plainOne.project, 'default');
  const ids = sessions => sessions.map(session => session.id);
  assert.deepEqual(ids((await get('/api/sessions?q=vega&project=acme')).body.sessions), [a2.id, a1.id]);
  assert.deepEqual(ids((await get('/api/sessions?q=vega&project=default')).body.sessions), [plainOne.id]);
  assert.equal((await get('/api/sessions?q=vega')).body.sessions.length, 3);
  assert.deepEqual((await get('/api/sessions?project=nobody')).body, { sessions: [] });
  const page = (await get('/api/sessions?project=acme&limit=1')).body;
  assert.deepEqual({ ids: ids(page.sessions), next: page.next }, { ids: [a2.id], next: a2.id });
  assert.deepEqual((await get(`/api/sessions?project=acme&limit=1&after=${a2.id}`)).body, { sessions: [{ ...a1 }], next: null });
  // Same bytes into another project: the stored session, still in acme.
  const again = await post({ provider: 'claude', source: 'a1.jsonl', transcript: claude('Vega launch acme one'), project: 'beta' });
  assert.deepEqual(again, { status: 200, body: { session: a1 } });

  // Bad or repeated filters are 400 with fixed text that never echoes the value.
  const secret = 'Secret-Slug';
  for (const path of [`/api/sessions?project=${secret}`, `/api/sessions?project=${secret}&limit=5`,
    '/api/sessions?q=vega&project=', '/api/sessions?q=vega&project=&limit=5']) {
    assert.deepEqual(await get(path), { status: 400, body: { error: 'project must be a slug of at most 64 lowercase letters, digits and single hyphens.' } });
  }
  assert.deepEqual(await get('/api/sessions?project=acme&project=beta'), { status: 400, body: { error: 'project may appear once.' } });
  assert.deepEqual(await post({ provider: 'claude', source: 'x.jsonl', transcript: claude('x'), project: secret }),
    { status: 400, body: { error: slugRule } });

  // The Origin and Host checks are unchanged: nothing is written for a cross-origin import.
  const crossOrigin = await post({ provider: 'claude', source: 'evil.jsonl', transcript: claude('Cross-origin write'), project: 'evil' },
    { Origin: 'http://attacker.test' });
  assert.equal(crossOrigin.status, 403);
  const check = new DatabaseSync(database);
  keep(() => check.close());
  assert.deepEqual(rows(check, 'SELECT slug FROM projects ORDER BY rowid'), [{ slug: 'default' }, { slug: 'acme' }]);
  assert.equal(check.prepare('SELECT count(*) AS n FROM sessions').get().n, 3);
  const wrongHost = await new Promise((resolve, reject) => {
    import('node:http').then(({ request }) => {
      const outgoing = request({ host: '127.0.0.1', port: server.port, path: '/api/sessions?project=acme', headers: { Host: 'evil.test' } }, response => {
        response.resume();
        resolve(response.statusCode);
      });
      outgoing.on('error', reject);
      outgoing.end();
    }, reject);
  });
  assert.equal(wrongHost, 403);

  // CLI: --project sends the filter; a bad slug is refused before any request (no server on the port).
  const cli = await runCli(['search', '--project', 'acme', 'vega'], server.port, database);
  assert.equal(cli.code, 0, cli.stderr);
  assert.deepEqual(JSON.parse(cli.stdout).map(session => [session.id, session.project]), [[a2.id, 'acme'], [a1.id, 'acme']]);
  for (const slug of ['Acme', '', 'a--b']) {
    const refused = await runCli(['search', '--project', slug, 'vega'], 1);
    assert.equal(refused.code, 1);
    assert.equal(refused.stderr.trim(), slugRule);
  }
  for (const args of [['--project', 'Bad-Slug', '--project', 'acme'], ['--project', 'acme', '--project', 'acme']]) {
    const refused = await runCli(['search', ...args, 'vega'], 1);
    assert.deepEqual({ code: refused.code, stderr: refused.stderr.trim() }, { code: 1, stderr: 'Give --project once.' });
  }
});
