import Ajv2020 from 'ajv/dist/2020.js';
import graphSchema from '../schemas/semantic-graph.schema.json' with { type: 'json' };

const validateShape = new Ajv2020({ strict: true, ownProperties: true }).compile(graphSchema);

const edgeKinds = {
  advances: ['action', 'goal'],
  blocks: ['blocker', 'action'],
  depends_on: ['action', 'action'],
  supersedes: ['decision', 'decision'],
  constrains: ['constraint', 'action'],
};

export class GraphInputError extends Error {}

function indexNodes(nodes, sourceLines) {
  const evidence = new Set(sourceLines);
  const byId = new Map();
  for (const node of nodes) {
    if (byId.has(node.id)) throw new GraphInputError('Node IDs must be unique.');
    if (!node.evidenceLines.every(line => evidence.has(line))) {
      throw new GraphInputError('Evidence must refer to stored lines in the source session.');
    }
    byId.set(node.id, node);
  }
  return byId;
}

function indexEdges(edges, nodes) {
  const seen = new Set();
  const byType = new Map(Object.keys(edgeKinds).map(type => [type, []]));
  for (const edge of edges) {
    const { from, to, type } = edge;
    const [fromKind, toKind] = edgeKinds[type];
    if (from === to || nodes.get(from)?.kind !== fromKind || nodes.get(to)?.kind !== toKind) {
      throw new GraphInputError('An edge must connect distinct nodes of the expected kinds.');
    }
    const key = `${type}|${from}|${to}`;
    if (seen.has(key)) throw new GraphInputError('Edges must be unique.');
    seen.add(key);
    byType.get(type).push(edge);
  }
  return byType;
}

function assertAcyclic(edges, relationship) {
  const targets = new Map();
  for (const { from, to } of edges) {
    if (!targets.has(from)) targets.set(from, []);
    targets.get(from).push(to);
  }

  const active = new Set();
  const visited = new Set();
  function visit(id) {
    if (active.has(id)) throw new GraphInputError(`Cycles are not allowed in ${relationship} relationships.`);
    if (visited.has(id)) return;

    active.add(id);
    for (const target of targets.get(id) ?? []) visit(target);
    active.delete(id);
    visited.add(id);
  }
  for (const id of targets.keys()) visit(id);
}

/**
 * Validate a v1 packet against the original line numbers retained for its source
 * session and derive its actionable state in packet order.
 */
export function validateGraph(packet, sourceLines) {
  if (!validateShape(packet)) throw new GraphInputError('Invalid version 1 graph packet.');

  const nodes = indexNodes(packet.nodes, sourceLines);
  const edges = indexEdges(packet.edges, nodes);
  assertAcyclic(edges.get('depends_on'), 'dependency');
  assertAcyclic(edges.get('supersedes'), 'supersession');

  const waiting = new Set();
  for (const { from, to } of edges.get('depends_on')) {
    if (nodes.get(to).status !== 'completed') waiting.add(from);
  }
  for (const { from, to } of edges.get('blocks')) {
    if (nodes.get(from).status === 'open') waiting.add(to);
  }

  const superseded = new Set(edges.get('supersedes').map(edge => edge.to));
  return {
    readyActionIds: packet.nodes
      .filter(node => node.kind === 'action' && node.status === 'pending' && !waiting.has(node.id))
      .map(node => node.id),
    currentDecisionIds: packet.nodes
      .filter(node => node.kind === 'decision' && !superseded.has(node.id))
      .map(node => node.id),
  };
}
