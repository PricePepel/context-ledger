import Ajv2020 from 'ajv/dist/2020.js';
import graphSchemaV1 from '../schemas/semantic-graph.schema.json' with { type: 'json' };
import graphSchemaV2 from '../schemas/semantic-graph-v2.schema.json' with { type: 'json' };

const ajv = new Ajv2020({ strict: true, ownProperties: true });
// A Map, not an object literal: `version` is untrusted input, and an inherited key
// such as "constructor" must not resolve to a function that skips validation.
const validateShape = new Map([[1, ajv.compile(graphSchemaV1)], [2, ajv.compile(graphSchemaV2)]]);

export const graphSchemas = { 1: graphSchemaV1, 2: graphSchemaV2 };

const edgeKinds = {
  advances: [['action'], ['goal']],
  blocks: [['blocker'], ['action']],
  depends_on: [['action'], ['action']],
  supersedes: [['decision'], ['decision']],
  constrains: [['constraint'], ['action']],
  answers: [['decision'], ['question']],
};

// Cross-graph links: which local kinds may point at which remote kinds.
const linkKinds = {
  matches: [['goal', 'offer', 'action'], ['goal', 'offer', 'action']],
  conflicts: [['goal', 'offer', 'action', 'constraint', 'decision'], ['goal', 'offer', 'action', 'constraint', 'decision']],
  answers: [['decision'], ['question']],
};

export class GraphInputError extends Error {}

// Stable kinds first, volatile kinds (statuses that change as work moves) last, so a
// rendered prefix stays identical across revisions and can be served from a cache.
export const kindOrder = ['goal', 'constraint', 'decision', 'offer', 'action', 'blocker', 'question'];
const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export const compareBy = (...keys) => (a, b) => {
  for (const key of keys) {
    const order = compareText(a[key], b[key]);
    if (order) return order;
  }
  return 0;
};

/**
 * Put a validated v2 packet in its canonical order: nodes by kind then ID, evidence
 * ascending, edges and links by their fields. Order carries no meaning in v2, so two
 * packets that differ only in order canonicalize to the same graph. Version 1 packets
 * keep their order because their identity has always included it.
 */
export function canonicalPacket(packet) {
  if (packet.version !== 2) return packet;
  const rank = node => kindOrder.indexOf(node.kind);
  const nodes = packet.nodes
    .map(node => ({ ...node, evidenceLines: [...node.evidenceLines].sort((a, b) => a - b) }))
    .sort((a, b) => rank(a) - rank(b) || compareText(a.id, b.id));
  const canonical = {
    ...packet,
    nodes,
    edges: [...packet.edges].sort(compareBy('type', 'from', 'to')),
  };
  // An empty list and an absent one mean the same thing, so they hash the same.
  if (packet.links?.length) canonical.links = [...packet.links].sort(compareBy('type', 'graph', 'from', 'to'));
  else delete canonical.links;
  return canonical;
}

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
    const [fromKinds, toKinds] = edgeKinds[type];
    if (from === to || !fromKinds.includes(nodes.get(from)?.kind) || !toKinds.includes(nodes.get(to)?.kind)) {
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

function assertLinks(packet, nodes, superseded, lookupGraph) {
  const seen = new Set();
  const remoteGraphs = new Map();
  for (const { from, graph, to, type } of packet.links ?? []) {
    const [fromKinds, toKinds] = linkKinds[type];
    if (!fromKinds.includes(nodes.get(from)?.kind)) {
      throw new GraphInputError('A link must start at a local node of the expected kind.');
    }
    if (superseded.has(from)) throw new GraphInputError('A link cannot start at a superseded decision.');
    if (!remoteGraphs.has(graph)) remoteGraphs.set(graph, lookupGraph?.(graph));
    const remote = remoteGraphs.get(graph)?.packet;
    if (remote?.version !== 2) throw new GraphInputError('A link must point at a stored version 2 graph.');
    // Party names are self-asserted. Requiring a different transcript at least stops
    // one session from posing as both sides of a negotiation.
    if (remote.party === packet.party || remote.sessionId === packet.sessionId) {
      throw new GraphInputError('A link must point at another party\'s graph from another session.');
    }

    const target = remote.nodes.find(node => node.id === to);
    if (!toKinds.includes(target?.kind)) {
      throw new GraphInputError('A link must end at a remote node of the expected kind.');
    }
    if (type === 'answers' && target.to !== packet.party) {
      throw new GraphInputError('A link can only answer a question addressed to this party.');
    }
    // One relationship per node pair: a pair cannot both match and conflict.
    const key = `${graph}|${from}|${to}`;
    if (seen.has(key)) throw new GraphInputError('Links must be unique per node pair.');
    seen.add(key);
  }
}

/**
 * Validate a v1 or v2 packet against the original line numbers retained for its
 * source session and derive its actionable state in packet order. Version 2 links
 * are checked with `lookupGraph(id)`, which returns a stored graph or undefined.
 */
export function validateGraph(packet, sourceLines, { lookupGraph } = {}) {
  const version = packet?.version;
  const validate = validateShape.get(version);
  if (!validate?.(packet)) {
    throw new GraphInputError(validate ? `Invalid version ${version} graph packet.` : 'Unsupported graph packet version.');
  }

  const nodes = indexNodes(packet.nodes, sourceLines);
  const edges = indexEdges(packet.edges, nodes);
  assertAcyclic(edges.get('depends_on'), 'dependency');
  assertAcyclic(edges.get('supersedes'), 'supersession');
  const superseded = new Set(edges.get('supersedes').map(edge => edge.to));
  if (version === 2) {
    if (packet.nodes.some(node => node.kind === 'question' && node.to === packet.party)) {
      throw new GraphInputError('A question must be addressed to another party.');
    }
    assertLinks(packet, nodes, superseded, lookupGraph);
  }

  const waiting = new Set();
  for (const { from, to } of edges.get('depends_on')) {
    if (nodes.get(to).status !== 'completed') waiting.add(from);
  }
  for (const { from, to } of edges.get('blocks')) {
    if (nodes.get(from).status === 'open') waiting.add(to);
  }

  const derived = {
    readyActionIds: packet.nodes
      .filter(node => node.kind === 'action' && node.status === 'pending' && !waiting.has(node.id))
      .map(node => node.id),
    currentDecisionIds: packet.nodes
      .filter(node => node.kind === 'decision' && !superseded.has(node.id))
      .map(node => node.id),
  };
  if (version !== 2) return derived;

  const answered = new Set(edges.get('answers').filter(edge => !superseded.has(edge.from)).map(edge => edge.to));
  return {
    ...derived,
    openQuestionIds: packet.nodes
      .filter(node => node.kind === 'question' && node.status === 'open' && !answered.has(node.id))
      .map(node => node.id),
  };
}
