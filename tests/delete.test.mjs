import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { schemaVersion } from '../src/migrate.mjs';
import { ConflictError, InputError, openStore } from '../src/store.mjs';
import { tokenFileFor } from '../src/token.mjs';
import { bearer, ledgerToken, restrictToOwner } from './ledger-auth.mjs';

// P1d, first part: delete one imported session. Synthetic transcripts only, and only
// temporary or :memory: databases: never .context-ledger/ledger.sqlite.
const execute = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));

const transcript = (...texts) => texts.map((text, index) => JSON.stringify(index % 2
  ? { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }
  : { type: 'user', message: { role: 'user', content: text } })).join('\n');
const importOne = (store, source, ...texts) => store.importTranscript({ provider: 'claude', source, transcript: transcript(...texts) });
const v1 = (session, label) => ({ version: 1, sessionId: session.id, nodes: [{ id: 'goal', kind: 'goal', label, evidenceLines: [1] }], edges: [] });
const v2 = (session, party, label, extra = {}) => ({ version: 2, sessionId: session.id, party,
  nodes: [{ id: 'goal', kind: 'goal', label, evidenceLines: [1] }], edges: [], ...extra });
const schemaOf = path => {
  const database = new DatabaseSync(path);
  try {
    return {
      version: database.prepare('PRAGMA user_version').get().user_version,
      tables: database.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY type, name').all().map(row => ({ ...row })),
    };
  } finally {
    database.close();
  }
};

async function temporaryDirectory(t, prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('deleteSession removes one session and nothing else, and leaves the schema as it was', async t => {
  const path = join(await temporaryDirectory(t, 'ledger-delete-'), 'ledger.sqlite');
  openStore(path).close();
  const before = schemaOf(path);

  const store = openStore(path);
  const keep = importOne(store, 'keep.jsonl', 'Orla keeps the synthetic Pavo plan.');
  const gone = importOne(store, 'gone.jsonl', 'Bram drafts the synthetic Quill budget.', 'The Quill budget is 40 units.');
  const keptDetail = store.get(keep.id);
  assert.deepEqual(store.list('', '').map(row => row.id), [gone.id, keep.id]);

  assert.equal(store.deleteSession(gone.id), true);
  assert.equal(store.get(gone.id), undefined);
  assert.deepEqual(store.list('', '').map(row => row.id), [keep.id]);
  assert.deepEqual(store.listSessionsPage({ query: '', provider: '', limit: 10 }), { sessions: [keep], next: null });
  assert.deepEqual(store.get(keep.id), keptDetail);

  // Unknown IDs, including one just deleted, change nothing.
  assert.equal(store.deleteSession(gone.id), false);
  assert.equal(store.deleteSession('e'.repeat(64)), false);
  assert.deepEqual(store.list('', '').map(row => row.id), [keep.id]);

  // A re-import of the same bytes is a new import with the same ID.
  assert.equal(importOne(store, 'gone.jsonl', 'Bram drafts the synthetic Quill budget.', 'The Quill budget is 40 units.').id, gone.id);
  store.close();
  assert.deepEqual(schemaOf(path), before);
  assert.equal(before.version, schemaVersion);
});

test('deleteSession is refused while any graph cites the session, and says how many', () => {
  const store = openStore(':memory:');
  {
    const leo = importOne(store, 'leo.jsonl', 'Leo plans the synthetic Lyra demo.');
    const ali = importOne(store, 'ali.jsonl', 'Ali reviews the synthetic Lyra demo.');
    const solo = importOne(store, 'solo.jsonl', 'Solo notes for the synthetic Ursa demo.');

    store.publishGraph(v1(solo, 'Ursa goal'));
    const refusal = error => {
      assert.ok(error instanceof ConflictError);
      assert.equal(error.message, 'This session is cited by 1 graph, so it cannot be deleted.');
      assert.deepEqual(error.details, { graphs: 1 });
      return true;
    };
    assert.throws(() => store.deleteSession(solo.id), refusal);
    store.publishGraph(v1(solo, 'Ursa goal, second take'));
    assert.throws(() => store.deleteSession(solo.id), error => {
      assert.equal(error.message, 'This session is cited by 2 graphs, so it cannot be deleted.');
      assert.deepEqual(error.details, { graphs: 2 });
      return true;
    });
    assert.equal(store.get(solo.id).id, solo.id);
    assert.equal(store.listGraphs({ sessionId: solo.id, limit: 10 }).graphs.length, 2);

    // A session in a room is refused through its graph; the room stays readable.
    const leoGraph = store.publishGraph(v2(leo, 'leo', 'Lyra goal'));
    const aliGraph = store.publishGraph(v2(ali, 'ali', 'Lyra review', { links: [{ from: 'goal', graph: leoGraph.id, to: 'goal', type: 'matches' }] }));
    const room = store.openRoom({ graphIds: [leoGraph.id, aliGraph.id] });
    for (const session of [leo, ali]) assert.throws(() => store.deleteSession(session.id), refusal);
    assert.deepEqual(store.getRoom(room.id), room);
    assert.ok(store.getGraphContext(leoGraph.id));
    assert.equal(store.list('', '').length, 3);

    // A refusal leaves no transaction open: the next write works.
    const other = importOne(store, 'other.jsonl', 'Other synthetic note.');
    assert.equal(store.deleteSession(other.id), true);
  }
  store.close();
});

test('a deleted session is really gone: search, raw file bytes, journal, and secure_delete restored', async t => {
  const directory = await temporaryDirectory(t, 'ledger-delete-bytes-');
  const path = join(directory, 'ledger.sqlite');
  const marker = 'Zephyrine';
  const title = `${marker} titles the synthetic Corvid file`;
  const bulk = `${marker} bulk evidence line. `.repeat(400);

  // Spy on exec to see the pragma and transaction statements the delete runs, and to
  // reach the store's own connection (its first exec is the schema).
  const statements = [];
  let connection;
  const exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (sql) {
    connection ??= this;
    statements.push(sql.trim());
    return exec.call(this, sql);
  };
  t.after(() => { DatabaseSync.prototype.exec = exec; });
  const pragma = name => Object.values(connection.prepare(`PRAGMA ${name}`).get())[0];

  const store = openStore(path);
  const keep = importOne(store, 'keep-corvid.jsonl', 'A kept synthetic Corvid note.');
  const gone = importOne(store, 'Xanthorrhoea-source.jsonl', title, bulk, `${marker} closing line.`);
  const cited = importOne(store, 'cited-corvid.jsonl', 'A cited synthetic Corvid note.');
  store.publishGraph(v1(cited, 'Corvid goal'));
  assert.deepEqual(store.list(marker, '').map(row => row.id), [gone.id]);

  // A mode other than the default is put back as it was, after success and refusal.
  for (const [mode, value] of [['OFF', 0], ['FAST', 2]]) {
    connection.exec(`PRAGMA secure_delete = ${mode}`);
    statements.length = 0;
    assert.throws(() => store.deleteSession(cited.id), ConflictError);
    assert.deepEqual(statements, ['PRAGMA secure_delete = ON', 'BEGIN IMMEDIATE', 'ROLLBACK', `PRAGMA secure_delete = ${mode}`]);
    assert.equal(pragma('secure_delete'), value);
  }
  statements.length = 0;
  assert.equal(store.deleteSession(gone.id), true);
  assert.deepEqual(statements, ['PRAGMA secure_delete = ON', 'BEGIN IMMEDIATE', 'COMMIT', 'PRAGMA secure_delete = FAST']);
  assert.equal(pragma('secure_delete'), 2);
  connection.exec('PRAGMA secure_delete = OFF');

  // Foreign keys stay on, so the schema itself also refuses a cited delete.
  assert.equal(pragma('foreign_keys'), 1);
  assert.throws(() => connection.prepare('DELETE FROM sessions WHERE id = ?').run(cited.id), /FOREIGN KEY constraint failed/u);

  assert.deepEqual(store.list(marker, '').map(row => row.id), []);
  assert.deepEqual(store.list('zephyrine bulk', '').map(row => row.id), []);
  assert.deepEqual(store.list('corvid', '').map(row => row.id).sort(), [keep.id, cited.id].sort());

  // Checked while the store is still open, as a running server holds it, and after close.
  const checkFile = async () => {
    const bytes = (await readFile(path)).toString('latin1');
    for (const text of [marker, 'Xanthorrhoea', 'titles the synthetic', 'bulk evidence line', 'closing line']) {
      assert.equal(bytes.includes(text), false, `${text} is still in the file`);
    }
    assert.ok(bytes.includes('A kept synthetic Corvid note.'));
    assert.deepEqual((await readdir(directory)).sort(), ['ledger.sqlite']);
  };
  await checkFile();
  store.close();
  await checkFile();
});

// WAL is the one journal mode stored in the file, so another tool can leave a ledger
// in it. (PERSIST is per connection, and the ledger never sets it.)
test('a delete is refused when the database keeps old pages in a WAL', async t => {
  const directory = await temporaryDirectory(t, 'ledger-delete-journal-');
  for (const mode of ['wal']) {
    const path = join(directory, `${mode}.sqlite`);
    openStore(path).close();
    const setup = new DatabaseSync(path);
    assert.equal(setup.prepare(`PRAGMA journal_mode = ${mode}`).get().journal_mode, mode);
    setup.close();

    const store = openStore(path);
    const session = importOne(store, `${mode}.jsonl`, `A synthetic ${mode} journal note.`);
    assert.throws(() => store.deleteSession(session.id), error => {
      assert.ok(error instanceof ConflictError);
      assert.equal(error.message, `This ledger database uses journal mode ${mode}, so a delete could leave copies of the transcript in the file. Deleting needs the default rollback journal.`);
      assert.deepEqual(error.details, { journalMode: mode });
      return true;
    });
    assert.equal(store.get(session.id).id, session.id);
    // Unknown IDs are still not found, and the refusal left no transaction open.
    assert.equal(store.deleteSession('e'.repeat(64)), false);
    store.close();
  }
});

test('a session cannot be deleted from another connection while a graph of it is being published', async t => {
  // Codex review of the R1 refresh, round 6: the check and the insert now run under one
  // write lock, so the other connection waits and gives up instead of deleting in between.
  const directory = await mkdtemp(join(tmpdir(), 'ledger-delete-race-'));
  const path = join(directory, 'ledger.sqlite');
  const publisher = openStore(path);
  const deleter = openStore(path);
  // One after hook, so both connections close before the file is removed.
  t.after(async () => {
    publisher.close();
    deleter.close();
    await rm(directory, { recursive: true, force: true });
  });
  const session = importOne(publisher, 'race.jsonl', 'A synthetic race note.');

  // Delete the session from the other connection just before the graph insert runs,
  // after publishGraph has read and validated the session.
  const run = StatementSync.prototype.run;
  StatementSync.prototype.run = function (...args) {
    if (args[1] === session.id && typeof args[2] === 'string' && args[2].includes('"packet"')) {
      StatementSync.prototype.run = run;
      assert.throws(() => deleter.deleteSession(session.id), /locked|busy/iu);
    }
    return run.apply(this, args);
  };
  t.after(() => { StatementSync.prototype.run = run; });
  const graph = publisher.publishGraph(v1(session, 'Race goal'));
  assert.equal(StatementSync.prototype.run, run);
  assert.deepEqual(publisher.listGraphs({ limit: 10 }).graphs.map(entry => entry.id), [graph.id]);
});

test('a list cursor on a deleted session is refused, and a restarted listing finds the rest', () => {
  const store = openStore(':memory:');
  const sessions = ['one', 'two', 'three'].map(word => importOne(store, `${word}.jsonl`, `Synthetic cursor note ${word}.`));
  const first = store.listSessionsPage({ query: '', provider: '', limit: 1 });
  assert.deepEqual(first.sessions.map(row => row.id), [sessions[2].id]);
  assert.equal(first.next, sessions[2].id);
  assert.equal(store.deleteSession(first.next), true);
  assert.throws(() => store.listSessionsPage({ query: '', provider: '', limit: 1, after: first.next }), { message: 'Unknown cursor.' });
  const restarted = store.listSessionsPage({ query: '', provider: '', limit: 10 });
  assert.deepEqual(restarted, { sessions: [sessions[1], sessions[0]].map(({ id }) => store.list('', '').find(row => row.id === id)), next: null });
  store.close();
});

test('without secure_delete SQLite keeps deleted text in the file, which is why the delete turns it on', async t => {
  const path = join(await temporaryDirectory(t, 'ledger-delete-premise-'), 'plain.sqlite');
  const database = new DatabaseSync(path);
  assert.equal(database.prepare('PRAGMA secure_delete').get().secure_delete, 0);
  database.exec('CREATE TABLE t (id TEXT PRIMARY KEY, body TEXT) STRICT');
  database.prepare('INSERT INTO t VALUES (?, ?)').run('a', 'Zephyrine plain delete. '.repeat(400));
  database.prepare('DELETE FROM t WHERE id = ?').run('a');
  database.close();
  assert.ok((await readFile(path)).toString('latin1').includes('Zephyrine plain delete.'));
});

async function startServer(t, prepare) {
  // One after hook, so the server stops before its database file is removed.
  const directory = await mkdtemp(join(tmpdir(), 'ledger-delete-server-'));
  const path = join(directory, 'ledger.sqlite');
  prepare?.(path);
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: root, env: { ...process.env, PORT: '0', CONTEXT_LEDGER_DB: path }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  t.after(async () => {
    try {
      if (child.exitCode === null) {
        child.kill();
        await once(child, 'exit');
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  let output = '';
  for await (const chunk of child.stdout) {
    output += chunk;
    const match = output.match(/listening at http:\/\/127\.0\.0\.1:(\d+)/);
    if (match) {
      // P1e: every API request carries the token the server wrote next to its database.
      const port = Number(match[1]);
      return { port, path, auth: bearer(await ledgerToken(path, port)) };
    }
  }
  throw new Error('The server did not start.');
}

// The CLI finds the token from PORT and CONTEXT_LEDGER_DB, as it does for the real ledger.
const cli = (server, ...args) => execute(process.execPath, ['src/cli.mjs', ...args], {
  cwd: root, env: { ...process.env, PORT: String(server.port), CONTEXT_LEDGER_DB: server.path },
});
const cliFails = async (server, args, stderr) => {
  await assert.rejects(cli(server, ...args), error => {
    assert.equal(error.code, 1);
    assert.equal(error.stdout, '');
    assert.equal(error.stderr.trim(), stderr);
    return true;
  });
};

test('ledger delete deletes through the server, and refuses cited and unknown sessions', async t => {
  const server = await startServer(t);
  const { port, auth } = server;
  const origin = `http://127.0.0.1:${port}`;
  const get = path => fetch(origin + path, { headers: auth });
  const post = async (path, body) => {
    const response = await fetch(origin + path, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    return response.json();
  };
  const { session: gone } = await post('/api/import', { provider: 'claude', source: 'gone.jsonl', transcript: transcript('Nimbus is a synthetic word to delete.') });
  const { session: cited } = await post('/api/import', { provider: 'codex', source: 'cited.jsonl',
    transcript: JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'A cited synthetic Nimbus note.' }] } }) });
  await post('/api/graphs', v1(cited, 'Nimbus goal'));

  const deleted = await cli(server, 'delete', gone.id);
  assert.equal(deleted.stdout, `Deleted session ${gone.id}.\n`);
  assert.equal(deleted.stderr, '');
  assert.equal((await get(`/api/sessions/${gone.id}`)).status, 404);
  assert.deepEqual((await (await get('/api/sessions?q=nimbus')).json()).sessions.map(row => row.id), [cited.id]);

  await cliFails(server, ['delete', gone.id], 'Session not found.');
  await cliFails(server, ['delete', cited.id], 'Session is cited by 1 graph, so it was not deleted.');
  assert.equal((await get(`/api/sessions/${cited.id}`)).status, 200);

  // A DELETE without the Origin, as a page on another site or a plain client sends it, is refused.
  const bare = await fetch(`${origin}/api/sessions/${cited.id}`, { method: 'DELETE', headers: auth });
  assert.deepEqual([bare.status, await bare.json()], [403, { error: 'Deleting a session requires the same origin.' }]);

  // A list cursor on a session deleted over HTTP is refused; a new listing works.
  const { session: anchor } = await post('/api/import', { provider: 'claude', source: 'anchor.jsonl', transcript: transcript('A synthetic anchor note.') });
  const page = await (await get('/api/sessions?limit=1')).json();
  assert.equal(page.next, anchor.id);
  assert.equal((await cli(server, 'delete', anchor.id)).stdout, `Deleted session ${anchor.id}.\n`);
  const stale = await get(`/api/sessions?limit=1&after=${anchor.id}`);
  assert.deepEqual([stale.status, await stale.json()], [400, { error: 'Unknown cursor.' }]);
  const fresh = await (await get('/api/sessions?limit=10')).json();
  assert.deepEqual(fresh.sessions.map(row => row.id), [cited.id]);
});

test('a server on a WAL database answers a delete with 409 and the journal mode', async t => {
  const server = await startServer(t, path => {
    openStore(path).close();
    const setup = new DatabaseSync(path);
    setup.prepare('PRAGMA journal_mode = wal').get();
    setup.close();
  });
  const { port, auth } = server;
  const origin = `http://127.0.0.1:${port}`;
  const imported = await fetch(`${origin}/api/import`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ provider: 'claude', source: 'wal.jsonl', transcript: transcript('A synthetic WAL server note.') }) });
  const { session } = await imported.json();
  const refused = await fetch(`${origin}/api/sessions/${session.id}`, { method: 'DELETE', headers: { ...auth, Origin: origin } });
  assert.deepEqual([refused.status, await refused.json()], [409, {
    error: 'This ledger database uses journal mode wal, so a delete could leave copies of the transcript in the file. Deleting needs the default rollback journal.',
    journalMode: 'wal',
  }]);
  await cliFails(server, ['delete', session.id], 'The ledger database does not use the default rollback journal, so the session was not deleted.');
  assert.equal((await fetch(`${origin}/api/sessions/${session.id}`, { headers: auth })).status, 200);
});

test('ledger delete sends one DELETE with the local Origin, and prints only fixed text', async t => {
  const id = 'c'.repeat(64);
  const requests = [];
  let reply = { status: 200, body: { deleted: id } };
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ method: request.method, url: request.url, origin: request.headers.origin, authorization: request.headers.authorization, body: Buffer.concat(chunks).length });
    response.writeHead(reply.status, { 'Content-Type': 'application/json' });
    response.end(reply.raw ?? JSON.stringify(reply.body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  // P1e: a delete goes only where the token file says the ledger is.
  const directory = await temporaryDirectory(t, 'ledger-delete-cli-');
  const path = join(directory, 'ledger.sqlite');
  const tokenFile = tokenFileFor(path, port);
  await writeFile(tokenFile, JSON.stringify({ port, token: 'D'.repeat(43) }) + '\n', { mode: 0o600 });
  restrictToOwner(tokenFile);
  const target = { port, path };

  assert.equal((await cli(target, 'delete', id)).stdout, `Deleted session ${id}.\n`);
  assert.deepEqual(requests, [{ method: 'DELETE', url: `/api/sessions/${id}`, origin: `http://127.0.0.1:${port}`, authorization: `Bearer ${'D'.repeat(43)}`, body: 0 }]);

  // Bad IDs print the usage and send nothing.
  for (const args of [['delete'], ['delete', 'C'.repeat(64)], ['delete', 'c'.repeat(63)], ['delete', id, id]]) {
    await assert.rejects(cli(target, ...args), error => error.code === 1 && error.stderr.startsWith('Usage:') && error.stderr.includes('delete <session-id>'));
  }
  assert.equal(requests.length, 1);

  // The server's own words never reach the terminal: a 409 is built from its count.
  const hostile = `Gone ${String.fromCodePoint(0x1b)}[2J ${String.fromCodePoint(0x202e)}reversed`;
  reply = { status: 409, body: { error: hostile, graphs: 3 } };
  await cliFails(target, ['delete', id], 'Session is cited by 3 graphs, so it was not deleted.');
  for (const graphs of [0, -1, 1.5, '2', null]) {
    reply = { status: 409, body: { error: hostile, graphs } };
    await cliFails(target, ['delete', id], 'Context Ledger returned HTTP 409.');
  }
  reply = { status: 403, body: { error: hostile } };
  await cliFails(target, ['delete', id], 'Context Ledger returned HTTP 403.');
  reply = { status: 404, body: { error: hostile } };
  await cliFails(target, ['delete', id], 'Session not found.');
  reply = { status: 409, body: { error: hostile, journalMode: 'wal' } };
  await cliFails(target, ['delete', id], 'The ledger database does not use the default rollback journal, so the session was not deleted.');
  for (const journalMode of [hostile, 'delete', null, 3]) {
    reply = { status: 409, body: { error: hostile, journalMode } };
    await cliFails(target, ['delete', id], 'Context Ledger returned HTTP 409.');
  }
  reply = { status: 200, body: { deleted: 'd'.repeat(64) } };
  await cliFails(target, ['delete', id], 'Context Ledger returned an unexpected response.');
  // A body that is not JSON: the parse error would quote it, so it is not printed.
  for (const status of [200, 409]) {
    reply = { status, raw: hostile };
    await cliFails(target, ['delete', id], status === 200 ? 'Context Ledger returned an unexpected response.' : 'Context Ledger returned HTTP 409.');
  }
  // Without a token for this port, as for a graph packet, nothing is sent (P1e).
  const sent = requests.length;
  await cliFails({ port, path: join(directory, 'other.sqlite') }, ['delete', id],
    'Cannot read the Context Ledger access token. Start the ledger with npm start, and run this with the same PORT and CONTEXT_LEDGER_DB as the ledger.');
  assert.equal(requests.length, sent);
});

test('the MCP adapter has no way to delete', async () => {
  const { toolList } = await import('../src/mcp/tools.mjs');
  // The thirteen tools from before P1d, and G11's read-only graph_diff.
  assert.deepEqual(toolList.map(tool => tool.name), ['session_search', 'session_read', 'graph_schema', 'graph_publish', 'graph_read',
    'context_for', 'room_open', 'room_read', 'latent_read', 'latent_transfer', 'latent_team', 'graph_list', 'room_list', 'graph_diff']);
  for (const tool of toolList) {
    // graph_diff is read-only: it reports the nodes a newer graph no longer has.
    const text = JSON.stringify(tool).replace('nodes added, removed and changed', 'nodes added, dropped and changed');
    assert.doesNotMatch(text, /delet|remov|purg|eras/iu, tool.name);
  }
  const directory = new URL('../src/mcp/', import.meta.url);
  for (const name of await readdir(directory)) {
    const source = await readFile(new URL(name, directory), 'utf8');
    assert.doesNotMatch(source, /DELETE|deleteSession/u, name);
  }
  assert.doesNotMatch(await readFile(new URL('../src/mcp.mjs', import.meta.url), 'utf8'), /DELETE|deleteSession/u);
});

test('the files this card changes hold no raw control or format characters', async () => {
  const files = ['src/errors.mjs', 'src/store.mjs', 'src/server.mjs', 'src/cli.mjs', 'tests/delete.test.mjs', 'tests/routes.test.mjs',
    'tests/e2e/delete.spec.mjs', 'public/app.js', 'public/index.html', 'public/styles.css'];
  for (const file of files) {
    assert.ok(existsSync(join(root, file)), file);
    const text = await readFile(join(root, file), 'utf8');
    const found = [...text].filter(character => /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(character) && !['\t', '\n', '\r'].includes(character));
    assert.deepEqual(found, [], file);
  }
});
