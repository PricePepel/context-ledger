import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createModel } from '../public/console/model.mjs';
import { liveSource } from '../public/console/source.mjs';

// Card U1 review fixes (Codex, 2026-11-17): the console's model rules and its live
// polling against a fake ledger. Synthetic graphs only.
const hex = n => n.toString(16).padStart(64, '0');
function graphOf(id, party, nodes, extra = {}) {
  return {
    id,
    packet: { version: 2, sessionId: hex(9000 + party.length), party, nodes, edges: [], ...extra.packet },
    readyActionIds: [],
    currentDecisionIds: nodes.filter(node => node.kind === 'decision').map(node => node.id),
    openQuestionIds: nodes.filter(node => node.kind === 'question' && node.status === 'open').map(node => node.id),
    ...extra.derived,
  };
}
const goal = (id, label, evidenceLines = [1]) => ({ id, kind: 'goal', label, evidenceLines });
const startOfToday = () => {
  const day = new Date();
  day.setHours(0, 0, 0, 0);
  return day.getTime();
};

test('a node whose recipient or cited lines change counts as changed', () => {
  const model = createModel();
  const ask = to => ({ id: 'q', kind: 'question', status: 'open', to, label: 'Who?', evidenceLines: [1] });
  model.apply({ graph: graphOf(hex(1), 'leo', [goal('g', 'Ship', [1]), ask('ali')]), provider: 'claude', at: 1 });
  const moved = model.apply({ graph: graphOf(hex(2), 'leo', [goal('g', 'Ship', [3]), ask('mia')]), provider: 'claude', at: 2 });
  assert.deepEqual(moved.changed.sort(), ['party:leo/g', 'party:leo/q']);
});

test('an answer link closes only the same question, not a reused ID', () => {
  const model = createModel({ workingMs: 0 });
  const ask = label => ({ id: 'q', kind: 'question', status: 'open', to: 'leo', label, evidenceLines: [1] });
  model.apply({ graph: graphOf(hex(11), 'ali', [ask('Which port?')]), provider: 'codex', at: 1 });
  const answer = { id: 'port', kind: 'decision', label: 'Port 4317', evidenceLines: [1] };
  const links = [{ from: 'port', graph: hex(11), to: 'q', type: 'answers' }];
  model.apply({ graph: graphOf(hex(12), 'leo', [answer], { packet: { links } }), provider: 'claude', at: 2 });
  assert.equal(model.agents(10).find(agent => agent.label === 'ali').state, 'idle');
  // Ali reuses the ID for a new question: the old answer does not close it.
  model.apply({ graph: graphOf(hex(13), 'ali', [ask('Which GPU?')]), provider: 'codex', at: 3 });
  assert.equal(model.agents(10).find(agent => agent.label === 'ali').state, 'waiting');
  assert.equal(model.graph().columns[0].nodes[0].answered, false);
});

test('a question answered inside its own graph shows as answered and does not wait', () => {
  const model = createModel({ workingMs: 0 });
  const nodes = [{ id: 'q', kind: 'question', status: 'open', to: 'ali', label: 'Who?', evidenceLines: [1] }];
  model.apply({ graph: graphOf(hex(21), 'leo', nodes, { derived: { openQuestionIds: [] } }), provider: 'claude', at: 1 });
  assert.equal(model.graph().columns[0].nodes[0].answered, true);
  assert.equal(model.agents(10)[0].state, 'idle');
});

test('version 1 graphs stand for their session, and the live office keeps only today', () => {
  const model = createModel({ workingMs: 0 });
  const v1 = { id: hex(31), packet: { version: 1, sessionId: hex(77), nodes: [goal('g', 'Old plan')], edges: [] }, readyActionIds: [], currentDecisionIds: [] };
  model.apply({ summary: { sessionTitle: 'A v1 session' }, graph: v1, provider: 'claude', at: Date.now() - 2 * 86_400_000 });
  assert.equal(model.graph().columns[0].key, `session:${hex(77)}`);
  assert.equal(model.graph().columns[0].label, 'A v1 session');
  assert.equal(model.agents(Date.now()).length, 1);
  assert.equal(model.agents(Date.now(), { todayOnly: true }).length, 0);
});

/** A fake ledger behind fetchJson, graphs newest first, with optional failures. */
function fakeLedger(rows, { failOnce = new Set(), failContext = new Set() } = {}) {
  const calls = [];
  const fetchJson = async path => {
    calls.push(path);
    const url = new URL(path, 'http://ledger');
    if (url.pathname === '/api/sessions') {
      return { sessions: [...new Set(rows.map(row => row.sessionId))].map(id => ({ id, provider: 'codex' })) };
    }
    if (url.pathname === '/api/graphs') {
      const after = url.searchParams.get('after');
      const start = after ? rows.findIndex(row => row.id === after) + 1 : 0;
      const page = rows.slice(start, start + 100);
      return { graphs: page, next: start + 100 < rows.length ? page.at(-1).id : null };
    }
    if (failOnce.has(path)) {
      failOnce.delete(path);
      throw new Error('Synthetic failure.');
    }
    const [, id, context] = url.pathname.match(/^\/api\/graphs\/([a-f0-9]{64})(\/context)?$/u);
    if (context) {
      if (failContext.has(id)) throw new Error('Synthetic failure.');
      return { context: { meter: { savedTokens: 10 } } };
    }
    const row = rows.find(candidate => candidate.id === id);
    const graph = graphOf(row.id, row.party, [goal(`n${parseInt(row.id, 16)}`, row.id)]);
    graph.packet.sessionId = row.sessionId;
    return { graph };
  };
  return { fetchJson, calls };
}

/** `count` rows, newest first; n counts up from the oldest (1). */
function rowsFor(count, { base = 1000, party = n => `p${n % 3}`, at = n => startOfToday() + 60_000 + n * 1000 } = {}) {
  return Array.from({ length: count }, (_, index) => {
    const n = count - index;
    return { id: hex(base + n), sessionId: hex(5000 + (n % 3)), party: party(n), createdAt: new Date(at(n)).toISOString() };
  });
}

function sourceOver(ledger, model = createModel()) {
  const events = [];
  const statuses = [];
  const source = liveSource({
    model,
    fetchJson: ledger.fetchJson,
    pollMs: 0,
    onGraph: (event, options) => { model.apply(event); events.push({ id: event.graph.id, ...options }); },
    onNote: (row, at) => model.noteSummary(row, at),
    onMeter() {},
    onStatus: status => statuses.push(status),
  });
  return { source, events, statuses, model };
}

const graphReads = calls => calls.filter(path => /^\/api\/graphs\/[a-f0-9]{64}$/u.test(path)).length;

test('the first live read pages back to the start of today and reads one graph per party', async () => {
  // 250 graphs today; party "late" published once, on page 3; then 40 from yesterday.
  const today = rowsFor(250, { party: n => (n === 5 ? 'late' : `p${n % 3}`) });
  const older = rowsFor(40, { base: 900_000, party: () => 'old', at: () => startOfToday() - 3_600_000 });
  const ledger = fakeLedger([...today, ...older]);
  const { source, events, model } = sourceOver(ledger);
  await source.tick();
  assert.deepEqual(events.map(event => event.initial), [true, true, true, true]);
  assert.ok(events.some(event => event.id === hex(1005)), 'the party on page 3 is read');
  assert.equal(model.numbers(Date.now()).handoffs, 250);
  assert.equal(ledger.calls.filter(path => path.startsWith('/api/graphs?')).length, 3);
  assert.equal(graphReads(ledger.calls), 4);
  assert.ok(!model.graph().columns.some(column => column.label === 'old'));

  // A later poll with nothing new reads one list page and nothing else.
  ledger.calls.length = 0;
  await source.tick();
  assert.deepEqual(ledger.calls, ['/api/graphs?limit=100']);
});

test('a failed read on the first load is retried as a first load, not turned into live events', async () => {
  const rows = rowsFor(6);
  const ledger = fakeLedger(rows, { failOnce: new Set([`/api/graphs/${rows[1].id}`]) });
  const { source, events, statuses } = sourceOver(ledger);
  await source.tick();
  assert.equal(statuses.at(-1).ok, false);
  await source.tick();
  assert.equal(statuses.at(-1).ok, true);
  // Each party's newest graph, all as a first load; no older snapshot replayed.
  assert.deepEqual(events.map(event => [event.id, event.initial]).sort(), rows.slice(0, 3).map(row => [row.id, true]).sort());
});

test('a later read that fails is retried after newer graphs, and a failed meter does not hold a graph back', async () => {
  const rows = rowsFor(3);
  const failOnce = new Set();
  const failContext = new Set();
  const ledger = fakeLedger(rows, { failOnce, failContext });
  const { source, events, model } = sourceOver(ledger);
  await source.tick();
  const newer = rowsFor(6).slice(0, 3);
  rows.unshift(...newer);
  failOnce.add(`/api/graphs/${newer[2].id}`); // the oldest of the three new graphs
  failContext.add(newer[0].id);
  await source.tick();
  const live = () => events.filter(event => !event.initial).map(event => event.id).sort();
  assert.deepEqual(live(), [newer[0].id, newer[1].id].sort());
  await source.tick();
  assert.deepEqual(live(), newer.map(row => row.id).sort());
  const key = `party:${newer[0].party}/n${parseInt(newer[0].id, 16)}`;
  assert.equal(model.node(key).entry.meter, null, 'the graph is shown before its meter');
  failContext.clear();
  await source.tick();
  assert.deepEqual(model.node(key).entry.meter, { savedTokens: 10 });
});

test('a graph that a current graph links to is read once, so its answers resolve', async () => {
  const model = createModel({ workingMs: 0 });
  const asked = graphOf(hex(41), 'ali', [{ id: 'q', kind: 'question', status: 'open', to: 'leo', label: 'Which port?', evidenceLines: [1] }]);
  const answer = graphOf(hex(42), 'leo', [{ id: 'port', kind: 'decision', label: 'Port', evidenceLines: [1] }],
    { packet: { links: [{ from: 'port', graph: hex(40), to: 'q', type: 'answers' }] } });
  // Ali's current graph is hex(41); Leo answered an older snapshot hex(40) of the same question.
  model.apply({ graph: asked, provider: 'codex', at: 1 });
  model.apply({ graph: answer, provider: 'claude', at: 2 });
  assert.equal(model.agents(10).find(agent => agent.label === 'ali').state, 'waiting');
  const calls = [];
  const source = liveSource({
    model, pollMs: 0, onGraph() {}, onNote() {}, onMeter() {}, onStatus() {},
    fetchJson: async path => {
      calls.push(path);
      if (path.startsWith('/api/graphs?')) return { graphs: [], next: null };
      return { graph: { ...asked, id: hex(40) } };
    },
  });
  await source.tick();
  await source.tick();
  assert.equal(calls.filter(path => path === `/api/graphs/${hex(40)}`).length, 1);
  assert.equal(model.agents(10).find(agent => agent.label === 'ali').state, 'idle');
});

test('a failed transcript read is not cached', async () => {
  let fail = true;
  const source = liveSource({
    model: createModel(), pollMs: 0, onGraph() {}, onNote() {}, onStatus() {},
    fetchJson: async () => {
      if (fail) {
        fail = false;
        throw new Error('Synthetic failure.');
      }
      return { session: { id: 'x', messages: [] } };
    },
  });
  await assert.rejects(source.session(hex(1)));
  assert.equal((await source.session(hex(1))).id, 'x');
});

// Second Codex round (verification of 418feb4).

test('a morning with no publish yet does not replay yesterday as live', async () => {
  const yesterday = rowsFor(5, { at: n => startOfToday() - 7_200_000 + n * 1000 });
  const ledger = fakeLedger(yesterday);
  const { source, events } = sourceOver(ledger);
  await source.tick();
  ledger.calls.length = 0;
  await source.tick();
  await source.tick();
  assert.deepEqual(events, []);
  assert.equal(graphReads(ledger.calls), 0);
  assert.deepEqual(ledger.calls, ['/api/graphs?limit=100', '/api/graphs?limit=100']);
});

test('an older snapshot read after a retry never replaces a newer one with the same time', async () => {
  const rows = rowsFor(1, { base: 2000, party: () => 'leo' });
  const failOnce = new Set();
  const ledger = fakeLedger(rows, { failOnce });
  const { source, model } = sourceOver(ledger);
  await source.tick();
  // Two more leo snapshots in the same millisecond; the older one fails once.
  const sameTime = new Date(startOfToday() + 99_000).toISOString();
  const older = { id: hex(2101), sessionId: rows[0].sessionId, party: 'leo', createdAt: sameTime };
  const newer = { id: hex(2102), sessionId: rows[0].sessionId, party: 'leo', createdAt: sameTime };
  rows.unshift(newer, older);
  failOnce.add(`/api/graphs/${older.id}`);
  await source.tick();
  assert.equal(model.currentGraphIds()[0], newer.id);
  await source.tick();
  assert.equal(model.currentGraphIds()[0], newer.id, 'the late older snapshot is only counted');
  assert.equal(model.numbers(Date.now()).handoffs, 3);
});

test('publish order, not the clock, decides which snapshot is current', async () => {
  // A is current; B's first read fails; C is published after the clock moved back.
  const rows = rowsFor(1, { base: 3000, party: () => 'leo', at: () => startOfToday() + 500_000 });
  const failOnce = new Set();
  const { source, model } = sourceOver(fakeLedger(rows, { failOnce }));
  await source.tick();
  const make = (n, at) => ({ id: hex(3000 + n), sessionId: rows[0].sessionId, party: 'leo', createdAt: new Date(startOfToday() + at).toISOString() });
  const b = make(2, 600_000);
  rows.unshift(b);
  failOnce.add(`/api/graphs/${b.id}`);
  await source.tick();
  const c = make(3, 400_000);
  rows.unshift(c);
  await source.tick();
  await source.tick();
  assert.equal(model.currentGraphIds()[0], c.id);
  assert.equal(model.numbers(Date.now()).handoffs, 3);
});

test('a linked graph that failed to read is tried again later and then resolves', async () => {
  const model = createModel({ workingMs: 0 });
  const ask = { id: 'q', kind: 'question', status: 'open', to: 'leo', label: 'Which port?', evidenceLines: [1] };
  model.apply({ graph: graphOf(hex(51), 'ali', [ask]), provider: 'codex', at: 1 });
  const links = [{ from: 'port', graph: hex(50), to: 'q', type: 'answers' }];
  model.apply({ graph: graphOf(hex(52), 'leo', [{ id: 'port', kind: 'decision', label: 'Port', evidenceLines: [1] }], { packet: { links } }), provider: 'claude', at: 2 });
  let failures = 4;
  let linked = 0;
  const source = liveSource({
    model, pollMs: 0, onGraph() {}, onNote() {}, onStatus() {}, onLinked: () => { linked += 1; },
    fetchJson: async path => {
      if (path.startsWith('/api/graphs?')) return { graphs: [], next: null };
      if (failures > 0) {
        failures -= 1;
        throw new Error('Synthetic failure.');
      }
      return { graph: graphOf(hex(50), 'ali', [ask]) };
    },
  });
  for (let tick = 0; tick < 40 && linked === 0; tick += 1) await source.tick();
  assert.equal(linked, 1);
  assert.equal(model.agents(10).find(agent => agent.label === 'ali').state, 'idle');
});

test('a reused question ID with the same words but other cited lines is not closed by the old answer', () => {
  const model = createModel({ workingMs: 0 });
  const ask = lines => ({ id: 'q', kind: 'question', status: 'open', to: 'leo', label: 'Which port?', evidenceLines: lines });
  model.apply({ graph: graphOf(hex(61), 'ali', [ask([1])]), provider: 'codex', at: 1 });
  const links = [{ from: 'port', graph: hex(61), to: 'q', type: 'answers' }];
  model.apply({ graph: graphOf(hex(62), 'leo', [{ id: 'port', kind: 'decision', label: 'Port', evidenceLines: [1] }], { packet: { links } }), provider: 'claude', at: 2 });
  model.apply({ graph: graphOf(hex(63), 'ali', [ask([9])]), provider: 'codex', at: 3 });
  assert.equal(model.agents(10).find(agent => agent.label === 'ali').state, 'waiting');
});
