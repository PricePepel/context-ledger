import Ajv2020 from 'ajv/dist/2020.js';
import graphSchemaV1 from '../schemas/semantic-graph.schema.json' with { type: 'json' };
import graphSchemaV2 from '../schemas/semantic-graph-v2.schema.json' with { type: 'json' };
import graphSchemaV3 from '../schemas/semantic-graph-v3.schema.json' with { type: 'json' };

const ajv = new Ajv2020({ strict: true, ownProperties: true });
// A Map, not an object literal: `version` is untrusted input, and an inherited key
// such as "constructor" must not resolve to a function that skips validation.
const validateShape = new Map([[1, ajv.compile(graphSchemaV1)], [2, ajv.compile(graphSchemaV2)], [3, ajv.compile(graphSchemaV3)]]);

export const graphSchemas = { 1: graphSchemaV1, 2: graphSchemaV2, 3: graphSchemaV3 };

/**
 * Card P2b: version 3 is version 2 with citations by message key or artifact instead of
 * line numbers. Both are party graphs: parties, questions, links and rooms work the same.
 */
export const isPartyGraph = packet => packet?.version === 2 || packet?.version === 3;

/**
 * The transcript lines a node cites: its evidenceLines in versions 1 and 2, and in
 * version 3 the lines its message keys resolved to when the graph was published (the
 * stored graph's `citations`). Artifacts cite no line.
 */
export function nodeLines(graph, node) {
  if (graph.packet.version !== 3) return node.evidenceLines;
  return citationOf(graph, node)?.lines ?? [];
}

/** The artifacts a version 3 node cites, as stored when it was published: [{ id, kind, repo, ref }]. */
export function nodeArtifacts(graph, node) {
  return graph.packet.version === 3 ? citationOf(graph, node)?.artifacts ?? [] : [];
}

// `citations` is a list in canonical node order ({ id, lines, artifacts }), not an object,
// so a node ID such as "12" cannot change the order of its keys.
const citationOf = (graph, node) => (Array.isArray(graph.citations) ? graph.citations.find(entry => entry.id === node.id) : undefined);

/**
 * Card P2b: what a version 3 packet's citations resolve to, in canonical node order.
 * `lineOf(key)` gives a stored message's line and `artifactOf(id)` its stored row.
 */
export function resolveCitations(packet, lineOf, artifactOf) {
  return packet.nodes.map(node => ({
    id: node.id,
    lines: [...new Set(node.evidence.filter(citation => citation.message !== undefined).map(citation => lineOf(citation.message)))]
      .sort((a, b) => a - b),
    artifacts: node.evidence.filter(citation => citation.artifact !== undefined).map(citation => {
      const { id, kind, repo, ref } = artifactOf(citation.artifact);
      return { id, kind, repo, ref };
    }),
  }));
}

// Messages before artifacts, each in code-unit order: one canonical order for a set.
const citationKey = citation => (citation.message !== undefined ? '0' + citation.message : '1' + citation.artifact);

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

// Errors name an edge or link by its position and kinds, never by IDs or labels, so
// packet content is not echoed back; that is still enough for an agent to fix it.
const kindsText = kinds => kinds.join('/');

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
  if (!isPartyGraph(packet)) return packet;
  const rank = node => kindOrder.indexOf(node.kind);
  const nodes = packet.nodes
    .map(node => (packet.version === 3
      ? { ...node, evidence: [...node.evidence].sort((a, b) => compareText(citationKey(a), citationKey(b))) }
      : { ...node, evidenceLines: [...node.evidenceLines].sort((a, b) => a - b) }))
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

function indexNodes(nodes, sourceLines, { messageKeys, hasArtifact }) {
  const evidence = new Set(sourceLines);
  const keys = new Set(messageKeys ?? []);
  const byId = new Map();
  for (const node of nodes) {
    if (byId.has(node.id)) throw new GraphInputError('Node IDs must be unique.');
    if (node.evidenceLines && !node.evidenceLines.every(line => evidence.has(line))) {
      throw new GraphInputError('Evidence must refer to stored lines in the source session.');
    }
    // Card P2b: fixed sentences that name no key or artifact ID.
    for (const citation of node.evidence ?? []) {
      if (citation.message !== undefined && !keys.has(citation.message)) {
        throw new GraphInputError('Evidence must cite stored messages of the source session by key.');
      }
      if (citation.artifact !== undefined && !hasArtifact?.(citation.artifact)) {
        throw new GraphInputError('Evidence must cite an artifact registered in this project.');
      }
    }
    byId.set(node.id, node);
  }
  return byId;
}

function indexEdges(edges, nodes) {
  const seen = new Set();
  const byType = new Map(Object.keys(edgeKinds).map(type => [type, []]));
  for (const [index, edge] of edges.entries()) {
    const { from, to, type } = edge;
    const where = `Edge ${index + 1} (${type})`;
    const [fromKinds, toKinds] = edgeKinds[type];
    const fromKind = nodes.get(from)?.kind ?? 'unknown node';
    const toKind = nodes.get(to)?.kind ?? 'unknown node';
    if (from === to) throw new GraphInputError(`${where}: an edge must connect distinct nodes.`);
    if (!fromKinds.includes(fromKind) || !toKinds.includes(toKind)) {
      throw new GraphInputError(`${where}: expected kinds ${kindsText(fromKinds)}→${kindsText(toKinds)}, got ${fromKind}→${toKind}.`);
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

function assertLinks(packet, nodes, superseded, lookupGraph, sameProject) {
  const seen = new Set();
  const remoteGraphs = new Map();
  for (const [index, { from, graph, to, type }] of (packet.links ?? []).entries()) {
    const where = `Link ${index + 1} (${type})`;
    const [fromKinds, toKinds] = linkKinds[type];
    const fromKind = nodes.get(from)?.kind;
    if (!fromKinds.includes(fromKind)) {
      throw new GraphInputError(`${where}: must start at a local node of kind ${kindsText(fromKinds)}, got ${fromKind ?? 'unknown node'}.`);
    }
    if (superseded.has(from)) throw new GraphInputError('A link cannot start at a superseded decision.');
    if (!remoteGraphs.has(graph)) remoteGraphs.set(graph, lookupGraph?.(graph));
    const remote = remoteGraphs.get(graph)?.packet;
    if (!isPartyGraph(remote)) throw new GraphInputError('A link must point at a stored version 2 or 3 graph.');
    // Card P2a (ADR-7a): graphs are project-scoped, so a link cannot cross projects.
    if (sameProject && !sameProject(graph)) throw new GraphInputError('A link must point at a graph in the same project.');
    // Party names are self-asserted. Requiring a different transcript at least stops
    // one session from posing as both sides of a negotiation.
    if (remote.party === packet.party || remote.sessionId === packet.sessionId) {
      throw new GraphInputError('A link must point at another party\'s graph from another session.');
    }

    const target = remote.nodes.find(node => node.id === to);
    if (!toKinds.includes(target?.kind)) {
      throw new GraphInputError(`${where}: must end at a remote node of kind ${kindsText(toKinds)}, got ${target?.kind ?? 'unknown node'}.`);
    }
    // A link to a replaced decision would put a stale match or conflict in the room.
    if (remote.edges.some(edge => edge.type === 'supersedes' && edge.to === to)) {
      throw new GraphInputError(`${where}: its target decision is superseded in the other graph; link to the current one.`);
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
 * are checked with `lookupGraph(id)`, which returns a stored graph or undefined, and
 * `sameProject(id)`, true when that graph is in this packet's project (P2a). Version 3
 * citations are checked against `messageKeys` (the session's keys) and `hasArtifact(id)`,
 * true for an artifact registered in this packet's project (P2b).
 */
export function validateGraph(packet, sourceLines, { lookupGraph, sameProject, messageKeys, hasArtifact } = {}) {
  const version = packet?.version;
  const validate = validateShape.get(version);
  if (!validate?.(packet)) {
    throw new GraphInputError(validate ? `Invalid version ${version} graph packet.` : 'Unsupported graph packet version.');
  }

  const nodes = indexNodes(packet.nodes, sourceLines, { messageKeys, hasArtifact });
  const edges = indexEdges(packet.edges, nodes);
  assertAcyclic(edges.get('depends_on'), 'dependency');
  assertAcyclic(edges.get('supersedes'), 'supersession');
  const superseded = new Set(edges.get('supersedes').map(edge => edge.to));
  // P2c review: a version 3 node is hashed with JCS, which refuses a lone surrogate, so
  // such a label is refused here with a fixed sentence instead of failing the publish.
  if (version === 3 && packet.nodes.some(node => !node.label.isWellFormed())) {
    throw new GraphInputError('A label must be well-formed Unicode text.');
  }
  if (isPartyGraph(packet)) {
    if (packet.nodes.some(node => node.kind === 'question' && node.to === packet.party)) {
      throw new GraphInputError('A question must be addressed to another party.');
    }
    assertLinks(packet, nodes, superseded, lookupGraph, sameProject);
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
  if (!isPartyGraph(packet)) return derived;

  const answered = new Set(edges.get('answers').filter(edge => !superseded.has(edge.from)).map(edge => edge.to));
  return {
    ...derived,
    openQuestionIds: packet.nodes
      .filter(node => node.kind === 'question' && node.status === 'open' && !answered.has(node.id))
      .map(node => node.id),
  };
}
