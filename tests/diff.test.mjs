import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { diffCounts, diffGraphs, diffSections } from '../src/diff.mjs';
import { toolList } from '../src/mcp/tools.mjs';
import { InputError, openStore } from '../src/store.mjs';
import { bearer, ledgerToken } from './ledger-auth.mjs';
import { startMcp } from './mcp-client.mjs';

// Card G11: what changed between two snapshots of one party's graph. Synthetic data only.
const say = text => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });

function setup() {
  const store = openStore(':memory:');
  const aliSession = store.importTranscript({ provider: 'codex', source: 'ali.jsonl', transcript: JSON.stringify({
    type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Ali: GPU time. Which port does the ledger use?' }] },
  }) });
  const ali = store.publishGraph({ version: 2, sessionId: aliSession.id, party: 'ali', edges: [], nodes: [
    { id: 'gpu-time', kind: 'offer', label: 'GPU time', evidenceLines: [1] },
    { id: 'which-port', kind: 'question', to: 'leo', status: 'open', label: 'Which port does the ledger use?', evidenceLines: [1] },
  ] });
  const session = store.importTranscript({ provider: 'claude', source: 'leo.jsonl', transcript: [
    say('First plan: port 4400. Record the demo. Who owns the GPU box?'),
    say('Change of plan: port 4317. The demo is recorded. Pair on the adapter.'),
  ].join('\n') });
  const v1 = store.publishGraph({ version: 2, sessionId: session.id, party: 'leo',
    nodes: [
      { id: 'old-port', kind: 'decision', label: 'Use port 4400', evidenceLines: [1] },
      { id: 'record', kind: 'action', status: 'pending', label: 'Record the demo', evidenceLines: [1] },
      { id: 'gpu-owner', kind: 'question', to: 'ali', status: 'open', label: 'Who owns the GPU box?', evidenceLines: [1] },
      { id: 'demo', kind: 'goal', label: 'Demo live', evidenceLines: [1] },
    ],
    edges: [{ from: 'record', to: 'demo', type: 'advances' }],
  });
  const v2 = store.publishGraph({ version: 2, sessionId: session.id, party: 'leo',
    nodes: [
      { id: 'old-port', kind: 'decision', label: 'Use port 4400', evidenceLines: [1] },
      { id: 'port', kind: 'decision', label: 'Use port 4317', evidenceLines: [2] },
      { id: 'record', kind: 'action', status: 'completed', label: 'Record the demo', evidenceLines: [1, 2] },
      { id: 'pairing', kind: 'offer', label: 'Pair on the adapter', evidenceLines: [2] },
      { id: 'demo', kind: 'goal', label: 'Demo live tonight', evidenceLines: [1] },
    ],
    edges: [{ from: 'port', to: 'old-port', type: 'supersedes' }, { from: 'record', to: 'demo', type: 'advances' }],
    links: [{ from: 'port', graph: ali.id, to: 'which-port', type: 'answers' }, { from: 'pairing', graph: ali.id, to: 'gpu-time', type: 'matches' }],
  });
  return { store, ali, v1, v2 };
}

const ids = list => list.map(entry => entry.id);

test('a diff lists each added, removed and changed node once, with old and new values', () => {
  const { store, ali, v1, v2 } = setup();
  const diff = store.diffGraphs(v2.id, v1.id);
  assert.equal(diff.fromGraphId, v1.id);
  assert.equal(diff.graphId, v2.id);
  assert.equal(diff.party, 'leo');
  assert.deepEqual(ids(diff.nodes.added), ['port', 'pairing'], 'canonical order: decisions before offers');
  assert.deepEqual(diff.nodes.removed, [{ id: 'gpu-owner', kind: 'question', label: 'Who owns the GPU box?' }]);
  assert.deepEqual(diff.nodes.changed, [
    { id: 'demo', kind: 'goal', label: 'Demo live tonight', changes: { label: { from: 'Demo live', to: 'Demo live tonight' } } },
    { id: 'record', kind: 'action', label: 'Record the demo', changes: {
      status: { from: 'pending', to: 'completed' }, evidenceLines: { from: [1], to: [1, 2] } } },
  ]);
  assert.ok(!ids(diff.nodes.changed).includes('old-port'), 'an unchanged node does not appear');
  assert.deepEqual(ids(diff.supersededDecisions), ['old-port']);
  assert.deepEqual(diff.answeredQuestions, [], 'gpu-owner was removed, not answered');
  assert.deepEqual(ids(diff.readyActionsLost), ['record']);
  assert.deepEqual(diff.edges.added, [{ from: 'port', to: 'old-port', type: 'supersedes' }]);
  assert.deepEqual(diff.edges.removed, []);
  assert.deepEqual(diff.links.added, [
    { from: 'port', graph: ali.id, to: 'which-port', type: 'answers' },
    { from: 'pairing', graph: ali.id, to: 'gpu-time', type: 'matches' },
  ]);
  assert.deepEqual(diff.links.removed, []);
  assert.deepEqual(diffCounts(diff), { added: 2, removed: 1, changed: 2, superseded: 1, answered: 0, opened: 0, edges: 1, links: 2, readyGained: 0, readyLost: 1, any: true });
  store.close();
});

test('swapping the graphs gives the mirror image, and a graph against itself gives nothing', () => {
  const { store, v1, v2 } = setup();
  const forward = store.diffGraphs(v2.id, v1.id);
  const back = store.diffGraphs(v1.id, v2.id);
  assert.deepEqual(ids(back.nodes.added), ids(forward.nodes.removed));
  assert.deepEqual(ids(back.nodes.removed), ids(forward.nodes.added));
  assert.deepEqual(back.nodes.changed.find(node => node.id === 'record').changes.status, { from: 'completed', to: 'pending' });
  assert.deepEqual(back.edges.removed, forward.edges.added);
  assert.deepEqual(back.links.removed, forward.links.added);
  assert.deepEqual(ids(back.readyActionsGained), ['record']);
  const same = store.diffGraphs(v2.id, v2.id);
  assert.equal(diffCounts(same).any, false);
  for (const path of diffSections) assert.deepEqual(path.reduce((node, key) => node[key], same), [], path.join('.'));
  store.close();
});

test('a question answered by a newer snapshot is listed as answered', () => {
  const store = openStore(':memory:');
  const session = store.importTranscript({ provider: 'claude', source: 'q.jsonl', transcript: say('Which port? Port 4317.') });
  const ask = { version: 2, sessionId: session.id, party: 'ali', edges: [], nodes: [
    { id: 'q', kind: 'question', to: 'leo', status: 'open', label: 'Which port?', evidenceLines: [1] }] };
  const asked = store.publishGraph(ask);
  const answered = store.publishGraph({ ...ask, nodes: [...ask.nodes, { id: 'a', kind: 'decision', label: 'Port 4317', evidenceLines: [1] }],
    edges: [{ from: 'a', to: 'q', type: 'answers' }] });
  assert.deepEqual(ids(store.diffGraphs(answered.id, asked.id).answeredQuestions), ['q']);
  assert.deepEqual(ids(store.diffGraphs(asked.id, answered.id).openedQuestions), ['q']);
  store.close();
});

test('review of G11: a reused node ID is a change of kind, not a supersession or an answer', () => {
  const graph = (id, nodes, edges = []) => ({ id, packet: { version: 2, party: 'leo', nodes, edges },
    currentDecisionIds: nodes.filter(node => node.kind === 'decision').map(node => node.id),
    openQuestionIds: nodes.filter(node => node.kind === 'question' && node.status === 'open').map(node => node.id),
    readyActionIds: nodes.filter(node => node.kind === 'action' && node.status === 'pending').map(node => node.id) });
  const older = graph('a', [
    { id: 'x', kind: 'decision', label: 'Use port 4400', evidenceLines: [1] },
    { id: 'q', kind: 'question', to: 'ali', status: 'open', label: 'Which box?', evidenceLines: [1] },
    { id: 'r', kind: 'action', status: 'pending', label: 'Record it', evidenceLines: [1] },
  ]);
  const newer = graph('b', [
    { id: 'x', kind: 'goal', label: 'Use port 4400', evidenceLines: [1] },
    { id: 'q', kind: 'question', to: 'bea', status: 'open', label: 'Which box?', evidenceLines: [1] },
  ]);
  const diff = diffGraphs(older, newer);
  assert.deepEqual(diff.supersededDecisions, []);
  assert.deepEqual(diff.answeredQuestions, []);
  assert.deepEqual(diff.nodes.changed, [
    { id: 'x', kind: 'goal', label: 'Use port 4400', changes: { kind: { from: 'decision', to: 'goal' } } },
    { id: 'q', kind: 'question', label: 'Which box?', changes: { to: { from: 'ali', to: 'bea' } } },
  ].sort((m, n) => (m.id === 'x' ? -1 : 1) - (n.id === 'x' ? -1 : 1)));
  assert.deepEqual(diff.readyActionsLost, [{ id: 'r', kind: 'action', label: 'Record it' }], 'a removed ready action is lost too');
});

test('other parties, version 1 graphs and unknown graphs are refused or not found', () => {
  const { store, ali, v1 } = setup();
  assert.throws(() => store.diffGraphs(v1.id, ali.id), error => error instanceof InputError
    && error.message === 'Both graphs must be version 2 or 3 graphs of the same party.');
  const session = store.importTranscript({ provider: 'claude', source: 'v1.jsonl', transcript: say('Ship it.') });
  const old = store.publishGraph({ version: 1, sessionId: session.id, nodes: [{ id: 'g', kind: 'goal', label: 'Ship it', evidenceLines: [1] }], edges: [] });
  assert.throws(() => store.diffGraphs(old.id, old.id), InputError);
  assert.equal(store.diffGraphs('e'.repeat(64), v1.id), undefined);
  assert.equal(store.diffGraphs(v1.id, 'e'.repeat(64)), undefined);
  store.close();
});

test('a room names the newer graph of a party that published again', () => {
  const { store, ali, v1, v2 } = setup();
  const room = store.openRoom({ graphIds: [v1.id, ali.id] });
  assert.deepEqual(room.newerGraphs, [{ party: 'leo', graphId: v2.id, fromGraphId: v1.id, sameSession: true, changed: true,
    counts: { added: 2, removed: 1, changed: 2, superseded: 1, answered: 0, opened: 0, edges: 1, links: 2, readyGained: 0, readyLost: 1 } }]);
  const current = store.openRoom({ graphIds: [v2.id, ali.id] });
  assert.deepEqual(current.newerGraphs, [], 'a room on the newest graphs names none');
  // Party names are self-asserted: another transcript under the name leo is marked as such.
  const other = store.importTranscript({ provider: 'claude', source: 'not-leo.jsonl', transcript: say('Someone else: port 9999.') });
  const impostor = store.publishGraph({ version: 2, sessionId: other.id, party: 'leo', edges: [],
    nodes: [{ id: 'port', kind: 'decision', label: 'Port 9999', evidenceLines: [1] }] });
  const marked = store.getRoom(current.id).newerGraphs;
  assert.deepEqual(marked.map(entry => [entry.graphId, entry.sameSession]), [[impostor.id, false]]);
  // Review round 2: on the older room, the other transcript does not hide leo's own newer graph.
  const both = store.getRoom(room.id).newerGraphs;
  assert.deepEqual(both.map(entry => [entry.graphId, entry.sameSession]), [[v2.id, true], [impostor.id, false]]);
  store.close();
});

async function fakeLedger(t, respond) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    const { status = 200, body } = respond(request.url);
    response.statusCode = status;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { port: server.address().port, requests };
}

test('graph_diff asks the ledger once, escapes labels and pages a long diff', async t => {
  const { store, v1, v2 } = setup();
  const diff = store.diffGraphs(v2.id, v1.id);
  store.close();
  const rlo = String.fromCodePoint(0x202e);
  diff.nodes.added[0].label = `Pair ${rlo}evil`;
  const long = structuredClone(diff);
  long.nodes.added = Array.from({ length: 400 }, (_, index) => ({ id: `n-${index}`, kind: 'goal', label: 'L'.repeat(200) }));
  const ledger = await fakeLedger(t, url => ({ body: { diff: url.includes('a'.repeat(64)) ? long : diff } }));
  const client = startMcp(ledger.port);
  t.after(() => client.close());

  const result = await client.call(1, 'graph_diff', { graphId: v2.id, fromGraphId: v1.id });
  assert.equal(result.isError, undefined);
  assert.equal(ledger.requests.at(-1), `/api/graphs/${v2.id}/diff?from=${v1.id}`);
  assert.ok(!result.content[0].text.includes(rlo), 'labels are escaped');
  assert.ok(result.content[0].text.includes('\\u202eevil'));

  const pages = [];
  for (let id = 2, fromItem = 1; ; id += 1) {
    const page = JSON.parse((await client.call(id, 'graph_diff', { graphId: 'a'.repeat(64), fromGraphId: v1.id, fromItem })).content[0].text);
    pages.push(page);
    if (!page.more) break;
    assert.match(page.more.note, /^Items \d+ to \d+ remain\. Call graph_diff again with the same graph IDs and fromItem \d+\.$/u);
    fromItem = page.more.fromItem;
    assert.ok(id < 20);
  }
  assert.ok(pages.length > 1);
  // In order, with nothing skipped or repeated.
  assert.deepEqual(pages.flatMap(page => page.diff.nodes?.added ?? []).map(node => node.id), long.nodes.added.map(node => node.id));

  const count = ledger.requests.length;
  for (const [args, message] of [
    [{ graphId: v2.id }, /fromGraphId must be a 64-character lowercase hex graph ID/u],
    [{ graphId: 'A'.repeat(64), fromGraphId: v1.id }, /graphId must be/u],
    [{ graphId: v2.id, fromGraphId: v1.id, extra: 1 }, /./u],
  ]) {
    const refused = await client.call(50, 'graph_diff', args);
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, message);
  }
  assert.equal(ledger.requests.length, count, 'refused calls reach no ledger');
});

test('graph_diff passes on the ledger\'s not-found and refusal answers, and its schema stays small', async t => {
  const missing = 'e'.repeat(64);
  const other = 'f'.repeat(64);
  const ledger = await fakeLedger(t, url => (url.includes(missing) ? { status: 404, body: { error: 'Not found.' } }
    : { status: 400, body: { error: 'Both graphs must be version 2 graphs of the same party.' } }));
  const client = startMcp(ledger.port);
  t.after(() => client.close());
  const notFound = await client.call(1, 'graph_diff', { graphId: missing, fromGraphId: other });
  assert.deepEqual([notFound.isError, notFound.content[0].text], [true, 'Graph not found.']);
  const refused = await client.call(2, 'graph_diff', { graphId: other, fromGraphId: other });
  assert.deepEqual([refused.isError, refused.content[0].text], [true, 'Both graphs must be version 2 graphs of the same party.']);
  // The cycle-10 tools/list budget counts only that cycle's tools; this one has its own.
  const tool = toolList.find(entry => entry.name === 'graph_diff');
  assert.ok(JSON.stringify(tool).length <= 900, `graph_diff is ${JSON.stringify(tool).length} characters`);
});

async function startServer(t) {
  const { spawn } = await import('node:child_process');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'ledger-g11-'));
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
      const auth = bearer(await ledgerToken(join(dir, 'ledger.sqlite'), Number(match[1])));
      return { origin: `http://127.0.0.1:${match[1]}`, auth };
    }
  }
  throw new Error('server did not start');
}

test('the diff route checks its parameters with fixed messages', async t => {
  const { origin, auth } = await startServer(t);
  const post = (path, body) => fetch(origin + path, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) })
    .then(response => response.json());
  const { session } = await post('/api/import', { provider: 'claude', source: 'o.jsonl', transcript: say('Port 4317. Port 4400.') });
  const packet = label => ({ version: 2, sessionId: session.id, party: 'leo', edges: [], nodes: [{ id: 'p', kind: 'decision', label, evidenceLines: [1] }] });
  const { graph: a } = await post('/api/graphs', packet('Port 4400'));
  const { graph: b } = await post('/api/graphs', packet('Port 4317'));
  const get = query => fetch(`${origin}/api/graphs/${b.id}/diff${query}`, { headers: auth }).then(async response => ({ status: response.status, body: await response.json() }));
  const ok = await get(`?from=${a.id}`);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.diff.nodes.changed[0].changes, { label: { from: 'Port 4400', to: 'Port 4317' } });
  for (const [query, status, body] of [
    ['', 400, { error: 'from must be a graph ID.' }],
    ['?from=xyz', 400, { error: 'from must be a graph ID.' }],
    [`?from=${a.id}&from=${a.id}`, 400, { error: 'The diff takes one from parameter and no other.' }],
    [`?from=${a.id}&extra=1`, 400, { error: 'The diff takes one from parameter and no other.' }],
    [`?from=${'e'.repeat(64)}`, 404, { error: 'Not found.' }],
  ]) assert.deepEqual(await get(query), { status, body }, query.slice(0, 40));
});

test('review round 2: a question that became an offer is not answered, and a lost action keeps its old name', () => {
  const graph = (id, nodes) => ({ id, packet: { version: 2, party: 'leo', nodes, edges: [] },
    currentDecisionIds: [], openQuestionIds: nodes.filter(node => node.kind === 'question').map(node => node.id),
    readyActionIds: nodes.filter(node => node.kind === 'action').map(node => node.id) });
  const diff = diffGraphs(
    graph('a', [{ id: 'q', kind: 'question', to: 'ali', status: 'open', label: 'Which box?', evidenceLines: [1] },
      { id: 'r', kind: 'action', status: 'pending', label: 'Record it', evidenceLines: [1] }]),
    graph('b', [{ id: 'q', kind: 'offer', label: 'Box offered', evidenceLines: [1] },
      { id: 'r', kind: 'goal', label: 'Recorded', evidenceLines: [1] }]),
  );
  assert.deepEqual(diff.answeredQuestions, []);
  assert.deepEqual(diff.readyActionsLost, [{ id: 'r', kind: 'action', label: 'Record it' }]);
});

test('review round 2: a long diff pages across section boundaries and merges back in order', async t => {
  const { store, v1, v2 } = setup();
  const diff = store.diffGraphs(v2.id, v1.id);
  store.close();
  const node = (prefix, index) => ({ id: `${prefix}-${index}`, kind: 'goal', label: `${prefix} ${'L'.repeat(180)}` });
  diff.nodes.added = Array.from({ length: 150 }, (_, index) => node('added', index));
  diff.nodes.changed = Array.from({ length: 150 }, (_, index) => ({ ...node('changed', index), changes: { label: { from: 'a', to: 'b' } } }));
  const ledger = await fakeLedger(t, () => ({ body: { diff } }));
  const client = startMcp(ledger.port);
  t.after(() => client.close());
  const sections = { added: [], changed: [], removed: [] };
  let crossed = false;
  for (let id = 1, fromItem = 1; ; id += 1) {
    const page = JSON.parse((await client.call(id, 'graph_diff', { graphId: v2.id, fromGraphId: v1.id, fromItem })).content[0].text);
    for (const key of Object.keys(sections)) sections[key].push(...(page.diff.nodes?.[key] ?? []));
    if (page.diff.nodes?.added?.length && page.diff.nodes?.changed?.length) crossed = true;
    if (!page.more) break;
    fromItem = page.more.fromItem;
    assert.ok(id < 30);
  }
  assert.ok(crossed, 'one page held the end of one section and the start of the next');
  assert.deepEqual(sections.added, diff.nodes.added);
  assert.deepEqual(sections.changed, diff.nodes.changed);
  assert.deepEqual(sections.removed, diff.nodes.removed);
});
