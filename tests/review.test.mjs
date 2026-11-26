import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanLabel, createReviews, maxLabel, storageKey, withReviews } from '../public/console/review.mjs';

// Card P3: the reviewer prototype's store. Reviews live in the browser only.
const memory = (initial = null) => {
  const items = new Map(initial === null ? [] : [[storageKey, initial]]);
  return { getItem: key => items.get(key) ?? null, setItem: (key, value) => items.set(key, value), items };
};

test('approve, reject and edit are kept per graph and node, and undo clears them', () => {
  const storage = memory();
  const reviews = createReviews(storage);
  assert.equal(reviews.decide('g1', 'a', 'approved'), true);
  assert.equal(reviews.decide('g1', 'b', 'rejected'), true);
  assert.equal(reviews.decide('g1', 'c', 'edited', '  Use port 4318  '), true);
  assert.deepEqual(reviews.get('g1', 'a'), { decision: 'approved' });
  assert.deepEqual(reviews.get('g1', 'c'), { decision: 'edited', label: 'Use port 4318' });
  // A later publish is a new graph ID, so its nodes start unreviewed.
  assert.equal(reviews.get('g2', 'a'), null);
  reviews.undo('g1', 'b');
  assert.equal(reviews.get('g1', 'b'), null);

  const again = createReviews(storage);
  assert.deepEqual(again.get('g1', 'a'), { decision: 'approved' });
  assert.equal(again.get('g1', 'b'), null);
  assert.deepEqual(again.get('g1', 'c'), { decision: 'edited', label: 'Use port 4318' });
});

test('an edit needs 1 to 300 visible characters, and a refused edit changes nothing', () => {
  const reviews = createReviews(memory());
  reviews.decide('g', 'n', 'approved');
  for (const bad of ['', '   ', 'x'.repeat(maxLabel + 1), `a${String.fromCodePoint(0x202e)}b`, 'two\nlines', undefined]) {
    assert.equal(reviews.decide('g', 'n', 'edited', bad), false, JSON.stringify(bad));
  }
  assert.deepEqual(reviews.get('g', 'n'), { decision: 'approved' });
  assert.equal(cleanLabel('é'.repeat(maxLabel)), 'é'.repeat(maxLabel));
  assert.equal(reviews.decide('g', 'n', 'merged'), false);
  assert.equal(reviews.decide('g', 'n', 'constructor'), false);
});

test('bad stored data is dropped, not thrown', () => {
  for (const stored of ['not json', '{}', 'null', '[1, 2]', '[["g", "n", {"decision": "deleted"}]]', '[["g", "n", {"decision": "edited", "label": ""}]]', '[["g", 5, {"decision": "approved"}]]']) {
    const reviews = createReviews(memory(stored));
    assert.equal(reviews.get('g', 'n'), null, stored);
  }
  const mixed = createReviews(memory(JSON.stringify([['g', 'ok', { decision: 'approved', extra: 1 }], ['g', 'bad', { decision: 'nope' }]])));
  assert.deepEqual(mixed.get('g', 'ok'), { decision: 'approved' });
  assert.equal(mixed.get('g', 'bad'), null);
  // Graph and node IDs cannot collide by containing a separator.
  const ids = createReviews(memory());
  ids.decide('a/b', 'c', 'approved');
  assert.equal(ids.get('a', 'b/c'), null);
});

test('a storage that throws only loses persistence', () => {
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  const reviews = createReviews(broken);
  assert.equal(reviews.decide('g', 'n', 'rejected'), true);
  assert.deepEqual(reviews.get('g', 'n'), { decision: 'rejected' });
  assert.equal(createReviews(null).decide('g', 'n', 'approved'), true);
});

test('the graph view carries each node\'s review', () => {
  const reviews = createReviews(memory());
  reviews.decide('g1', 'a', 'approved');
  const view = { columns: [{ graphId: 'g1', nodes: [{ id: 'a' }, { id: 'b' }] }], edges: [] };
  const shown = withReviews(view, reviews);
  assert.deepEqual(shown.columns[0].nodes.map(node => node.review), [{ decision: 'approved' }, null]);
  assert.equal(view.columns[0].nodes[0].review, undefined);
});
