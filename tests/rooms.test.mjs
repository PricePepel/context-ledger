import assert from 'node:assert/strict';
import test from 'node:test';
import { InputError, openStore } from '../src/store.mjs';

const say = text => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });

function setup() {
  const store = openStore(':memory:');
  const leoSession = store.importTranscript({ provider: 'claude', source: 'leo.jsonl', transcript: say('Leo: synthetic Nova demo, pair on the adapter.') });
  const aliSession = store.importTranscript({ provider: 'claude', source: 'ali.jsonl', transcript: say('Ali: GPU time, no Sundays, which port?') });
  const ali = store.publishGraph({
    version: 2, sessionId: aliSession.id, party: 'ali',
    nodes: [
      { id: 'gpu-time', kind: 'offer', label: 'GPU time', evidenceLines: [1] },
      { id: 'no-sunday', kind: 'constraint', label: 'No Sundays', evidenceLines: [1] },
      { id: 'which-port', kind: 'question', to: 'leo', status: 'open', label: 'Which port?', evidenceLines: [1] },
    ],
    edges: [],
  });
  const leo = store.publishGraph({
    version: 2, sessionId: leoSession.id, party: 'leo',
    nodes: [
      { id: 'pairing', kind: 'offer', label: 'Pair on the adapter', evidenceLines: [1] },
      { id: 'record', kind: 'action', status: 'pending', label: 'Record on Sunday', evidenceLines: [1] },
      { id: 'port', kind: 'decision', label: 'Port 4317', evidenceLines: [1] },
    ],
    edges: [],
    links: [
      { from: 'pairing', graph: ali.id, to: 'gpu-time', type: 'matches' },
      { from: 'record', graph: ali.id, to: 'no-sunday', type: 'conflicts' },
      { from: 'port', graph: ali.id, to: 'which-port', type: 'answers' },
    ],
  });
  return { store, ali, leo, leoSession, aliSession };
}

test('a room merges two parties and lists each cross-graph link as a proposal', () => {
  const { store, ali, leo } = setup();
  const room = store.openRoom({ graphIds: [leo.id, ali.id] });
  assert.match(room.id, /^[a-f0-9]{64}$/u);
  assert.equal(store.openRoom({ graphIds: [ali.id, leo.id] }).id, room.id, 'order-independent');
  assert.deepEqual(room.parties.map(party => party.party), ['ali', 'leo']);
  assert.deepEqual(room.parties[0].openQuestionIds, ['which-port']);
  assert.deepEqual(room.proposals.map(p => [p.type, p.from.nodeId, p.to.nodeId, p.state]).sort(), [
    ['answers', 'port', 'which-port', 'proposed'],
    ['conflicts', 'record', 'no-sunday', 'proposed'],
    ['matches', 'pairing', 'gpu-time', 'proposed'],
  ]);
  const match = room.proposals.find(p => p.type === 'matches');
  assert.deepEqual(match.from, { party: 'leo', graphId: leo.id, nodeId: 'pairing', kind: 'offer', label: 'Pair on the adapter' });
  assert.deepEqual(match.choices, { ali: null, leo: null });
  assert.deepEqual(store.getRoom(room.id), room);
});

test('a proposal is agreed only when both parties confirm and rejected when either rejects', () => {
  const { store, ali, leo } = setup();
  const room = store.openRoom({ graphIds: [leo.id, ali.id] });
  const match = room.proposals.find(p => p.type === 'matches').id;
  const conflict = room.proposals.find(p => p.type === 'conflicts').id;

  let view = store.decide(room.id, { proposalId: match, party: 'leo', choice: 'confirm' });
  assert.equal(view.proposals.find(p => p.id === match).state, 'proposed');
  view = store.decide(room.id, { proposalId: match, party: 'ali', choice: 'confirm' });
  assert.equal(view.proposals.find(p => p.id === match).state, 'agreed');
  assert.deepEqual(view.agreedProposalIds, [match]);

  view = store.decide(room.id, { proposalId: conflict, party: 'leo', choice: 'confirm' });
  view = store.decide(room.id, { proposalId: conflict, party: 'ali', choice: 'reject' });
  assert.equal(view.proposals.find(p => p.id === conflict).state, 'rejected');

  // A person can change their mind; the latest choice wins.
  view = store.decide(room.id, { proposalId: match, party: 'ali', choice: 'reject' });
  assert.equal(view.proposals.find(p => p.id === match).state, 'rejected');
  assert.deepEqual(view.agreedProposalIds, []);
});

test('rooms reject bad graph sets and decisions reject unknown proposals, parties and choices', () => {
  const { store, ali, leo, aliSession } = setup();
  const sameParty = store.publishGraph({
    version: 2, sessionId: aliSession.id, party: 'ali',
    nodes: [{ id: 'other', kind: 'goal', label: 'Other', evidenceLines: [1] }], edges: [],
  });
  const v1 = store.publishGraph({ version: 1, sessionId: aliSession.id, nodes: [{ id: 'g', kind: 'goal', label: 'G', evidenceLines: [1] }], edges: [] });
  const sameSession = store.publishGraph({
    version: 2, sessionId: aliSession.id, party: 'sam',
    nodes: [{ id: 'g', kind: 'goal', label: 'G', evidenceLines: [1] }], edges: [],
  });
  for (const graphIds of [undefined, [], [ali.id], [ali.id, ali.id], [ali.id, '0'.repeat(64)], [ali.id, sameParty.id], [leo.id, v1.id], [ali.id, sameSession.id], [ali.id, 'ABC'], [ali.id, leo.id, leo.id]]) {
    assert.throws(() => store.openRoom({ graphIds }), InputError, JSON.stringify(graphIds));
  }
  assert.throws(() => store.openRoom(null), InputError);

  const room = store.openRoom({ graphIds: [leo.id, ali.id] });
  const proposalId = room.proposals[0].id;
  for (const input of [
    { proposalId: '0'.repeat(64), party: 'leo', choice: 'confirm' },
    { proposalId, party: 'sam', choice: 'confirm' },
    { proposalId, party: 'leo', choice: 'approve' },
    { proposalId, party: '__proto__', choice: 'confirm' },
    null,
  ]) {
    assert.throws(() => store.decide(room.id, input), InputError, JSON.stringify(input));
  }
  assert.equal(store.decide('0'.repeat(64), { proposalId, party: 'leo', choice: 'confirm' }), undefined);
  assert.equal(store.getRoom('0'.repeat(64)), undefined);
});

test('a room with no links between its graphs has no proposals', () => {
  const { store, ali, aliSession, leoSession } = setup();
  void aliSession;
  const plain = store.publishGraph({
    version: 2, sessionId: leoSession.id, party: 'leo',
    nodes: [{ id: 'g', kind: 'goal', label: 'G', evidenceLines: [1] }], edges: [],
  });
  const room = store.openRoom({ graphIds: [plain.id, ali.id] });
  assert.deepEqual(room.proposals, []);
});
