// Card P2c (ADR-7c, 7d): a person approves or rejects one version 3 node by its hash.
// Card P3 (ADR-6, ADR-17): every decision is an append-only review event, chained by
// hash, and the decisions a graph shows are a fold of the events: the latest event for a
// node hash wins. A decision is keyed by the graph's session, party, node ID and hash, so
// a republish from that session keeps it while the node is unchanged, and a changed node
// starts unreviewed. Reviewer names are typed by the person and are self-asserted.
// Errors are fixed sentences that never echo a value.
import { createHash } from 'node:crypto';
import { ConflictError, InputError } from './errors.mjs';
import { canonicalJson } from './sign.mjs';

export const decisions = ['approve', 'edit', 'reject'];
const hashPattern = /^[a-f0-9]{64}$/u;
// One line of visible text, as graph labels are: no control, format or separator
// character, and something to show.
const reviewerPattern = /^[^\p{C}\p{Zl}\p{Zp}]{1,64}$/u;
export const reviewerRule = 'reviewer must be your name: 1 to 64 visible characters on one line.';
export const labelRule = 'An edit needs label: the corrected label, 1 to 500 characters of well-formed text.';
/** The prev of the first event. */
export const genesis = '0'.repeat(64);

/** SHA-256 of the JCS form of what a person checks on a version 3 node: never its ID. */
export function nodeSha256(node) {
  const content = { kind: node.kind, label: node.label, evidence: node.evidence };
  if (node.status !== undefined) content.status = node.status;
  if (node.to !== undefined) content.to = node.to;
  return createHash('sha256').update(canonicalJson(content), 'utf8').digest('hex');
}

/** The hashes of a canonical version 3 packet's nodes, in its order. */
export const nodeHashes = packet => packet.nodes.map(node => ({ id: node.id, sha256: nodeSha256(node) }));

/**
 * The hash of one review event: SHA-256 of the RFC 8785 JCS form of everything it says
 * and the hash of the event before it. label is present only on an edit.
 */
export function eventHash(event) {
  const content = {
    prev: event.prev, sessionId: event.sessionId, party: event.party, nodeId: event.nodeId,
    nodeSha256: event.nodeSha256, decision: event.decision, reviewer: event.reviewer, decidedAt: event.decidedAt,
  };
  if (event.decision === 'edit') content.label = event.label;
  return createHash('sha256').update(canonicalJson(content), 'utf8').digest('hex');
}

const eventColumns = `seq, prev, hash, session_id AS sessionId, party, node_id AS nodeId, node_sha256 AS nodeSha256,
  decision, label_json AS labelJson, reviewer, decided_at AS decidedAt`;
// An edit's label is stored as a JSON string literal, like message text, because SQLite
// cuts a string at a NUL and the hash covers every character.
const fromRow = ({ labelJson, ...row }) => (labelJson === null ? { ...row } : { ...row, label: JSON.parse(labelJson) });

/**
 * Checks a chain of events in seq order: seq counts from 1, each prev is the hash before
 * it, and each hash is the hash of its own event. Returns the count and head, or the
 * first seq that breaks. A chain whose last events were removed still checks; with a
 * trusted head (one seen earlier, or signed), trustedAt is the seq of that head, or
 * null when the chain does not contain it.
 */
export function checkChain(events, trustedHead) {
  let prev = genesis;
  let count = 0;
  let trustedAt = trustedHead === genesis ? 0 : null;
  for (const event of events) {
    count += 1;
    if (event.seq !== count || event.prev !== prev || event.hash !== eventHash(event)) return { events: count, brokenAt: count };
    prev = event.hash;
    if (event.hash === trustedHead) trustedAt = count;
  }
  return trustedHead === undefined ? { events: count, head: prev } : { events: count, head: prev, trustedAt };
}

/** One event row, as appendEvent and the version 7 migration write it. */
export function insertEvent(database, event) {
  database.prepare(`INSERT INTO review_events (seq, prev, hash, session_id, party, node_id, node_sha256, decision, label_json, reviewer, decided_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(event.seq, event.prev, event.hash, event.sessionId, event.party, event.nodeId,
    event.nodeSha256, event.decision, event.decision === 'edit' ? JSON.stringify(event.label) : null, event.reviewer, event.decidedAt);
}

/**
 * Appends one event after the current head. The head is read inside the transaction the
 * caller holds, or under a write lock taken here, so two stores on one file keep one chain.
 */
export function appendEvent(database, fields) {
  const last = database.prepare('SELECT seq, hash FROM review_events ORDER BY seq DESC LIMIT 1').get();
  const decidedAt = fields.decidedAt ?? database.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now").get().now;
  const event = { ...fields, seq: (last?.seq ?? 0) + 1, prev: last?.hash ?? genesis, decidedAt };
  event.hash = eventHash(event);
  insertEvent(database, event);
  return event;
}

export function mountReviews(database, readGraph) {
  const prepared = new Map();
  const statement = sql => {
    if (!prepared.has(sql)) prepared.set(sql, database.prepare(sql));
    return prepared.get(sql);
  };

  /** The fold: the latest event on each current hash of a stored version 3 graph's nodes. */
  function reviewsOf(graph) {
    if (graph?.packet.version !== 3 || !Array.isArray(graph.nodeHashes)) return [];
    const events = statement(`SELECT ${eventColumns} FROM review_events WHERE session_id = ? AND party = ? ORDER BY seq`)
      .all(graph.packet.sessionId, graph.packet.party).map(fromRow);
    const current = new Map(graph.nodeHashes.map(entry => [entry.id, entry.sha256]));
    const latest = new Map();
    for (const event of events) {
      if (current.get(event.nodeId) === event.nodeSha256) latest.set(event.nodeId, event);
    }
    // In the graph's node order; a node ID appears once in a packet.
    return graph.nodeHashes.filter(entry => latest.has(entry.id)).map(entry => {
      const { nodeId, nodeSha256: hash, decision, label, reviewer, decidedAt, hash: event } = latest.get(entry.id);
      return { nodeId, nodeSha256: hash, decision, ...(decision === 'edit' ? { label } : {}), reviewer, decidedAt, event };
    });
  }

  return {
    graphReviews: id => reviewsOf(readGraph(id)),

    /** Checks every event in order: the count and head hash, or the first event that breaks; see checkChain. */
    verifyReviews(trustedHead) {
      return checkChain(statement(`SELECT ${eventColumns} FROM review_events ORDER BY seq`).all().map(fromRow), trustedHead);
    },

    /** Records one person's decision on one node of a graph; undefined when there is no such graph. */
    reviewNode(graphId, input) {
      const graph = readGraph(graphId);
      if (!graph) return;
      if (graph.packet.version !== 3 || !Array.isArray(graph.nodeHashes)) throw new InputError('Only version 3 graph nodes are reviewed by hash.');
      if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new InputError('A review must be a JSON object.');
      for (const key of Object.keys(input)) {
        if (!['nodeId', 'nodeSha256', 'decision', 'reviewer', 'label'].includes(key)) {
          throw new InputError('A review has only nodeId, nodeSha256, decision, reviewer and, for an edit, label.');
        }
      }
      const { nodeId, nodeSha256: hash, decision, reviewer, label } = input;
      const current = graph.nodeHashes.find(entry => entry.id === nodeId);
      if (!current) throw new InputError('Unknown node in this graph.');
      if (typeof hash !== 'string' || !hashPattern.test(hash)) throw new InputError('nodeSha256 must be a 64-character lowercase hex hash.');
      if (!decisions.includes(decision)) throw new InputError('decision must be approve, edit or reject.');
      if (typeof reviewer !== 'string' || !reviewerPattern.test(reviewer) || !/\S/u.test(reviewer)) throw new InputError(reviewerRule);
      if (decision === 'edit') {
        if (typeof label !== 'string' || label.length < 1 || label.length > 500 || !label.isWellFormed() || !/\S/u.test(label)) {
          throw new InputError(labelRule);
        }
      } else if (label !== undefined) {
        throw new InputError('Only an edit carries a label.');
      }
      // The page may show an older snapshot: a decision is only for what the person saw.
      if (hash !== current.sha256) throw new ConflictError('This node has changed since it was shown; reload the graph and review it again.');
      database.exec('BEGIN IMMEDIATE');
      let pending = true;
      try {
        appendEvent(database, { sessionId: graph.packet.sessionId, party: graph.packet.party, nodeId, nodeSha256: hash, decision, label, reviewer });
        database.exec('COMMIT');
        pending = false;
      } finally {
        if (pending) database.exec('ROLLBACK');
      }
      return reviewsOf(graph);
    },
  };
}
