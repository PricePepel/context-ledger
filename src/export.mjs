// Card G12: graphs as node-link JSON, the format NetworkX writes and Graphify keeps in
// graphify-out/graph.json (edges under "links"), so decisions can be merged beside code.
//
// Several graphs go into one file (a bundle), because graphify merge-graphs gives each
// input file its own ID prefix: links between graphs only survive inside one file.
import { canonicalPacket, nodeArtifacts, nodeLines } from './graph.mjs';
import { InputError } from './errors.mjs';

// A node is named by its graph's immutable ID and its own ID, so two snapshots of one
// party never share a node (G12 review). Node IDs match ^[a-z0-9]+(?:-[a-z0-9]+)*$ in
// both schemas, so "-" to "_" stays one-to-one; the double underscore cannot come from a
// single "-". The first 16 hex digits of the graph ID (64 bits) keep IDs short.
export const graphPrefixLength = 16;
export const exportNodeId = (graphId, nodeId) => `ctm_${graphId.slice(0, graphPrefixLength)}__${nodeId.replaceAll('-', '_')}`;
export const maxBundleGraphs = 20;

const fileType = kind => (kind === 'decision' || kind === 'constraint' ? 'rationale' : 'concept');

/**
 * The bundle of stored graphs. sessionOf(graph) returns the graph's session row. Links
 * to a graph outside the bundle are left out and counted, so the merge never gains a
 * node with no label or provenance.
 */
export function nodeLinkBundle(graphs, sessionOf) {
  const ids = new Set(graphs.map(graph => graph.id));
  if (ids.size !== graphs.length) throw new InputError('Each graph may appear once in an export.');
  const nodes = [];
  const links = [];
  let leftOut = 0;
  for (const graph of graphs) {
    const packet = canonicalPacket(graph.packet);
    const sourceFile = sessionOf(graph).source;
    const id = nodeId => exportNodeId(graph.id, nodeId);
    // Undirected for Graphify, so each link also says which end it starts from.
    const link = (from, to, relation) => ({
      source: from, target: to, relation, ledger_from: from, ledger_to: to,
      confidence: 'EXTRACTED', confidence_score: 1, source_file: sourceFile, weight: 1, ledger_graph: graph.id,
    });
    for (const node of packet.nodes) {
      nodes.push({
        id: id(node.id),
        label: node.label,
        file_type: fileType(node.kind),
        // The transcript's file name and the cited lines in it: ledger evidence, not a code path.
        source_file: sourceFile,
        // P2b: a version 3 node's resolved lines, then its artifacts.
        source_location: [...nodeLines(graph, node).map(line => `L${line}`),
          ...nodeArtifacts(graph, node).map(artifact => `${artifact.kind} ${artifact.repo}@${artifact.ref}`)].join(', '),
        kind: node.kind,
        ...(node.status ? { status: node.status } : {}),
        ...(node.to ? { to: node.to } : {}),
        ...(packet.party ? { party: packet.party } : {}),
        ledger_graph: graph.id,
        ledger_node: node.id,
      });
    }
    for (const edge of packet.edges) links.push(link(id(edge.from), id(edge.to), edge.type));
    for (const entry of packet.links ?? []) {
      if (ids.has(entry.graph)) links.push({ ...link(id(entry.from), exportNodeId(entry.graph, entry.to), entry.type), ledger_link_graph: entry.graph });
      else leftOut += 1;
    }
  }
  return {
    // Graphify keeps undirected graphs, and merge-graphs refuses to mix the two.
    directed: false,
    multigraph: false,
    graph: {
      source: 'context-ledger',
      ledger_graphs: graphs.map(graph => ({
        id: graph.id, ...(graph.packet.party ? { party: graph.packet.party } : {}), session: graph.packet.sessionId,
      })),
      links_left_out: leftOut,
    },
    nodes,
    links,
  };
}
