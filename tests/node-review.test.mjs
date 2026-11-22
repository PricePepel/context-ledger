// Card P2c (ADR-7c, 7d): a person approves or rejects a version 3 node by its hash.
// Synthetic transcripts only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { ConflictError } from '../src/errors.mjs';
import { schemaVersion } from '../src/migrate.mjs';
import { nodeSha256, reviewerRule } from '../src/reviews.mjs';
import { InputError, openStore } from '../src/store.mjs';
import { bearer, ledgerToken } from './ledger-auth.mjs';
import { startMcp } from './mcp-client.mjs';

const uuid = n => `0000000${n}-aaaa-4bbb-8ccc-00000000000${n}`;
const claude = turns => turns.map(([role, text], index) => JSON.stringify({ type: role, uuid: uuid(index + 1), message: { role, content: text } })).join('\n');
const transcript = claude([['user', 'Leo: the adapter ships on port 4317.'], ['assistant', 'Noted: port 4317, Friday.'], ['user', 'Ali reviews on Thursday.']]);
const key = n => `u:${uuid(n)}`;
const nodes = (portLabel = 'Port 4317') => [
  { id: 'port', kind: 'decision', label: portLabel, evidence: [{ message: key(1) }, { message: key(2) }] },
  { id: 'review', kind: 'action', status: 'pending', label: 'Ali reviews the outline', evidence: [{ message: key(3) }] },
];
const packet = (sessionId, list = nodes()) => ({ version: 3, sessionId, party: 'leo', nodes: list, edges: [] });

test('P2c: a node hash covers what a person checks, not the order or the ID', () => {
  const store = openStore(':memory:');
  const session = store.importTranscript({ provider: 'claude', source: 'leo.jsonl', transcript });
  const graph = store.publishGraph(packet(session.id));
  assert.deepEqual(graph.nodeHashes.map(entry => entry.id), graph.packet.nodes.map(node => node.id), 'canonical node order');
  const port = graph.packet.nodes.find(node => node.id === 'port');
  assert.equal(graph.nodeHashes.find(entry => entry.id === 'port').sha256, nodeSha256(port));
  assert.match(nodeSha256(port), /^[a-f0-9]{64}$/u);
  // Reordered nodes and citations: the same hashes.
  const reordered = store.publishGraph(packet(session.id, [nodes()[1], { ...nodes()[0], evidence: [...nodes()[0].evidence].reverse() }]));
  assert.deepEqual(reordered.nodeHashes, graph.nodeHashes);
  // Each checked field moves the hash; the ID does not.
  const canonicalPort = graph.packet.nodes.find(node => node.id === 'port');
  for (const changed of [{ label: 'Port 4400' }, { kind: 'goal' }, { evidence: [{ message: key(1) }] }]) {
    assert.notEqual(nodeSha256({ ...canonicalPort, ...changed }), nodeSha256(canonicalPort), JSON.stringify(changed));
  }
  const review = graph.packet.nodes.find(node => node.id === 'review');
  assert.notEqual(nodeSha256({ ...review, status: 'completed' }), nodeSha256(review));
  assert.equal(nodeSha256({ ...canonicalPort, id: 'renamed' }), nodeSha256(canonicalPort));
  // Versions 1 and 2 have none.
  const v2 = store.publishGraph({ version: 2, sessionId: session.id, party: 'ali', nodes: [{ id: 'a', kind: 'goal', label: 'Ship', evidenceLines: [1] }], edges: [] });
  assert.equal(v2.nodeHashes, undefined);
  store.close();
});

test('P2c: a decision sticks to its hash: kept on republish, gone for a changed node, never in another session', () => {
  const store = openStore(':memory:');
  const session = store.importTranscript({ provider: 'claude', source: 'leo.jsonl', transcript });
  const graph = store.publishGraph(packet(session.id));
  const hash = id => graph.nodeHashes.find(entry => entry.id === id).sha256;
  let reviews = store.reviewNode(graph.id, { nodeId: 'port', nodeSha256: hash('port'), decision: 'approve', reviewer: 'Leo Park' });
  reviews = store.reviewNode(graph.id, { nodeId: 'review', nodeSha256: hash('review'), decision: 'reject', reviewer: 'Ali' });
  assert.deepEqual(reviews.map(row => [row.nodeId, row.decision, row.reviewer]), [['port', 'approve', 'Leo Park'], ['review', 'reject', 'Ali']]);
  assert.match(reviews[0].decidedAt, /^\d{4}-\d\d-\d\dT/u);
  // The latest decision for a hash replaces the one before.
  reviews = store.reviewNode(graph.id, { nodeId: 'review', nodeSha256: hash('review'), decision: 'approve', reviewer: 'Ali' });
  assert.equal(reviews.find(row => row.nodeId === 'review').decision, 'approve');

  // The party publishes again from the same session: the changed node starts unreviewed.
  const republished = store.publishGraph(packet(session.id, nodes('Port 4317 on Friday')));
  assert.deepEqual(store.graphReviews(republished.id).map(row => row.nodeId), ['review']);
  // The old snapshot still shows both.
  assert.deepEqual(store.graphReviews(graph.id).map(row => row.nodeId), ['port', 'review']);
  // A decision on the old hash, sent from a page showing the new graph, is refused.
  assert.throws(() => store.reviewNode(republished.id, { nodeId: 'port', nodeSha256: hash('port'), decision: 'approve', reviewer: 'Leo' }),
    error => error instanceof ConflictError && error.message === 'This node has changed since it was shown; reload the graph and review it again.');

  // Another session's graph with the same nodes sees none of these decisions.
  const other = store.importTranscript({ provider: 'claude', source: 'leo-copy.jsonl', transcript: claude([['user', 'Leo: the adapter ships on port 4317.'], ['assistant', 'Noted: port 4317, Friday.'], ['user', 'Ali reviews on Thursday!']]) });
  const elsewhere = store.publishGraph(packet(other.id));
  assert.deepEqual(store.graphReviews(elsewhere.id), []);
  store.close();
});

test('P2c: bad reviews are refused in fixed words', () => {
  const store = openStore(':memory:');
  const session = store.importTranscript({ provider: 'claude', source: 'leo.jsonl', transcript });
  const graph = store.publishGraph(packet(session.id));
  const hash = graph.nodeHashes[0].sha256;
  const nodeId = graph.nodeHashes[0].id;
  const refused = (input, message) => assert.throws(() => store.reviewNode(graph.id, input),
    error => error instanceof InputError && error.message === message, JSON.stringify(input));
  refused({ nodeId: 'nope', nodeSha256: hash, decision: 'approve', reviewer: 'Leo' }, 'Unknown node in this graph.');
  refused({ nodeId, nodeSha256: 'X'.repeat(64), decision: 'approve', reviewer: 'Leo' }, 'nodeSha256 must be a 64-character lowercase hex hash.');
  refused({ nodeId, nodeSha256: hash, decision: 'merge', reviewer: 'Leo' }, 'decision must be approve, edit or reject.');
  for (const reviewer of ['', ' ', 'x'.repeat(65), `Leo${String.fromCodePoint(0x202e)}`, `Le${String.fromCodePoint(10)}o`, 7]) {
    refused({ nodeId, nodeSha256: hash, decision: 'approve', reviewer }, reviewerRule);
  }
  refused({ nodeId, nodeSha256: hash, decision: 'approve', reviewer: 'Leo', extra: 1 }, 'A review has only nodeId, nodeSha256, decision, reviewer and, for an edit, label.');
  refused(null, 'A review must be a JSON object.');
  const v2 = store.publishGraph({ version: 2, sessionId: session.id, party: 'ali', nodes: [{ id: 'a', kind: 'goal', label: 'Ship', evidenceLines: [1] }], edges: [] });
  assert.throws(() => store.reviewNode(v2.id, { nodeId: 'a', nodeSha256: hash, decision: 'approve', reviewer: 'Leo' }), /Only version 3 graph nodes are reviewed by hash\./u);
  assert.equal(store.reviewNode('e'.repeat(64), { nodeId, nodeSha256: hash, decision: 'approve', reviewer: 'Leo' }), undefined);
  store.close();
});

test('P2c: a version 4 file gains the reviews table in place; the step is version 5', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-p2c-migrate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'ledger.sqlite');
  openStore(path).close();
  const raw = new DatabaseSync(path);
  raw.exec('DROP TABLE IF EXISTS node_reviews; PRAGMA user_version = 4;');
  raw.close();
  // I3 added version 6 on top; the file goes to the newest version.
  assert.ok(schemaVersion >= 5);
  openStore(path).close();
  const check = new DatabaseSync(path);
  assert.equal(check.prepare('PRAGMA user_version').get().user_version, schemaVersion);
  // P3 (version 7) moves P2c's rows into review events and drops node_reviews.
  assert.equal(check.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'node_reviews'").get().n, 0);
  assert.ok(check.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'review_events'").get().n === 1);
  check.close();
});

async function startLedger(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-p2c-'));
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
  return { port, database, origin, auth: bearer(await ledgerToken(database, port)), mcp: () => { const client = startMcp(port, { CONTEXT_LEDGER_DB: database }); clients.push(client); return client; } };
}

test('P2c: the review route is for people in the browser; reads carry the decisions', async t => {
  const ledger = await startLedger(t);
  const json = { 'Content-Type': 'application/json' };
  const post = async (path, body, headers) => {
    const response = await fetch(ledger.origin + path, { method: 'POST', headers: { ...json, ...headers }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const { session } = (await post('/api/import', { provider: 'claude', source: 'leo.jsonl', transcript }, { ...ledger.auth, Origin: ledger.origin })).body;
  const { graph } = (await post('/api/graphs', packet(session.id), { ...ledger.auth, Origin: ledger.origin })).body;
  const [first] = graph.nodeHashes;
  const review = { nodeId: first.id, nodeSha256: first.sha256, decision: 'approve', reviewer: 'Leo Park' };
  // A browser signs in with a one-time link and then holds a session cookie.
  const { path } = (await post('/api/login', {}, ledger.auth)).body;
  const signedIn = await fetch(ledger.origin + path, { redirect: 'manual' });
  const cookie = signedIn.headers.get('set-cookie').split(';')[0];
  const browser = { Cookie: cookie, Origin: ledger.origin, 'Sec-Fetch-Site': 'same-origin' };
  const refusal = { status: 403, body: { error: 'Nodes are reviewed by people in the browser, signed in.' } };
  assert.deepEqual(await post(`/api/graphs/${graph.id}/reviews`, review, { ...ledger.auth, Origin: ledger.origin }), refusal, 'an agent client');
  // P2c review: the bearer token with a browser's header is still not a browser.
  assert.deepEqual(await post(`/api/graphs/${graph.id}/reviews`, review, { ...ledger.auth, Origin: ledger.origin, 'Sec-Fetch-Site': 'same-origin' }), refusal, 'token and header');
  assert.deepEqual(await post(`/api/graphs/${graph.id}/reviews`, review, { Cookie: cookie, Origin: ledger.origin }), refusal, 'a cookie without the header');
  assert.equal((await post(`/api/graphs/${graph.id}/reviews`, review, { Origin: ledger.origin, 'Sec-Fetch-Site': 'same-origin' })).status, 401, 'no token or cookie');
  assert.equal((await post(`/api/graphs/${graph.id}/reviews`, review, { ...browser, Origin: 'http://evil.test' })).status, 403, 'a foreign Origin');
  const recorded = await post(`/api/graphs/${graph.id}/reviews`, review, browser);
  assert.equal(recorded.status, 200, JSON.stringify(recorded.body));
  assert.deepEqual(recorded.body.reviews.map(row => [row.nodeId, row.decision, row.reviewer]), [[first.id, 'approve', 'Leo Park']]);
  assert.deepEqual(await post(`/api/graphs/${graph.id}/reviews`, { ...review, nodeSha256: 'f'.repeat(64) }, browser),
    { status: 409, body: { error: 'This node has changed since it was shown; reload the graph and review it again.' } });
  assert.equal((await post(`/api/graphs/${'e'.repeat(64)}/reviews`, review, browser)).status, 404);
  assert.equal((await post(`/api/graphs/${graph.id}/reviews`, { ...review, decision: 'maybe' }, browser)).status, 400);

  const read = await (await fetch(`${ledger.origin}/api/graphs/${graph.id}`, { headers: ledger.auth })).json();
  assert.deepEqual(read.graph.reviews.map(row => row.nodeId), [first.id]);
  // MCP passes the decisions on as data, and has no tool to make one.
  const client = ledger.mcp();
  await client.request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  const viaMcp = JSON.parse((await client.call(2, 'graph_read', { graphId: graph.id })).content[0].text);
  assert.deepEqual(viaMcp.graph.reviews.map(row => row.reviewer), ['Leo Park']);
  const { result } = await client.request(3, 'tools/list');
  assert.equal(result.tools.some(tool => /review/iu.test(tool.name)), false);
});

// P2c review (Codex round 1).
test('P2c review: a label JCS cannot hash is a 400, not a server error', () => {
  const store = openStore(':memory:');
  const session = store.importTranscript({ provider: 'claude', source: 'leo.jsonl', transcript });
  const lone = String.fromCharCode(0xd800);
  assert.throws(() => store.publishGraph(packet(session.id, [{ ...nodes()[0], label: `Port ${lone}4317` }])),
    error => error.constructor.name === 'GraphInputError' && error.message === 'A label must be well-formed Unicode text.');
  // Version 2 keeps what it accepted before.
  assert.ok(store.publishGraph({ version: 2, sessionId: session.id, party: 'ali', nodes: [{ id: 'a', kind: 'goal', label: `Ship ${lone}`, evidenceLines: [1] }], edges: [] }).id);
  store.close();
});

test('P2c review: a version 3 graph stored before P2c gains its hashes by a republish, keeping its ID and time', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-p2c-legacy-'));
  const path = join(directory, 'ledger.sqlite');
  const store = openStore(path);
  let raw;
  // One cleanup, in order: Windows cannot remove an open database.
  t.after(async () => {
    store.close();
    raw?.close();
    await rm(directory, { recursive: true, force: true });
  });
  const session = store.importTranscript({ provider: 'claude', source: 'leo.jsonl', transcript });
  const graph = store.publishGraph(packet(session.id));
  // What P2b stored: grounding and citations, no nodeHashes.
  raw = new DatabaseSync(path);
  raw.prepare("UPDATE graphs SET payload = json_remove(payload, '$.nodeHashes') WHERE id = ?").run(graph.id);
  const stamp = raw.prepare('SELECT created_at AS at FROM graphs WHERE id = ?').get(graph.id).at;
  assert.equal(store.getGraph(graph.id).nodeHashes, undefined);
  assert.throws(() => store.reviewNode(graph.id, { nodeId: 'port', nodeSha256: graph.nodeHashes[0].sha256, decision: 'approve', reviewer: 'Leo' }), /Only version 3 graph nodes/u);
  const again = store.publishGraph(packet(session.id));
  assert.equal(again.id, graph.id);
  assert.deepEqual(again.nodeHashes, graph.nodeHashes);
  assert.equal(raw.prepare('SELECT created_at AS at FROM graphs WHERE id = ?').get(graph.id).at, stamp);
  assert.equal(store.reviewNode(graph.id, { nodeId: 'port', nodeSha256: graph.nodeHashes.find(entry => entry.id === 'port').sha256, decision: 'approve', reviewer: 'Leo' }).length, 1);
});

test('P2c review: decisions stay with their party and node ID, and the recipient enters the hash', () => {
  const store = openStore(':memory:');
  const session = store.importTranscript({ provider: 'claude', source: 'leo.jsonl', transcript });
  // Two nodes with the same content: one hash, two decisions.
  const twins = store.publishGraph(packet(session.id, [
    { id: 'first', kind: 'goal', label: 'Ship it', evidence: [{ message: key(1) }] },
    { id: 'second', kind: 'goal', label: 'Ship it', evidence: [{ message: key(1) }] },
  ]));
  const [a, b] = twins.nodeHashes;
  assert.equal(a.sha256, b.sha256);
  store.reviewNode(twins.id, { nodeId: 'first', nodeSha256: a.sha256, decision: 'approve', reviewer: 'Leo' });
  assert.deepEqual(store.graphReviews(twins.id).map(row => row.nodeId), ['first']);
  // Another party's graph from the same session with the same node sees nothing.
  const ali = store.publishGraph({ ...packet(session.id, [{ id: 'first', kind: 'goal', label: 'Ship it', evidence: [{ message: key(1) }] }]), party: 'ali' });
  assert.deepEqual(store.graphReviews(ali.id), []);
  // A question's recipient is part of what it says.
  const asked = { id: 'q', kind: 'question', status: 'open', to: 'ali', label: 'Which port?', evidence: [{ message: key(1) }] };
  assert.notEqual(nodeSha256({ ...asked, to: 'bea' }), nodeSha256(asked));
  store.close();
});

