// Card D4: the website runner's read coverage, deviations and cost (Codex review of round 3).
import assert from 'node:assert/strict';
import test from 'node:test';
import { conditionCost, deviations, pageResult, readCoverage } from '../demo/website-build.mjs';

const read = (fromLine, next) => ({ name: 'mcp__context-ledger__session_read', input: fromLine ? { sessionId: 'x', fromLine } : { sessionId: 'x' }, failed: false, next });
const more = line => ({ type: 'tool_result', content: [{ type: 'text', text: `[Partial result: 9 more turns remain. Call session_read again with fromLine ${line}.]\nturns` }] });

test('a page result says where the next page starts, or that none is left', () => {
  assert.deepEqual(pageResult(more(204)), { failed: false, next: 204 });
  assert.deepEqual(pageResult({ type: 'tool_result', content: 'last page' }), { failed: false, next: null });
  assert.deepEqual(pageResult({ type: 'tool_result', is_error: true, content: 'boom' }), { failed: true, next: null });
});

test('review: a reader that stops before the last page is flagged', () => {
  const calls = [read(null, 204), read(204, 406), read(406, 609)];
  const coverage = readCoverage(calls);
  assert.equal(coverage.requests, 3);
  assert.deepEqual(coverage.starts, [1, 204, 406]);
  assert.equal(coverage.finished, false);
  assert.equal(coverage.nextUnread, 609);
  assert.deepEqual(deviations('chat', 'builder', calls), ['stopped reading the chat early (next page at line 609 never read)']);
  assert.deepEqual(deviations('notes', 'first', [read(null, 204)]), ['stopped reading the chat early (next page at line 204 never read)']);
});

test('review: a reader that jumps past a page is flagged even if it reaches the end', () => {
  const calls = [read(null, 204), read(204, 406), read(600, 812), read(812, null)];
  assert.deepEqual(readCoverage(calls).skipped, ['406->600']);
  assert.deepEqual(deviations('chat', 'builder', calls), ['skipped chat pages 406->600']);
});

test('a complete read has no deviation, and a note builder is not asked to read', () => {
  assert.deepEqual(deviations('chat', 'builder', [read(null, 204), read(204, null)]), []);
  assert.deepEqual(deviations('notes', 'builder', []), []);
  assert.deepEqual(deviations('chat', 'builder', []), ['never read the chat']);
});

test('review: a shared first agent is costed once, and a missing cost is marked', () => {
  const first = { costUsd: 0.5 };
  const rows = [{ shared: false, first, builder: { costUsd: 0.1 } }, { shared: true, first, builder: { costUsd: 0.1 } }];
  assert.equal(conditionCost(rows), '$0.70');
  rows.push({ shared: true, first, builder: { costUsd: null } });
  assert.equal(conditionCost(rows), '$0.70 (incomplete: 1 agent reported no cost)');
});
