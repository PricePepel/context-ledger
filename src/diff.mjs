// Card G11: what changed between two snapshots of one party's graph. Both are party
// graphs (version 2 or 3), so their canonical order is meaningful and the diff follows it.
import { canonicalPacket, compareBy } from './graph.mjs';

// P2b: a version 3 node's citations are its evidence; a field absent on both sides is equal.
const nodeFields = ['kind', 'label', 'status', 'to', 'evidenceLines', 'evidence'];
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const brief = node => ({ id: node.id, kind: node.kind, label: node.label });

/** IDs in one list and not the other, kept in the order of `list`. */
const missingFrom = (list = [], other = []) => list.filter(id => !other.includes(id));

function keyed(items, key) {
  return new Map(items.map(item => [key(item), item]));
}

function setDiff(older, newer, key, order) {
  const before = keyed(older, key);
  const after = keyed(newer, key);
  return {
    added: newer.filter(item => !before.has(key(item))).sort(order),
    removed: older.filter(item => !after.has(key(item))).sort(order),
  };
}

/**
 * The change from `older` to `newer`, two stored graphs. Nodes are added, removed or
 * changed (same ID, another value in a field); decisions and questions are compared
 * through the derived lists the ledger stored with each graph.
 */
export function diffGraphs(older, newer) {
  const a = canonicalPacket(older.packet);
  const b = canonicalPacket(newer.packet);
  const before = keyed(a.nodes, node => node.id);
  const after = keyed(b.nodes, node => node.id);
  const labelOf = id => after.get(id) ?? before.get(id);
  const named = ids => ids.map(id => brief(labelOf(id)));
  // What was lost is named as it was, even when its ID now names another node.
  const namedBefore = ids => ids.map(id => brief(before.get(id)));

  const changed = [];
  for (const node of b.nodes) {
    const old = before.get(node.id);
    if (!old) continue;
    const changes = {};
    for (const field of nodeFields) {
      if (!same(old[field], node[field])) changes[field] = { from: old[field] ?? null, to: node[field] ?? null };
    }
    if (Object.keys(changes).length) changed.push({ ...brief(node), changes });
  }

  const stillThere = id => after.has(id);
  const isKind = (id, kind) => after.get(id)?.kind === kind;
  // Review of G11: a decision is superseded only by a supersedes edge in the newer graph,
  // not because its ID now names a node of another kind.
  const replaced = new Set(b.edges.filter(edge => edge.type === 'supersedes').map(edge => edge.to));
  const edgeKey = edge => `${edge.type}|${edge.from}|${edge.to}`;
  const linkKey = link => `${link.type}|${link.graph}|${link.from}|${link.to}`;
  const diff = {
    fromGraphId: older.id,
    graphId: newer.id,
    party: b.party,
    nodes: {
      added: b.nodes.filter(node => !before.has(node.id)).map(brief),
      removed: a.nodes.filter(node => !after.has(node.id)).map(brief),
      changed,
    },
    // Current in the older graph, still present but no longer current in the newer one.
    supersededDecisions: named(missingFrom(older.currentDecisionIds, newer.currentDecisionIds)
      .filter(id => isKind(id, 'decision') && replaced.has(id))),
    // Still a question in the newer graph, and no longer open there.
    answeredQuestions: named(missingFrom(older.openQuestionIds, newer.openQuestionIds).filter(id => isKind(id, 'question'))),
    openedQuestions: named(missingFrom(newer.openQuestionIds, older.openQuestionIds)),
    readyActionsGained: named(missingFrom(newer.readyActionIds, older.readyActionIds)),
    // A ready action that was removed is lost too; its label comes from the older graph.
    readyActionsLost: namedBefore(missingFrom(older.readyActionIds, newer.readyActionIds)),
    edges: setDiff(a.edges, b.edges, edgeKey, compareBy('type', 'from', 'to')),
    links: setDiff(a.links ?? [], b.links ?? [], linkKey, compareBy('type', 'graph', 'from', 'to')),
  };
  return diff;
}

/** The number of changes in a diff, by list, and whether there are any. */
export function diffCounts(diff) {
  const counts = {
    added: diff.nodes.added.length,
    removed: diff.nodes.removed.length,
    changed: diff.nodes.changed.length,
    superseded: diff.supersededDecisions.length,
    answered: diff.answeredQuestions.length,
    opened: diff.openedQuestions.length,
    edges: diff.edges.added.length + diff.edges.removed.length,
    links: diff.links.added.length + diff.links.removed.length,
    readyGained: diff.readyActionsGained.length,
    readyLost: diff.readyActionsLost.length,
  };
  return { ...counts, any: Object.values(counts).some(Boolean) };
}

/** The list sections of a diff, in order, for paging. */
export const diffSections = [['nodes', 'added'], ['nodes', 'removed'], ['nodes', 'changed'], ['supersededDecisions'],
  ['answeredQuestions'], ['openedQuestions'], ['readyActionsGained'], ['readyActionsLost'],
  ['edges', 'added'], ['edges', 'removed'], ['links', 'added'], ['links', 'removed']];
