import assert from 'node:assert/strict';
import test from 'node:test';
import { GraphInputError, validateGraph } from '../src/graph.mjs';
import { InputError, openStore } from '../src/store.mjs';

const remoteId = 'c'.repeat(64);
const remote = {
  id: remoteId,
  packet: {
    version: 2,
    sessionId: 'b'.repeat(64),
    party: 'ali',
    nodes: [
      { id: 'gpu-time', kind: 'offer', label: 'Two evenings of GPU time', evidenceLines: [1] },
      { id: 'demo-slot', kind: 'goal', label: 'Demo at 19:00', evidenceLines: [1] },
      { id: 'which-port', kind: 'question', to: 'leo', status: 'open', label: 'Which port does the ledger use?', evidenceLines: [1] },
      { id: 'no-weekend', kind: 'constraint', label: 'No work on Sunday', evidenceLines: [1] },
    ],
    edges: [],
  },
};
const lookupGraph = id => (id === remoteId ? remote : undefined);

function packet() {
  return {
    version: 2,
    sessionId: 'a'.repeat(64),
    party: 'leo',
    nodes: [
      { id: 'ship-demo', kind: 'goal', label: 'Ship the two-person demo', evidenceLines: [1] },
      { id: 'mcp-help', kind: 'offer', label: 'Pair on the MCP adapter', evidenceLines: [2] },
      { id: 'port-4317', kind: 'decision', label: 'The ledger listens on 4317', evidenceLines: [2] },
      { id: 'gpu-owner', kind: 'question', to: 'ali', status: 'open', label: 'Who owns the GPU box?', evidenceLines: [1] },
      { id: 'lunch', kind: 'question', to: 'ali', status: 'open', label: 'Lunch at noon?', evidenceLines: [2] },
      { id: 'lunch-yes', kind: 'decision', label: 'Lunch at noon', evidenceLines: [2] },
      { id: 'record', kind: 'action', status: 'pending', label: 'Record the demo', evidenceLines: [2] },
    ],
    edges: [
      { from: 'record', to: 'ship-demo', type: 'advances' },
      { from: 'lunch-yes', to: 'lunch', type: 'answers' },
    ],
    links: [
      { from: 'mcp-help', graph: remoteId, to: 'gpu-time', type: 'matches' },
      { from: 'record', graph: remoteId, to: 'no-weekend', type: 'conflicts' },
      { from: 'port-4317', graph: remoteId, to: 'which-port', type: 'answers' },
    ],
  };
}

function rejects(change, message) {
  const graph = packet();
  change(graph);
  assert.throws(() => validateGraph(graph, [1, 2], { lookupGraph }), error => {
    assert.ok(error instanceof GraphInputError);
    if (message) assert.match(error.message, message);
    return true;
  });
}

test('v2 accepts party, offers, questions, answers and cross-graph links', () => {
  assert.deepEqual(validateGraph(packet(), [1, 2], { lookupGraph }), {
    readyActionIds: ['record'],
    currentDecisionIds: ['port-4317', 'lunch-yes'],
    openQuestionIds: ['gpu-owner'],
  });
});

test('a superseded answer no longer closes its question', () => {
  const graph = packet();
  graph.nodes.push({ id: 'lunch-later', kind: 'decision', label: 'Lunch at one', evidenceLines: [2] });
  graph.edges.push({ from: 'lunch-later', to: 'lunch-yes', type: 'supersedes' });
  assert.deepEqual(validateGraph(graph, [1, 2], { lookupGraph }).openQuestionIds, ['gpu-owner', 'lunch']);
});

test('v2 links are optional', () => {
  const graph = packet();
  delete graph.links;
  assert.equal(validateGraph(graph, [1, 2]).readyActionIds.length, 1);
});

test('v2 rejects malformed question, offer and party fields', () => {
  rejects(graph => { delete graph.party; }, /version 2/);
  rejects(graph => { graph.party = 'Leo'; });
  rejects(graph => { delete graph.nodes[3].to; });
  rejects(graph => { graph.nodes[3].status = 'pending'; });
  rejects(graph => { graph.nodes[3].to = 'leo'; }, /another party/);
  rejects(graph => { graph.nodes[1].status = 'open'; });
  rejects(graph => { graph.nodes[1].to = 'ali'; });
  rejects(graph => { graph.nodes[6].to = 'ali'; });
  rejects(graph => { graph.edges.push({ from: 'mcp-help', to: 'lunch', type: 'answers' }); }, /expected kinds/);
  rejects(graph => { graph.version = 3; }, /Unsupported/);
  // Inherited object keys must not resolve to a validator.
  for (const version of ['constructor', 'toString', '__proto__', 'hasOwnProperty', '2']) {
    rejects(graph => { graph.version = version; graph.nodes = [{ id: 'x', kind: 'evil', evidenceLines: [1] }]; }, /Unsupported/);
  }
});

test('v2 rejects links to unknown graphs, unknown nodes, wrong kinds, own party and duplicates', () => {
  rejects(graph => { graph.links[0].graph = 'd'.repeat(64); }, /stored version 2 graph/);
  rejects(graph => { graph.links[0].to = 'missing'; }, /remote node/);
  rejects(graph => { graph.links[0].from = 'missing'; }, /local node/);
  rejects(graph => { graph.links[0].to = 'which-port'; }, /remote node/);
  rejects(graph => { graph.links[2].from = 'ship-demo'; }, /local node/);
  rejects(graph => { graph.links.push({ ...graph.links[0] }); }, /unique/);
  rejects(graph => { graph.party = 'ali'; graph.nodes[3].to = 'leo'; graph.nodes[4].to = 'leo'; }, /another party/);
  rejects(graph => { graph.links[0].type = 'blocks'; });
});

test('an answers link must target a question addressed to this party', () => {
  const addressedElsewhere = structuredClone(remote);
  addressedElsewhere.packet.nodes[2].to = 'sam';
  const graph = packet();
  assert.throws(
    () => validateGraph(graph, [1, 2], { lookupGraph: id => (id === remoteId ? addressedElsewhere : undefined) }),
    /addressed to this party/,
  );
});

test('v1 output is unchanged and v1 still rejects v2-only fields', () => {
  const v1 = {
    version: 1,
    sessionId: 'a'.repeat(64),
    nodes: [{ id: 'smoke', kind: 'action', status: 'pending', label: 'Run smoke', evidenceLines: [1] }],
    edges: [],
  };
  assert.deepEqual(validateGraph(v1, [1]), { readyActionIds: ['smoke'], currentDecisionIds: [] });
  assert.throws(() => validateGraph({ ...v1, party: 'leo' }, [1]), GraphInputError);
  assert.throws(() => validateGraph({ ...v1, nodes: [{ ...v1.nodes[0], kind: 'offer' }] }, [1]), GraphInputError);
});

test('the store links a stored graph from another party and refuses a dangling link before writing', () => {
  const store = openStore(':memory:');
  const transcript = speaker => JSON.stringify({ type: 'user', message: { role: 'user', content: `${speaker} wants a synthetic demo.` } });
  const leoSession = store.importTranscript({ provider: 'claude', source: 'leo.jsonl', transcript: transcript('Leo') });
  const aliSession = store.importTranscript({ provider: 'codex', source: 'ali.jsonl', transcript: JSON.stringify({
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Ali offers GPU time.' }] },
  }) });

  const ali = store.publishGraph({
    version: 2, sessionId: aliSession.id, party: 'ali',
    nodes: [{ id: 'gpu-time', kind: 'offer', label: 'GPU time', evidenceLines: [1] }],
    edges: [],
  });
  assert.deepEqual(ali.openQuestionIds, []);

  const leoPacket = {
    version: 2, sessionId: leoSession.id, party: 'leo',
    nodes: [{ id: 'demo', kind: 'goal', label: 'Demo', evidenceLines: [1] }],
    edges: [],
    links: [{ from: 'demo', graph: ali.id, to: 'gpu-time', type: 'matches' }],
  };
  const leo = store.publishGraph(leoPacket);
  assert.equal(store.getGraph(leo.id).packet.links[0].graph, ali.id);

  const dangling = structuredClone(leoPacket);
  dangling.links[0].graph = '0'.repeat(64);
  assert.throws(() => store.publishGraph(dangling), GraphInputError);

  const sameParty = structuredClone(leoPacket);
  sameParty.links[0].graph = leo.id;
  sameParty.links[0].to = 'demo';
  assert.throws(() => store.publishGraph(sameParty), /another party/);
  assert.throws(() => store.publishGraph({ ...leoPacket, sessionId: '0'.repeat(64) }), InputError);
});
