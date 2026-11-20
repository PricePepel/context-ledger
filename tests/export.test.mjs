import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { exportNodeId } from '../src/export.mjs';
import { InputError, openStore } from '../src/store.mjs';
import { bearer, ledgerToken } from './ledger-auth.mjs';

// Card G12: graphs as one node-link file for code-graph tools. Synthetic data only.
const say = text => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
const idPattern = /^[a-z0-9_]+$/u;
const cp = (...points) => String.fromCodePoint(...points);

function twoParties(store) {
  const aliSession = store.importTranscript({ provider: 'codex', source: 'ali.jsonl', transcript: JSON.stringify({
    type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'GPU time. Which port?' }] },
  }) });
  const ali = store.publishGraph({ version: 2, sessionId: aliSession.id, party: 'ali', edges: [], nodes: [
    { id: 'gpu-time', kind: 'offer', label: 'GPU time', evidenceLines: [1] },
    { id: 'which-port', kind: 'question', to: 'leo', status: 'open', label: 'Which port?', evidenceLines: [1] },
  ] });
  const leoSession = store.importTranscript({ provider: 'claude', source: 'leo-orbit.jsonl', transcript: [
    say('First plan: port 4400.'), say('Port 4317 now. Pair on the adapter. Record the demo.'),
  ].join('\n') });
  const leo = store.publishGraph({ version: 2, sessionId: leoSession.id, party: 'leo',
    nodes: [
      { id: 'port', kind: 'decision', label: 'Use port 4317', evidenceLines: [2] },
      { id: 'old-port', kind: 'decision', label: 'Use port 4400', evidenceLines: [1] },
      { id: 'pairing', kind: 'offer', label: 'Pair on the adapter', evidenceLines: [2] },
      { id: 'record', kind: 'action', status: 'pending', label: 'Record the demo', evidenceLines: [1, 2] },
      { id: 'demo', kind: 'goal', label: 'Demo live', evidenceLines: [2] },
    ],
    edges: [{ from: 'port', to: 'old-port', type: 'supersedes' }, { from: 'record', to: 'demo', type: 'advances' }],
    links: [{ from: 'port', graph: ali.id, to: 'which-port', type: 'answers' }, { from: 'pairing', graph: ali.id, to: 'gpu-time', type: 'matches' }],
  });
  return { ali, leo, aliSession, leoSession };
}

const id = (graph, node) => exportNodeId(graph.id, node);

test('a bundle of two parties is one undirected node-link file whose links reach both graphs', () => {
  const store = openStore(':memory:');
  const { ali, leo } = twoParties(store);
  const out = store.exportGraphs([leo.id, ali.id]);
  assert.equal(out.directed, false, 'Graphify merges into an undirected graph');
  assert.equal(out.multigraph, false);
  assert.deepEqual(out.graph, { source: 'context-ledger', links_left_out: 0, ledger_graphs: [
    { id: leo.id, party: 'leo', session: leo.packet.sessionId }, { id: ali.id, party: 'ali', session: ali.packet.sessionId }] });
  assert.equal(out.nodes.length, 7);
  assert.deepEqual(out.nodes.find(node => node.ledger_node === 'record'), {
    id: id(leo, 'record'), label: 'Record the demo', file_type: 'concept', source_file: 'leo-orbit.jsonl', source_location: 'L1, L2',
    kind: 'action', status: 'pending', party: 'leo', ledger_graph: leo.id, ledger_node: 'record',
  });
  assert.equal(out.nodes.find(node => node.ledger_node === 'which-port').to, 'leo');
  assert.equal(out.nodes.find(node => node.ledger_node === 'port').file_type, 'rationale');
  assert.deepEqual(out.links.find(link => link.relation === 'supersedes'), {
    source: id(leo, 'port'), target: id(leo, 'old-port'), relation: 'supersedes',
    ledger_from: id(leo, 'port'), ledger_to: id(leo, 'old-port'), confidence: 'EXTRACTED', confidence_score: 1,
    source_file: 'leo-orbit.jsonl', weight: 1, ledger_graph: leo.id,
  });
  // Review round 2: both cross-graph links in full, so a dropped field fails.
  const cross = (from, to, relation) => ({
    source: id(leo, from), target: id(ali, to), relation, ledger_from: id(leo, from), ledger_to: id(ali, to),
    confidence: 'EXTRACTED', confidence_score: 1, source_file: 'leo-orbit.jsonl', weight: 1, ledger_graph: leo.id, ledger_link_graph: ali.id,
  });
  assert.deepEqual(out.links.find(link => link.relation === 'answers'), cross('port', 'which-port', 'answers'));
  assert.deepEqual(out.links.find(link => link.relation === 'matches'), cross('pairing', 'gpu-time', 'matches'));
  const known = new Set(out.nodes.map(node => node.id));
  for (const link of out.links) assert.ok(known.has(link.source) && known.has(link.target), 'every end is a node of the bundle');
  for (const node of out.nodes) assert.match(node.id, idPattern);
  assert.equal(out.links.length, 4);
  assert.deepEqual(store.exportGraphs([leo.id, ali.id]), out, 'the same IDs every time');
  store.close();
});

test('two snapshots of one party never share a node ID', () => {
  const store = openStore(':memory:');
  const { aliSession, ali } = twoParties(store);
  const again = store.publishGraph({ version: 2, sessionId: aliSession.id, party: 'ali', edges: [], nodes: [
    { id: 'which-port', kind: 'question', to: 'leo', status: 'open', label: 'Which port, still?', evidenceLines: [1] }] });
  const out = store.exportGraphs([ali.id, again.id]);
  const ports = out.nodes.filter(node => node.ledger_node === 'which-port');
  assert.equal(ports.length, 2);
  assert.notEqual(ports[0].id, ports[1].id);
  assert.match(ports[0].id, /^ctm_[a-f0-9]{16}__which_port$/u);
  store.close();
});

test('a link to a graph outside the bundle is left out and counted, never a node without a label', () => {
  const store = openStore(':memory:');
  const { leo } = twoParties(store);
  const alone = store.exportGraphs([leo.id]);
  assert.equal(alone.graph.links_left_out, 2);
  assert.deepEqual(alone.links.map(link => link.relation).sort(), ['advances', 'supersedes']);
  const known = new Set(alone.nodes.map(node => node.id));
  for (const link of alone.links) assert.ok(known.has(link.target));
  assert.equal(store.exportGraphs([leo.id, 'e'.repeat(64)]), undefined, 'an unknown graph is not found');
  assert.throws(() => store.exportGraphs([leo.id, leo.id]), error => error instanceof InputError && /once/u.test(error.message));
  store.close();
});

test('a version 1 graph exports under its graph ID too', () => {
  const store = openStore(':memory:');
  const session = store.importTranscript({ provider: 'claude', source: 'v1.jsonl', transcript: say('Ship it, then test.') });
  const graph = store.publishGraph({ version: 1, sessionId: session.id, edges: [],
    nodes: [{ id: 'ship-it', kind: 'goal', label: 'Ship it', evidenceLines: [1] }] });
  const out = store.exportGraphs([graph.id]);
  assert.deepEqual(out.nodes.map(node => node.id), [`ctm_${graph.id.slice(0, 16)}__ship_it`]);
  assert.equal('party' in out.nodes[0], false);
  assert.equal(exportNodeId('a'.repeat(64), 'x-y'), `ctm_${'a'.repeat(16)}__x_y`);
  store.close();
});

async function startServer(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ledger-g12-'));
  const child = spawn(process.execPath, ['src/server.mjs'], {
    env: { ...process.env, PORT: '0', CONTEXT_LEDGER_DB: join(dir, 'ledger.sqlite') }, stdio: ['ignore', 'pipe', 'ignore'],
  });
  t.after(async () => {
    child.kill();
    await new Promise(resolve => child.once('exit', resolve));
    await rm(dir, { recursive: true, force: true });
  });
  let output = '';
  for await (const chunk of child.stdout) {
    output += chunk;
    const match = output.match(/listening at http:\/\/127\.0\.0\.1:(\d+)/u);
    if (match) {
      // P1e: the API needs the token the server wrote next to its database.
      const database = join(dir, 'ledger.sqlite');
      return { origin: `http://127.0.0.1:${match[1]}`, port: match[1], database, auth: bearer(await ledgerToken(database, Number(match[1]))) };
    }
  }
  throw new Error('server did not start');
}

test('the export routes and the CLI: escaped JSON that parses back, fixed refusals', async t => {
  const { origin, port, database, auth } = await startServer(t);
  // P1e: every request in this test carries the token, and so does the CLI's.
  const fetch = (url, options = {}) => globalThis.fetch(url, { ...options, headers: { ...auth, ...options.headers } });
  const cliEnv = { ...process.env, PORT: port, CONTEXT_LEDGER_DB: database };
  const post = (path, body) => fetch(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) })
    .then(response => response.json());
  const rlo = cp(0x202e);
  // Labels may not hold controls (the schema refuses them), but a format character such as a
  // zero-width space is allowed there and must still come out escaped.
  const c1 = cp(0x200b);
  const { session } = await post('/api/import', { provider: 'claude', source: `odd${rlo}name.jsonl`, transcript: say('Port 4317.') });
  const { graph } = await post('/api/graphs', { version: 2, sessionId: session.id, party: 'leo', edges: [],
    nodes: [{ id: 'port', kind: 'decision', label: `Use port 4317 ${c1}now`, evidenceLines: [1] }] });

  const single = await fetch(`${origin}/api/graphs/${graph.id}/export`);
  assert.equal(single.status, 200);
  const raw = await single.text();
  for (const character of [rlo, c1]) assert.ok(!raw.includes(character), 'no raw control or bidi character in the HTTP body');
  const body = JSON.parse(raw);
  assert.equal(body.nodes[0].label, `Use port 4317 ${c1}now`, 'the escapes read back as the same text');
  assert.equal(body.nodes[0].source_file, `odd${rlo}name.jsonl`);
  assert.equal(body.directed, false, 'the body is the node-link JSON itself, with no wrapper');
  const bundle = await fetch(`${origin}/api/export?graph=${graph.id}`).then(response => response.json());
  assert.deepEqual(bundle, body);

  const refused = async (path, error) => {
    const response = await fetch(origin + path);
    assert.deepEqual({ status: response.status, body: await response.json() }, { status: 400, body: { error } }, path);
  };
  const many = 'The export takes 1 to 20 graph=<graph ID> parameters and nothing else.';
  for (const query of ['', '?x=1', `?graph=${graph.id}&x=1`, '?graph=nope', `?${Array.from({ length: 21 }, () => `graph=${graph.id}`).join('&')}`]) {
    await refused(`/api/export${query}`, many);
  }
  await refused(`/api/export?graph=${graph.id}&graph=${graph.id}`, 'Each graph may appear once in an export.');
  await refused(`/api/graphs/${graph.id}/export?format=node-link`, 'This export takes no parameters.');
  for (const path of [`/api/graphs/${'e'.repeat(64)}/export`, `/api/export?graph=${'e'.repeat(64)}`]) {
    const missing = await fetch(origin + path);
    assert.deepEqual({ status: missing.status, body: await missing.json() }, { status: 404, body: { error: 'Not found.' } }, path);
  }

  const cli = spawnSync(process.execPath, ['src/cli.mjs', 'graph', 'export', graph.id], { env: cliEnv, encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  for (const character of [rlo, c1]) assert.ok(!cli.stdout.includes(character));
  assert.ok(cli.stdout.includes(`odd${String.fromCodePoint(0x5c)}u202ename.jsonl`));
  assert.deepEqual(JSON.parse(cli.stdout), body);
  // Review round 2: two graphs through the route and the CLI; the second is not dropped.
  const other = await post('/api/import', { provider: 'codex', source: 'ali.jsonl', transcript: JSON.stringify({
    type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Ali: use port 9999.' }] } }) });
  const ali = (await post('/api/graphs', { version: 2, sessionId: other.session.id, party: 'ali', edges: [],
    nodes: [{ id: 'other-port', kind: 'decision', label: 'Use port 9999', evidenceLines: [1] }],
    links: [{ from: 'other-port', graph: graph.id, to: 'port', type: 'conflicts' }] })).graph;
  const pair = await fetch(`${origin}/api/export?graph=${graph.id}&graph=${ali.id}`).then(response => response.json());
  assert.equal(pair.nodes.length, 2);
  assert.equal(pair.graph.links_left_out, 0);
  assert.deepEqual(pair.links.map(link => [link.ledger_from, link.ledger_to, link.relation]),
    [[exportNodeId(ali.id, 'other-port'), exportNodeId(graph.id, 'port'), 'conflicts']]);
  const both = spawnSync(process.execPath, ['src/cli.mjs', 'graph', 'export', graph.id, ali.id], { env: cliEnv, encoding: 'utf8' });
  assert.equal(both.status, 0, both.stderr);
  assert.deepEqual(JSON.parse(both.stdout), pair);
  const bad = spawnSync(process.execPath, ['src/cli.mjs', 'graph', 'export', 'nope'], { env: cliEnv, encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Usage:/u);
});
