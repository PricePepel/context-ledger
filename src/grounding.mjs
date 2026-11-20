import { isGrounded } from './latent.mjs';

/**
 * Card G7: mark each node quoted or inferred at publish time. A node is quoted when
 * the transcript lines it cites hold what its label claims, by the floor the latent
 * findings use (isGrounded): its numbers, quoted literals and code names, or else one
 * of its content words. Otherwise it is inferred, and a reader should open the cited
 * lines before trusting it. It is a floor, not proof that the label is true.
 *
 * isGrounded keeps a latent finding whose label has nothing to compare (only short or
 * common words). A node needs positive evidence to be quoted, so such a label is
 * inferred: isGrounded(label, '') is true exactly when there is nothing to compare.
 *
 * `messages` are the session's stored messages ({ line, text }). Lists follow the
 * packet's node order, which is canonical for v2 packets.
 */
export function groundNodes(packet, messages) {
  const textAt = new Map(messages.map(message => [message.line, message.text]));
  const quotedNodeIds = [];
  const inferredNodeIds = [];
  for (const node of packet.nodes) {
    const cited = node.evidenceLines.map(line => textAt.get(line) ?? '').join('\n');
    const quoted = !isGrounded(node.label, '') && isGrounded(node.label, cited);
    (quoted ? quotedNodeIds : inferredNodeIds).push(node.id);
  }
  return { quotedNodeIds, inferredNodeIds };
}

/** 'quoted', 'inferred', or null for a graph stored before G7. */
export function nodeGrounding(graph, nodeId) {
  if (graph.quotedNodeIds?.includes(nodeId)) return 'quoted';
  if (graph.inferredNodeIds?.includes(nodeId)) return 'inferred';
  return null;
}
