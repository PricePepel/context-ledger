import assert from 'node:assert/strict';
import test from 'node:test';
import { GraphInputError, validateGraph } from '../src/graph.mjs';

function packet() {
  return {
    version: 1,
    sessionId: 'a'.repeat(64),
    nodes: [
      { id: 'rollout', kind: 'goal', label: 'Finish rollout', evidenceLines: [1] },
      { id: 'old-plan', kind: 'decision', label: 'Run a full rollout', evidenceLines: [1] },
      { id: 'new-plan', kind: 'decision', label: 'Start with a canary', evidenceLines: [2] },
      { id: 'budget', kind: 'constraint', label: 'Use staging', evidenceLines: [1] },
      { id: 'prep', kind: 'action', status: 'completed', label: 'Prepare staging', evidenceLines: [2] },
      { id: 'smoke', kind: 'action', status: 'pending', label: 'Run smoke test', evidenceLines: [2] },
      { id: 'deploy', kind: 'action', status: 'pending', label: 'Deploy to canary', evidenceLines: [2] },
      { id: 'verify', kind: 'action', status: 'pending', label: 'Verify deployment', evidenceLines: [2] },
      { id: 'approval', kind: 'blocker', status: 'open', label: 'Await approval', evidenceLines: [2] },
      { id: 'staging', kind: 'blocker', status: 'resolved', label: 'Staging is available', evidenceLines: [2] },
      { id: 'announce', kind: 'action', status: 'pending', label: 'Draft an announcement', evidenceLines: [2] },
    ],
    edges: [
      { from: 'smoke', to: 'rollout', type: 'advances' },
      { from: 'new-plan', to: 'old-plan', type: 'supersedes' },
      { from: 'budget', to: 'smoke', type: 'constrains' },
      { from: 'smoke', to: 'prep', type: 'depends_on' },
      { from: 'verify', to: 'deploy', type: 'depends_on' },
      { from: 'approval', to: 'deploy', type: 'blocks' },
      { from: 'staging', to: 'smoke', type: 'blocks' },
    ],
  };
}

function rejects(change) {
  const graph = packet();
  change(graph);
  assert.throws(() => validateGraph(graph, [1, 2]), GraphInputError);
}

test('reports pending unblocked actions and current decisions in packet order', () => {
  assert.deepEqual(validateGraph(packet(), new Set([1, 2])), {
    readyActionIds: ['smoke', 'announce'],
    currentDecisionIds: ['new-plan'],
  });
});

test('accepts a minimal packet without edges and rejects ungrounded evidence', () => {
  const graph = packet();
  graph.nodes = graph.nodes.slice(0, 1);
  graph.edges = [];
  assert.deepEqual(validateGraph(graph, [1]), { readyActionIds: [], currentDecisionIds: [] });
  rejects(value => { value.nodes[0].evidenceLines = [3]; });
  rejects(value => { value.nodes[0].evidenceLines = []; });
  rejects(value => { value.nodes[0].evidenceLines = [1, 1]; });
});

test('enforces version, identifier, bounded fields, and kind-specific statuses', () => {
  rejects(graph => { graph.version = 2; });
  rejects(graph => { graph.sessionId = 'A'.repeat(64); });
  rejects(graph => { graph.nodes[0].id = 'bad--id'; });
  rejects(graph => { graph.nodes[0].label = '   '; });
  rejects(graph => { graph.nodes[0].label = 'x'.repeat(501); });
  rejects(graph => { graph.nodes[0].evidenceLines = [0]; });
  rejects(graph => { graph.nodes[0].evidenceLines = [1.5]; });
  rejects(graph => { graph.nodes[0].status = 'pending'; });
  rejects(graph => { delete graph.nodes[4].status; });
  rejects(graph => { graph.nodes[8].status = 'pending'; });
  rejects(graph => { graph.nodes = []; });
  rejects(graph => { graph.nodes = Array(101).fill(graph.nodes[0]); });
  rejects(graph => { graph.edges = Array(301).fill(graph.edges[0]); });
});

test('rejects duplicate identifiers, duplicate relationships, and invalid endpoints', () => {
  rejects(graph => { graph.nodes.push(graph.nodes[0]); });
  rejects(graph => { graph.edges.push(graph.edges[0]); });
  rejects(graph => { graph.edges[0].to = 'missing'; });
  rejects(graph => { graph.edges[0].to = 'old-plan'; });
  rejects(graph => { graph.edges[0].type = 'unrecognized'; });
  rejects(graph => { graph.edges.push({ from: 'prep', to: 'prep', type: 'depends_on' }); });
});

test('rejects dependency and supersession cycles', () => {
  rejects(graph => { graph.edges.push({ from: 'prep', to: 'smoke', type: 'depends_on' }); });
  rejects(graph => { graph.edges.push({ from: 'old-plan', to: 'new-plan', type: 'supersedes' }); });
});

test('does not echo invalid packet content in the error', () => {
  const graph = packet();
  graph.edges[0].to = 'private-content';
  assert.throws(() => validateGraph(graph, [1, 2]), error => (
    error instanceof GraphInputError && !error.message.includes('private-content')
  ));
});
