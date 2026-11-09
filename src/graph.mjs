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

const isPlainObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);
// Case, spacing and typographic quote or dash variants must not decide whether a quote matches.
const normalizeQuote = text => text.normalize('NFKC').toLowerCase()
  .replace(/[\u2018\u2019\u201A\u201B\u2032\u00B4`]/gu, "'")
  .replace(/[\u201C\u201D\u201E\u201F\u2033\u00AB\u00BB]/gu, '"')
  .replace(/[\u2010-\u2015\u2212]/gu, '-')
  .replace(/\s+/gu, ' ')
  .trim();

/**
 * Turn the evidenceQuotes of a version 2 packet into evidenceLines: each quote cites the
 * latest stored turn that contains it. The result carries line numbers only, so graph
 * identity and briefings do not depend on how a node was cited. Errors name the node and
 * quote by position and never echo the quote.
 */
export function resolveEvidenceQuotes(packet, messages) {
  if (packet?.version !== 2 || !Array.isArray(packet.nodes)) return packet;
  if (!packet.nodes.some(node => isPlainObject(node) && Object.hasOwn(node, 'evidenceQuotes'))) return packet;
  const turns = messages.map(message => ({ line: message.line, text: normalizeQuote(message.text) }));
  const nodes = packet.nodes.map((node, index) => {
    if (!isPlainObject(node) || !Object.hasOwn(node, 'evidenceQuotes')) return node;
    const where = `Node ${index + 1}`;
    const quotes = node.evidenceQuotes;
    if (!Array.isArray(quotes) || quotes.length < 1 || quotes.length > 8) {
      throw new GraphInputError(`${where}: evidenceQuotes must list 1 to 8 quotes.`);
    }
    const lines = new Set(Array.isArray(node.evidenceLines) ? node.evidenceLines : []);
    quotes.forEach((quote, quoteIndex) => {
      if (typeof quote !== 'string' || quote.length < 8 || quote.length > 400) {
        throw new GraphInputError(`${where}, quote ${quoteIndex + 1}: a quote is 8 to 400 characters.`);
      }
      const needle = normalizeQuote(quote);
      const match = needle && turns.findLast(turn => turn.text.includes(needle));
      if (!match) {
        throw new GraphInputError(`${where}, quote ${quoteIndex + 1}: not found in the session's stored turns. ` +
          'Quote the words exactly as they appear, or cite evidenceLines.');
      }
      lines.add(match.line);
    });
    const { evidenceQuotes: _quotes, ...rest } = node;
    return { ...rest, evidenceLines: [...lines].sort((a, b) => a - b) };
  });
  return { ...packet, nodes };
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

function assertLinks(packet, nodes, superseded, lookupGraph) {
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
    if (remote?.version !== 2) throw new GraphInputError('A link must point at a stored version 2 graph.');
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

// Name where a packet breaks the schema, by position and rule only, so an agent can fix
// it in one retry without reading the whole schema. Values from the packet are never
// echoed, and the text stays short enough for the MCP adapter to pass on.
const where = path => {
  const [, collection, index, ...rest] = path.split('/');
  const singular = { nodes: 'node', edges: 'edge', links: 'link' }[collection];
  if (singular && /^\d+$/u.test(index)) return [`${singular} ${Number(index) + 1}`, ...rest].join(' ');
  return path ? path.slice(1).replaceAll('/', ' ') : 'packet';
};
function schemaProblem(errors) {
  const specific = (errors ?? []).filter(error => !['if', 'anyOf', 'allOf', 'oneOf'].includes(error.keyword));
  const error = specific[0] ?? errors?.[0];
  if (!error) return '';
  const at = where(error.instancePath);
  let rule = error.message ?? 'is invalid';
  if (error.keyword === 'pattern' && /\/id$|\/(?:from|to)$/u.test(error.instancePath)) {
    rule = 'must be lowercase letters and digits joined by single hyphens, like accent-colour';
  } else if (error.keyword === 'pattern') {
    rule = 'must be one line of visible text';
  } else if (error.keyword === 'enum') {
    rule = `must be one of ${error.params.allowedValues.join(', ')}`;
  } else if (error.keyword === 'not') {
    rule = 'has a field its kind does not take: status is only for action, blocker and question; to only for question';
  } else if (error.keyword === 'additionalProperties' && /^[A-Za-z][\w-]{0,39}$/u.test(error.params.additionalProperty)) {
    rule = `has an unknown field ${error.params.additionalProperty}`;
  } else if (error.keyword === 'additionalProperties') {
    rule = 'has an unknown field';
  }
  const text = `: ${at} ${rule}`;
  return text.length <= 150 ? text : text.slice(0, 149) + '…';
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
    throw new GraphInputError(validate ? `Invalid version ${version} graph packet${schemaProblem(validate.errors)}.` : 'Unsupported graph packet version.');
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
