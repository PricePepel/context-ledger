// Card P2a (ADR-7a): graphs, links, rooms and the MCP list tools are project-scoped.
// Synthetic transcripts only: two projects, orbit and vela, each with two parties.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { InputError, openStore } from '../src/store.mjs';
import { GraphInputError } from '../src/graph.mjs';
import { bearer, ledgerToken } from './ledger-auth.mjs';
import { startMcp } from './mcp-client.mjs';

const say = text => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });

function graphOf(store, sessionId, party, links = []) {
  return store.publishGraph({
    version: 2, sessionId, party,
    nodes: [
      { id: 'offer', kind: 'offer', label: `${party} offers review time`, evidenceLines: [1] },
      { id: 'goal', kind: 'goal', label: `${party} ships the adapter`, evidenceLines: [1] },
    ],
    edges: [],
    ...(links.length ? { links } : {}),
  });
}

function setup() {
  const store = openStore(':memory:');
  const session = (name, project) => store.importTranscript({ provider: 'claude', source: `${name}.jsonl`, transcript: say(`${name}: synthetic orbit and vela notes`), project });
  const sessions = {
    orbitLeo: session('orbit-leo', 'orbit'), orbitAli: session('orbit-ali', 'orbit'),
    velaLeo: session('vela-leo', 'vela'), velaAli: session('vela-ali', 'vela'),
  };
  const orbitAli = graphOf(store, sessions.orbitAli.id, 'ali');
  const velaAli = graphOf(store, sessions.velaAli.id, 'ali');
  const orbitLeo = graphOf(store, sessions.orbitLeo.id, 'leo', [{ from: 'offer', graph: orbitAli.id, to: 'offer', type: 'matches' }]);
  return { store, sessions, orbitAli, velaAli, orbitLeo };
}

test('P2a: graph rows name their session\'s project, and the project filter pages', () => {
  const { store, orbitAli, velaAli, orbitLeo } = setup();
  const all = store.listGraphs({ limit: 10 }).graphs;
  assert.deepEqual(all.map(row => [row.id, row.project]), [[orbitLeo.id, 'orbit'], [velaAli.id, 'vela'], [orbitAli.id, 'orbit']]);
  assert.deepEqual(store.listGraphs({ project: 'orbit', limit: 10 }).graphs.map(row => row.id), [orbitLeo.id, orbitAli.id]);
  const first = store.listGraphs({ project: 'orbit', limit: 1 });
  assert.deepEqual([first.graphs.map(row => row.id), first.next], [[orbitLeo.id], orbitLeo.id]);
  assert.deepEqual(store.listGraphs({ project: 'orbit', limit: 1, after: first.next }).graphs.map(row => row.id), [orbitAli.id]);
  assert.deepEqual(store.listGraphs({ project: 'nobody', limit: 10 }), { graphs: [], next: null });
  assert.equal(Object.hasOwn(orbitLeo.packet, 'project'), false, 'no packet field names a project');
});

test('P2a: a link to a graph of another project is refused; inside one project it is accepted', () => {
  const { store, sessions, velaAli, orbitAli } = setup();
  assert.throws(() => graphOf(store, sessions.orbitLeo.id, 'leo', [{ from: 'offer', graph: velaAli.id, to: 'offer', type: 'matches' }]),
    error => error instanceof GraphInputError && error.message === 'A link must point at a graph in the same project.');
  // The same link from vela is fine, and so is orbit to orbit (setup did it once).
  assert.ok(graphOf(store, sessions.velaLeo.id, 'leo', [{ from: 'goal', graph: velaAli.id, to: 'goal', type: 'matches' }]).id);
  assert.ok(graphOf(store, sessions.orbitLeo.id, 'leo', [{ from: 'goal', graph: orbitAli.id, to: 'goal', type: 'matches' }]).id);
});

test('P2a: rooms need one project; room rows name it and filter by it; newer-graph notices stay in the project', () => {
  const { store, sessions, orbitAli, velaAli, orbitLeo } = setup();
  assert.throws(() => store.openRoom({ graphIds: [orbitLeo.id, velaAli.id] }),
    error => error instanceof InputError && error.message === 'A room needs two graphs from the same project.');
  const room = store.openRoom({ graphIds: [orbitLeo.id, orbitAli.id] });
  const velaLeo = graphOf(store, sessions.velaLeo.id, 'leo');
  const velaRoom = store.openRoom({ graphIds: [velaLeo.id, velaAli.id] });
  assert.deepEqual(store.listRooms({ limit: 10 }).rooms.map(row => [row.id, row.project]), [[velaRoom.id, 'vela'], [room.id, 'orbit']]);
  assert.deepEqual(store.listRooms({ project: 'orbit', limit: 10 }).rooms.map(row => row.id), [room.id]);
  assert.deepEqual(store.listRooms({ project: 'nobody', limit: 10 }).rooms, []);
  // A newer ali graph in vela, from another session, is not a newer graph of the orbit room.
  graphOf(store, store.importTranscript({ provider: 'claude', source: 'vela-ali-2.jsonl', transcript: say('ali again in vela'), project: 'vela' }).id, 'ali');
  assert.deepEqual(store.getRoom(room.id).newerGraphs, []);
  // One in orbit is.
  const newer = graphOf(store, store.importTranscript({ provider: 'claude', source: 'orbit-ali-2.jsonl', transcript: say('ali again in orbit'), project: 'orbit' }).id, 'ali');
  assert.deepEqual(store.getRoom(room.id).newerGraphs.map(entry => [entry.graphId, entry.sameSession]), [[newer.id, false]]);
});

async function startLedger(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-p2a-'));
  const database = join(directory, 'ledger.sqlite');
  const child = spawn(process.execPath, ['src/server.mjs'], { env: { ...process.env, PORT: '0', CONTEXT_LEDGER_DB: database }, stdio: ['ignore', 'pipe', 'ignore'] });
  const ended = once(child, 'exit').catch(() => {});
  let running = true;
  ended.then(() => { running = false; });
  const clients = [];
  t.after(async () => {
    await Promise.all(clients.map(client => client.close()));
    if (running) {
      child.kill();
      await ended;
    }
    await rm(directory, { recursive: true, force: true });
  });
  let output = '';
  const port = await new Promise((resolve, reject) => {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = /listening at http:\/\/127\.0\.0\.1:(\d+)/u.exec(output);
      if (match) resolve(Number(match[1]));
    });
    ended.then(() => reject(new Error('The server exited before listening.')));
  });
  const origin = `http://127.0.0.1:${port}`;
  const auth = bearer(await ledgerToken(database, port));
  const call = async (method, path, body) => {
    const response = await fetch(origin + path, {
      method, headers: { ...auth, ...(body ? { 'Content-Type': 'application/json', Origin: origin } : {}) }, body: body && JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  return { port, database, call, mcp: () => { const client = startMcp(port, { CONTEXT_LEDGER_DB: database }); clients.push(client); return client; } };
}

const slugRule = 'project must be a slug of at most 64 lowercase letters, digits and single hyphens.';

test('P2a: the HTTP lists take project with the fixed rules, and the routes still need the token', async t => {
  const ledger = await startLedger(t);
  const imported = async (name, project) => (await ledger.call('POST', '/api/import', { provider: 'claude', source: `${name}.jsonl`, transcript: say(`${name}: synthetic`), project })).body.session.id;
  const packet = (sessionId, party, links) => ({ version: 2, sessionId, party, nodes: [{ id: 'offer', kind: 'offer', label: 'Review time', evidenceLines: [1] }], edges: [], ...(links ? { links } : {}) });
  const publish = async (...args) => ledger.call('POST', '/api/graphs', packet(...args));
  const ali = (await publish(await imported('orbit-ali', 'orbit'), 'ali')).body.graph;
  const velaAli = (await publish(await imported('vela-ali', 'vela'), 'ali')).body.graph;
  const leoSession = await imported('orbit-leo', 'orbit');
  assert.deepEqual(await publish(leoSession, 'leo', [{ from: 'offer', graph: velaAli.id, to: 'offer', type: 'matches' }]),
    { status: 400, body: { error: 'A link must point at a graph in the same project.' } });
  const leo = (await publish(leoSession, 'leo', [{ from: 'offer', graph: ali.id, to: 'offer', type: 'matches' }])).body.graph;

  const list = (await ledger.call('GET', '/api/graphs?project=orbit')).body;
  assert.deepEqual(list.graphs.map(row => [row.id, row.project]), [[leo.id, 'orbit'], [ali.id, 'orbit']]);
  assert.deepEqual((await ledger.call('GET', '/api/graphs?project=nobody')).body, { graphs: [], next: null });
  for (const path of ['/api/graphs?project=Orbit', '/api/graphs?project=', '/api/rooms?project=-x', '/api/rooms?project=']) {
    assert.deepEqual(await ledger.call('GET', path), { status: 400, body: { error: slugRule } }, path);
  }
  assert.deepEqual(await ledger.call('GET', '/api/graphs?project=orbit&project=vela'), { status: 400, body: { error: 'Each list parameter may appear once.' } });

  assert.deepEqual(await ledger.call('POST', '/api/rooms', { graphIds: [leo.id, velaAli.id] }), { status: 400, body: { error: 'A room needs two graphs from the same project.' } });
  const room = (await ledger.call('POST', '/api/rooms', { graphIds: [leo.id, ali.id] })).body.room;
  assert.deepEqual((await ledger.call('GET', '/api/rooms?project=orbit')).body.rooms.map(row => [row.id, row.project]), [[room.id, 'orbit']]);
  assert.deepEqual((await ledger.call('GET', '/api/rooms?project=vela')).body.rooms, []);

  // No token, no list.
  for (const path of ['/api/graphs?project=orbit', '/api/rooms?project=orbit']) {
    assert.equal((await fetch(`http://127.0.0.1:${ledger.port}${path}`)).status, 401, path);
  }

  // MCP against the real ledger: the filter, folded, reaches the same rows.
  const client = ledger.mcp();
  await client.request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  const graphs = JSON.parse((await client.call(2, 'graph_list', { project: 'ORBIT' })).content[0].text);
  assert.deepEqual(graphs.graphs.map(row => row.id), [leo.id, ali.id]);
  const rooms = JSON.parse((await client.call(3, 'room_list', { project: 'orbit' })).content[0].text);
  assert.deepEqual(rooms.rooms.map(row => row.id), [room.id]);
  const sessions = JSON.parse((await client.call(4, 'session_search', { project: 'vela' })).content[0].text);
  assert.deepEqual(sessions.sessions.map(row => row.project), ['vela']);
  const everything = JSON.parse((await client.call(5, 'graph_list', {})).content[0].text);
  assert.equal(everything.graphs.length, 3, 'without project, every project');
});

async function fakeLedger(t, respond) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(respond(new URL(request.url, 'http://x'))));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { port: server.address().port, requests };
}

test('P2a: the MCP tools pass project on, refuse bad slugs, and refuse rows a ledger did not filter', async t => {
  const id = 'a'.repeat(64);
  let rows = 'scoped';
  const ledger = await fakeLedger(t, url => {
    const project = url.searchParams.get('project');
    const row = rows === 'scoped' ? { id, project } : rows === 'other' ? { id, project: 'vela' } : { id };
    if (url.pathname === '/api/sessions') return { sessions: [row], next: null };
    if (url.pathname === '/api/graphs') return { graphs: [row], next: null };
    return { rooms: [row], next: null };
  });
  const client = startMcp(ledger.port);
  t.after(() => client.close());
  await client.request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  let n = 2;
  for (const tool of ['session_search', 'graph_list', 'room_list']) {
    const result = await client.call(n++, tool, { project: 'Orbit-Two' });
    assert.equal(result.isError, undefined, `${tool}: ${JSON.stringify(result)}`);
    assert.match(ledger.requests.at(-1), /[?&]project=orbit-two(?:&|$)/u, tool);
    for (const kind of ['other', 'unscoped']) {
      rows = kind;
      const refused = await client.call(n++, tool, { project: 'orbit-two' });
      assert.deepEqual([refused.isError, refused.content[0].text], [true, 'This Context Ledger cannot filter by project. Restart it with npm start.'], `${tool} ${kind}`);
      // Without a filter, any row passes as before.
      assert.equal((await client.call(n++, tool, {})).isError, undefined, `${tool} ${kind} unfiltered`);
      assert.doesNotMatch(ledger.requests.at(-1), /project=/u);
      rows = 'scoped';
    }
    const count = ledger.requests.length;
    for (const project of ['', '-x', 'a'.repeat(65), 'two--hyphens', 7, 'ﬁle']) {
      const bad = await client.call(n++, tool, { project });
      assert.deepEqual([bad.isError, bad.content[0].text], [true, slugRule], `${tool} ${JSON.stringify(project)}`);
    }
    assert.equal(ledger.requests.length, count, 'a refused slug reaches no ledger');
  }
});

// P2a review (Codex round 1).
async function fileStore(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-p2a-file-'));
  const path = join(directory, 'ledger.sqlite');
  const store = openStore(path);
  const raw = new DatabaseSync(path);
  t.after(async () => {
    store.close();
    raw.close();
    await rm(directory, { recursive: true, force: true });
  });
  const session = (name, project) => store.importTranscript({ provider: 'claude', source: `${name}.jsonl`, transcript: say(`${name}: synthetic`), project });
  return { store, raw, session };
}

test('P2a review: a room opened across projects before P2a is readable but takes no choices and names no newer graph', async t => {
  const { store, raw, session } = await fileStore(t);
  const leoSession = session('leo', 'orbit');
  const aliSession = session('ali', 'orbit');
  session('vela-anchor', 'vela');
  const ali = graphOf(store, aliSession.id, 'ali');
  const leo = graphOf(store, leoSession.id, 'leo', [{ from: 'offer', graph: ali.id, to: 'offer', type: 'matches' }]);
  const room = store.openRoom({ graphIds: [leo.id, ali.id] });
  // What a file from before P2a may hold: the two sides now in two projects.
  raw.prepare("UPDATE sessions SET project_id = (SELECT id FROM projects WHERE slug = 'vela') WHERE id = ?").run(aliSession.id);
  graphOf(store, session('ali-2', 'vela').id, 'ali');
  graphOf(store, session('leo-2', 'orbit').id, 'leo');
  const view = store.getRoom(room.id);
  assert.equal(view.proposals.length, 1, 'still readable');
  assert.deepEqual(view.newerGraphs, []);
  assert.throws(() => store.decide(room.id, { proposalId: view.proposals[0].id, party: 'leo', choice: 'confirm' }),
    error => error instanceof InputError && error.message === 'This room joins graphs from two projects, so it takes no choices; open a room within one project.');
  assert.deepEqual(store.listRooms({ limit: 10 }).rooms.map(row => [row.id, row.project]), [[room.id, null]]);
  assert.deepEqual(store.listRooms({ project: 'orbit', limit: 10 }).rooms, []);
  assert.deepEqual(store.listRooms({ project: 'vela', limit: 10 }).rooms, []);
});

test('P2a review: a session without a project matches no project, not another session without one', async t => {
  const { store, raw, session } = await fileStore(t);
  const a = session('a', 'orbit');
  const b = session('b', 'orbit');
  const ali = graphOf(store, b.id, 'ali');
  // project_id is nullable (SQLite cannot add a NOT NULL foreign key); the trigger fills it only on insert.
  raw.prepare('UPDATE sessions SET project_id = NULL WHERE id IN (?, ?)').run(a.id, b.id);
  assert.throws(() => graphOf(store, a.id, 'leo', [{ from: 'offer', graph: ali.id, to: 'offer', type: 'matches' }]),
    error => error instanceof GraphInputError && error.message === 'A link must point at a graph in the same project.');
  const leo = graphOf(store, a.id, 'leo');
  assert.throws(() => store.openRoom({ graphIds: [leo.id, ali.id] }),
    error => error instanceof InputError && error.message === 'A room needs two graphs from the same project.');
  assert.deepEqual(store.listGraphs({ limit: 10 }).graphs.map(row => row.project), [null, null]);
});

test('P2a review: the project filter pages rooms across interleaved projects', () => {
  const store = openStore(':memory:');
  const session = (name, project) => store.importTranscript({ provider: 'claude', source: `${name}.jsonl`, transcript: say(`${name}: synthetic`), project });
  const rooms = [];
  for (const [index, project] of ['orbit', 'vela', 'orbit', 'vela', 'orbit'].entries()) {
    const ali = graphOf(store, session(`ali-${index}`, project).id, 'ali');
    const leo = graphOf(store, session(`leo-${index}`, project).id, 'leo');
    rooms.push({ project, id: store.openRoom({ graphIds: [leo.id, ali.id] }).id });
  }
  const walk = project => {
    const seen = [];
    let after;
    do {
      const page = store.listRooms({ project, limit: 1, after });
      seen.push(...page.rooms.map(row => row.id));
      after = page.next;
    } while (after);
    return seen;
  };
  const expected = project => rooms.filter(room => room.project === project).map(room => room.id).reverse();
  assert.deepEqual(walk('orbit'), expected('orbit'));
  assert.deepEqual(walk('vela'), expected('vela'));
  store.close();
});

test('P2a review: session_search refuses a later ledger page with a row of another project', async t => {
  const first = 'a'.repeat(64);
  const second = 'b'.repeat(64);
  const ledger = await fakeLedger(t, url => (url.searchParams.get('after') === first
    ? { sessions: [{ id: second, project: 'vela' }], next: null }
    : { sessions: [{ id: first, project: 'orbit' }], next: first }));
  const client = startMcp(ledger.port);
  t.after(() => client.close());
  await client.request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  // Without a limit the tool reads on through the ledger's pages.
  const result = await client.call(2, 'session_search', { project: 'orbit' });
  assert.deepEqual([result.isError, result.content[0].text], [true, 'This Context Ledger cannot filter by project. Restart it with npm start.']);
  assert.equal(ledger.requests.length, 2);
});
