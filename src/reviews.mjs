// Card P2c (ADR-7c, 7d): a person approves or rejects one version 3 node by its hash.
// A decision is keyed by the graph's session, party, node ID and hash, so a republish
// from that session keeps it while the node is unchanged, and a changed node starts
// unreviewed. The latest decision for a key replaces the one before; P3 turns these rows
// into the hash-chained events of ADR-6. Reviewer names are typed by the person and
// are self-asserted. Errors are fixed sentences that never echo a value.
import { createHash } from 'node:crypto';
import { ConflictError, InputError } from './errors.mjs';
import { canonicalJson } from './sign.mjs';

export const decisions = ['approve', 'reject'];
const hashPattern = /^[a-f0-9]{64}$/u;
// One line of visible text, as graph labels are: no control, format or separator
// character, and something to show.
const reviewerPattern = /^[^\p{C}\p{Zl}\p{Zp}]{1,64}$/u;
export const reviewerRule = 'reviewer must be your name: 1 to 64 visible characters on one line.';

/** SHA-256 of the JCS form of what a person checks on a version 3 node: never its ID. */
export function nodeSha256(node) {
  const content = { kind: node.kind, label: node.label, evidence: node.evidence };
  if (node.status !== undefined) content.status = node.status;
  if (node.to !== undefined) content.to = node.to;
  return createHash('sha256').update(canonicalJson(content), 'utf8').digest('hex');
}

/** The hashes of a canonical version 3 packet's nodes, in its order. */
export const nodeHashes = packet => packet.nodes.map(node => ({ id: node.id, sha256: nodeSha256(node) }));

export function mountReviews(database, readGraph) {
  const prepared = new Map();
  const statement = sql => {
    if (!prepared.has(sql)) prepared.set(sql, database.prepare(sql));
    return prepared.get(sql);
  };

  /** The decisions on the current hashes of a stored version 3 graph's nodes. */
  function reviewsOf(graph) {
    if (graph?.packet.version !== 3 || !Array.isArray(graph.nodeHashes)) return [];
    const rows = statement(`SELECT node_id AS nodeId, node_sha256 AS nodeSha256, decision, reviewer, decided_at AS decidedAt
      FROM node_reviews WHERE session_id = ? AND party = ?`).all(graph.packet.sessionId, graph.packet.party);
    const current = new Map(graph.nodeHashes.map(entry => [entry.id, entry.sha256]));
    // In the graph's node order.
    const order = new Map(graph.nodeHashes.map((entry, index) => [entry.id, index]));
    return rows.filter(row => current.get(row.nodeId) === row.nodeSha256).map(row => ({ ...row }))
      .sort((a, b) => order.get(a.nodeId) - order.get(b.nodeId));
  }

  return {
    graphReviews: id => reviewsOf(readGraph(id)),

    /** Records one person's decision on one node of a graph; undefined when there is no such graph. */
    reviewNode(graphId, input) {
      const graph = readGraph(graphId);
      if (!graph) return;
      if (graph.packet.version !== 3 || !Array.isArray(graph.nodeHashes)) throw new InputError('Only version 3 graph nodes are reviewed by hash.');
      if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new InputError('A review must be a JSON object.');
      for (const key of Object.keys(input)) {
        if (!['nodeId', 'nodeSha256', 'decision', 'reviewer'].includes(key)) throw new InputError('A review has only nodeId, nodeSha256, decision and reviewer.');
      }
      const { nodeId, nodeSha256: hash, decision, reviewer } = input;
      const current = graph.nodeHashes.find(entry => entry.id === nodeId);
      if (!current) throw new InputError('Unknown node in this graph.');
      if (typeof hash !== 'string' || !hashPattern.test(hash)) throw new InputError('nodeSha256 must be a 64-character lowercase hex hash.');
      if (!decisions.includes(decision)) throw new InputError('decision must be approve or reject.');
      if (typeof reviewer !== 'string' || !reviewerPattern.test(reviewer) || !/\S/u.test(reviewer)) throw new InputError(reviewerRule);
      // The page may show an older snapshot: a decision is only for what the person saw.
      if (hash !== current.sha256) throw new ConflictError('This node has changed since it was shown; reload the graph and review it again.');
      statement(`INSERT INTO node_reviews (session_id, party, node_id, node_sha256, decision, reviewer, decided_at)
        VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        ON CONFLICT (session_id, party, node_id, node_sha256)
        DO UPDATE SET decision = excluded.decision, reviewer = excluded.reviewer, decided_at = excluded.decided_at`)
        .run(graph.packet.sessionId, graph.packet.party, nodeId, hash, decision, reviewer);
      return reviewsOf(graph);
    },
  };
}
