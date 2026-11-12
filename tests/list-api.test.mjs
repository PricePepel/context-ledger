import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openStore } from '../src/store.mjs';
import { startMcp } from './mcp-client.mjs';

// Cycle 10 F2: graph_list, room_list and the list routes behind them. Synthetic data.
const fixtureRoot = fileURLToPath(new URL('../evals/latent/fixture', import.meta.url));
const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

async function startServer(env) {
  const child = spawn(process.execPath, ['src/server.mjs'], { env: { ...process.env, PORT: '0', ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  let output = '';
  for await (const chunk of child.stdout) {
    output += chunk;
    const match = output.match(/listening at (http:\/\/127\.0\.0\.1:(\d+))/);
    if (match) return { origin: match[1], port: Number(match[2]), stop: async () => { child.kill(); await once(child, 'exit'); } };
  }
  throw new Error('Server exited before listening: ' + output);
}

/** A temporary ledger with an MCP client; one cleanup hook, in order, for Windows. */
async function ledger(t, env = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-lists-'));
  const state = { database: join(directory, 'ledger.sqlite') };
  t.after(async () => {
    try {
      if (state.client && state.client.child.exitCode === null) await state.client.close();
    } finally {
      try {
        await state.server?.stop();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });
  state.server = await startServer({ CONTEXT_LEDGER_DB: state.database, ...env });
  state.client = startMcp(state.server.port);
  const { origin } = state.server;
  state.post = async (path, body, headers = {}) => {
    const response = await fetch(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...headers }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  state.get = async path => {
    const response = await fetch(origin + path);
    return { status: response.status, body: await response.json() };
  };
  state.import = async (source, text) => (await state.post('/api/import', {
    provider: 'claude', source, transcript: JSON.stringify({ type: 'user', message: { role: 'user', content: text } }),
  })).body.session;
  state.publish = async packet => {
    const response = await state.post('/api/graphs', packet);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body.graph;
  };
  state.room = async (a, b) => (await state.post('/api/rooms', { graphIds: [a.id, b.id] })).body.room;
  let id = 1000;
  state.call = async (name, args) => {
    const result = await state.client.call(id++, name, args);
    return result.isError ? { error: result.content[0].text } : JSON.parse(result.content[0].text);
  };
  return state;
}

const v2 = (session, party, label, extra = {}) => ({ version: 2, sessionId: session.id, party,
  nodes: [{ id: 'goal', kind: 'goal', label, evidenceLines: [1] }], edges: [], ...extra });

/** Follow more.after from the first call and return every row, checking pages are not empty. */
async function walk(state, name, key, args) {
  const rows = [];
  let after;
  for (let pages = 0; ; pages += 1) {
    const page = await state.call(name, after ? { ...args, after } : args);
    assert.equal(page.error, undefined, page.error);
    rows.push(...page[key]);
    if (!page.more) return rows;
    assert.equal(Object.keys(page)[0], 'more');
    assert.equal(page.more.after, page[key].at(-1).id);
    after = page.more.after;
    assert.ok(pages < 50);
  }
}

test('graph_list and room_list filter, page newest first and name the parties without proposals', async t => {
  const state = await ledger(t);
  const leo = await state.import('leo.jsonl', 'Leo plans the synthetic Vega demo.');
  const ali = await state.import('ali.jsonl', 'Ali reviews the synthetic Vega demo.');
  const g1 = await state.publish({ version: 1, sessionId: leo.id, nodes: [{ id: 'ship', kind: 'goal', label: 'Ship Vega', evidenceLines: [1] }], edges: [] });
  const g2 = await state.publish(v2(leo, 'leo', 'Synthetic demo'));
  const g3 = await state.publish(v2(ali, 'ali', 'Review the demo', { links: [{ from: 'goal', graph: g2.id, to: 'goal', type: 'matches' }] }));
  const g4 = await state.publish(v2(leo, 'leo', 'Synthetic demo, revised'));
  const g5 = await state.publish(v2(ali, 'ali', 'Review the revised demo'));
  const ids = rows => rows.map(row => row.id);

  const all = await state.call('graph_list', {});
  assert.deepEqual(Object.keys(all), ['graphs']);
  assert.deepEqual(ids(all.graphs), [g5.id, g4.id, g3.id, g2.id, g1.id]);
  for (const row of all.graphs) {
    assert.deepEqual(Object.keys(row), ['id', 'sessionId', 'sessionTitle', 'party', 'version', 'createdAt', 'nodes', 'edges', 'links']);
    assert.match(row.createdAt, iso);
  }
  assert.deepEqual(all.graphs.at(-1), { ...all.graphs.at(-1), sessionId: leo.id, sessionTitle: 'Leo plans the synthetic Vega demo.',
    party: null, version: 1, nodes: 1, edges: 0, links: 0 });
  assert.deepEqual(all.graphs[2], { ...all.graphs[2], party: 'ali', version: 2, links: 1 });
  assert.deepEqual(ids((await state.call('graph_list', { sessionId: leo.id })).graphs), [g4.id, g2.id, g1.id]);
  assert.deepEqual(ids((await state.call('graph_list', { party: 'leo' })).graphs), [g4.id, g2.id]);
  assert.deepEqual(ids((await state.call('graph_list', { sessionId: leo.id, party: 'leo' })).graphs), [g4.id, g2.id]);
  assert.deepEqual(await state.call('graph_list', { sessionId: ali.id, party: 'leo' }), { graphs: [] });
  assert.deepEqual(await state.call('graph_list', { sessionId: 'f'.repeat(64) }), { graphs: [] });
  assert.deepEqual(ids(await walk(state, 'graph_list', 'graphs', { limit: 1 })), ids(all.graphs));
  assert.deepEqual(ids(await walk(state, 'graph_list', 'graphs', { party: 'ali', limit: 1 })), [g5.id, g3.id]);
  assert.deepEqual(await state.call('graph_list', { after: 'e'.repeat(64) }), { error: 'after does not name a listed item; call again without after.' });

  const r1 = await state.room(g2, g3);
  const r2 = await state.room(g4, g5);
  const r3 = await state.room(g5, g2);
  assert.equal((await state.room(g3, g2)).id, r1.id, 'a room opened twice lists once');
  const rooms = await state.call('room_list', {});
  assert.deepEqual(ids(rooms.rooms), [r3.id, r2.id, r1.id]);
  assert.deepEqual(rooms.rooms[2], { id: r1.id, createdAt: rooms.rooms[2].createdAt, parties: [
    { party: 'ali', graphId: g3.id, sessionId: ali.id }, { party: 'leo', graphId: g2.id, sessionId: leo.id }] });
  assert.match(rooms.rooms[2].createdAt, iso);
  assert.deepEqual(ids((await state.call('room_list', { graphId: g2.id })).rooms), [r3.id, r1.id]);
  assert.deepEqual(ids((await state.call('room_list', { graphId: g5.id, party: 'ali' })).rooms), [r3.id, r2.id]);
  assert.deepEqual(await state.call('room_list', { party: 'bob' }), { rooms: [] });
  assert.deepEqual(ids(await walk(state, 'room_list', 'rooms', { limit: 1 })), ids(rooms.rooms));
  assert.doesNotMatch(JSON.stringify(rooms), /proposal|choice/i);
});

test('list pages are stable while new graphs, rooms and sessions arrive', async t => {
  const state = await ledger(t);
  const leo = await state.import('leo.jsonl', 'Leo plans the synthetic Orion demo.');
  const ali = await state.import('ali.jsonl', 'Ali reviews the synthetic Orion demo.');
  const graphs = [];
  for (let index = 0; index < 4; index += 1) graphs.push(await state.publish(v2(index % 2 ? ali : leo, index % 2 ? 'ali' : 'leo', `Orion goal ${index}`)));
  const rooms = [await state.room(graphs[0], graphs[1]), await state.room(graphs[2], graphs[3]), await state.room(graphs[0], graphs[3])];

  const firstGraphs = await state.call('graph_list', { limit: 2 });
  const firstRooms = await state.call('room_list', { limit: 2 });
  const firstSessions = await state.call('session_search', { limit: 1 });
  const carol = await state.import('carol.jsonl', 'Carol joins the synthetic Orion demo.');
  const late = await state.publish(v2(carol, 'carol', 'Orion goal late'));
  await state.room(late, graphs[0]);
  await state.publish(v2(leo, 'leo', 'Orion goal later'));

  const rest = async (name, key, first) => {
    const rows = [...first[key]];
    let after = first.more.after;
    while (after) {
      const page = await state.call(name, { limit: 2, after });
      rows.push(...page[key]);
      after = page.more?.after;
    }
    return rows.map(row => row.id);
  };
  assert.deepEqual(await rest('graph_list', 'graphs', firstGraphs), graphs.map(graph => graph.id).reverse());
  assert.deepEqual(await rest('room_list', 'rooms', firstRooms), rooms.map(room => room.id).reverse());
  assert.deepEqual(await rest('session_search', 'sessions', firstSessions), [ali.id, leo.id]);
});

function rawGet(port, path, host) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path, headers: { Host: host } }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body, cors: response.headers['access-control-allow-origin'] }));
    });
    request.on('error', reject);
    request.end();
  });
}

test('list and file routes keep the Host, origin and parameter rules', async t => {
  const runtimeRequests = [];
  const runtime = createServer((request, response) => {
    runtimeRequests.push(request.url);
    response.writeHead(500).end();
  });
  await new Promise(resolve => runtime.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => runtime.close(resolve)));
  const state = await ledger(t, { LATENT_ROOT: fixtureRoot, LATENT_URL: `http://127.0.0.1:${runtime.address().port}` });
  const { port } = state.server;
  const leo = await state.import('leo.jsonl', 'Leo plans the synthetic Lyra demo.');
  const ali = await state.import('ali.jsonl', 'Ali reviews the synthetic Lyra demo.');

  for (const path of ['/api/graphs', '/api/rooms']) {
    assert.equal((await rawGet(port, path, `evil.example:${port}`)).status, 403);
    const local = await rawGet(port, path, `localhost:${port}`);
    assert.equal(local.status, 200, 'no Origin needed');
    assert.equal(local.cors, undefined, 'no CORS headers');
  }
  const secret = 'Leo-SECRET-9';
  const cases = [
    ['/api/graphs?limit=0', 'limit must be an integer from 1 to 100.'],
    ['/api/graphs?limit=101', 'limit must be an integer from 1 to 100.'],
    ['/api/graphs?limit=1.5', 'limit must be an integer from 1 to 100.'],
    ['/api/graphs?limit=0010', 'limit must be an integer from 1 to 100.'],
    ['/api/rooms?limit=' + secret, 'limit must be an integer from 1 to 100.'],
    ['/api/graphs?limit=1&limit=2', 'Each list parameter may appear once.'],
    ['/api/rooms?party=leo&party=ali', 'Each list parameter may appear once.'],
    ['/api/sessions?limit=5&limit=5', 'Each list parameter may appear once.'],
    ['/api/graphs?sessionId=' + secret, 'sessionId must be a 64-character lowercase hex ID.'],
    ['/api/rooms?graphId=' + 'A'.repeat(64), 'graphId must be a 64-character lowercase hex ID.'],
    ['/api/graphs?after=' + secret, 'after must be a 64-character lowercase hex ID.'],
    ['/api/graphs?party=' + secret, 'party must be a party name of at most 32 lowercase letters, digits and single hyphens.'],
    ['/api/rooms?party=a--b', 'party must be a party name of at most 32 lowercase letters, digits and single hyphens.'],
    ['/api/graphs?party=' + 'x'.repeat(33), 'party must be a party name of at most 32 lowercase letters, digits and single hyphens.'],
    ['/api/graphs?after=' + 'e'.repeat(64), 'Unknown cursor.'],
    ['/api/rooms?after=' + 'e'.repeat(64), 'Unknown cursor.'],
    ['/api/sessions?after=' + 'e'.repeat(64), 'Unknown cursor.'],
    ['/api/sessions?limit=x', 'limit must be an integer from 1 to 100.'],
  ];
  for (const [path, message] of cases) assert.deepEqual(await state.get(path), { status: 400, body: { error: message } }, path);
  assert.deepEqual(await state.get('/api/graphs?unknown=1'), { status: 200, body: { graphs: [], next: null } });

  const page = await state.get('/api/sessions?q=lyra&limit=1');
  assert.deepEqual(page.body, { sessions: [page.body.sessions[0]], next: ali.id });
  assert.equal(page.body.sessions[0].id, ali.id);
  assert.deepEqual((await state.get(`/api/sessions?q=lyra&after=${ali.id}`)).body.next, null);

  // Writes keep their same-origin checks; a query string does not turn a publish into a list.
  const foreign = { Origin: 'https://foreign.example' };
  const packet = v2(leo, 'leo', 'Lyra goal');
  assert.equal((await state.post('/api/graphs', packet, foreign)).status, 403);
  const published = await state.post('/api/graphs?limit=1', packet);
  assert.equal(published.status, 200);
  assert.equal(published.body.graph.packet.party, 'leo');
  const other = await state.publish(v2(ali, 'ali', 'Lyra review', { links: [{ from: 'goal', graph: published.body.graph.id, to: 'goal', type: 'matches' }] }));
  assert.equal((await state.post('/api/rooms', { graphIds: [published.body.graph.id, other.id] }, foreign)).status, 403);
  const room = (await state.post('/api/rooms', { graphIds: [published.body.graph.id, other.id] })).body.room;
  const decision = await state.post(`/api/rooms/${room.id}/decisions`, { proposalId: room.proposals[0].id, party: 'leo', choice: 'confirm' });
  assert.equal(decision.status, 403);

  assert.equal((await state.post('/api/latent/files', { paths: ['src/notify.js'] }, foreign)).status, 403);
  const files = await state.post('/api/latent/files', { paths: ['src/notify.js', 'src/config.js'] });
  assert.equal(files.status, 200);
  assert.deepEqual(files.body.files.map(file => file.path), ['src/notify.js', 'src/config.js']);
  assert.equal(files.body.mode, 'text');
  assert.match(files.body.files[0].text, /^1\| /u);
  assert.deepEqual(await state.post('/api/latent/files', { paths: ['src/notify.js'], question: 'q' }),
    { status: 400, body: { error: 'Latent files accepts only paths.' } });
  assert.equal((await state.post('/api/latent/files', { paths: ['.env'] })).status, 400);
  assert.equal((await state.post('/api/latent/files', { paths: ['../package.json'] })).status, 400);
  assert.deepEqual(runtimeRequests, [], 'file reads never contact the runtime');
});

test('the browser and CLI search still get every matching session', async t => {
  const state = await ledger(t);
  const keyword = 'quasar' + Date.now().toString(36);
  const imported = [];
  for (let index = 0; index < 150; index += 1) imported.push((await state.import(`s${index}.jsonl`, `Synthetic ${keyword} session ${index}`)).id);

  const response = await fetch(`${state.server.origin}/api/sessions?q=${keyword}`);
  const bodyText = await response.text();
  const store = openStore(state.database);
  try {
    assert.equal(bodyText, JSON.stringify({ sessions: store.list(keyword, '') }));
  } finally {
    store.close();
  }
  assert.equal(JSON.parse(bodyText).sessions.length, 150);

  const cli = spawn(process.execPath, ['src/cli.mjs', 'search', keyword], { env: { ...process.env, PORT: String(state.server.port) }, stdio: ['ignore', 'pipe', 'inherit'] });
  let output = '';
  for await (const chunk of cli.stdout) output += chunk;
  assert.deepEqual(JSON.parse(output).map(session => session.id), [...imported].reverse());

  const first = await state.call('session_search', { query: keyword });
  assert.equal(first.sessions.length, 100);
  assert.equal(first.more.after, imported[50]);
  const second = await state.call('session_search', { query: keyword, after: first.more.after });
  assert.deepEqual(Object.keys(second), ['sessions']);
  assert.deepEqual([...first.sessions, ...second.sessions].map(session => session.id), [...imported].reverse());
});
