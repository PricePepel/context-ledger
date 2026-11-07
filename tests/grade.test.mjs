import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gradeSlice } from '../evals/latent/grade.mjs';

const question = { id: 'q', required: [['3', 'three'], ['250'], ['doubl', '2 **']], evidence: [{ path: 'a.js', lines: [1, 2] }] };
const slice = (answer, findings = []) => ({ answer, findings });

test('Tenki fix: numeric options match whole numbers, not digits inside other numbers', () => {
  assert.equal(gradeSlice(question, slice('Retried 3 times, 250 ms, doubling.')).correct, true);
  assert.equal(gradeSlice(question, slice('Retried three times from 250 ms with 2 ** attempt.')).correct, true);
  assert.equal(gradeSlice(question, slice('Waits 30 minutes, then 1250 ms, doubling.')).correct, false, '3 inside 30 and 250 inside 1250');
  assert.equal(gradeSlice(question, slice('Retried 3.5 times, 250 ms, doubling.')).correct, false, '3 is not 3.5');
  assert.equal(gradeSlice(question, slice('Retry limit: 3; base 250ms; it doubles.')).correct, true, 'a unit glued to 250 is still 250');
  assert.equal(gradeSlice(question, slice('Limit 13, base 2500 ms, doubling.')).correct, false, '3 inside 13, 250 inside 2500');
  assert.equal(gradeSlice(question, slice('Retried 3 times', [{ label: 'RETRY_BASE_MS is 250, doubling', evidence: [] }])).correct, true);
});

test('citation overlap is unchanged', () => {
  const cited = slice('x', [{ label: 'l', evidence: [{ path: 'a.js', startLine: 2, endLine: 5 }] }]);
  const missed = slice('x', [{ label: 'l', evidence: [{ path: 'a.js', startLine: 3, endLine: 5 }] }]);
  assert.equal(gradeSlice(question, cited).cited, true);
  assert.equal(gradeSlice(question, missed).cited, false);
});
