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

// Cycle 9 follow-up F1: the fresh set refuses the wrong answers its first grader let through.
import { readFileSync } from 'node:fs';

const fresh = JSON.parse(readFileSync(new URL('../evals/latent/fresh.json', import.meta.url), 'utf8'));
const freshQuestion = id => fresh.questions.find(entry => entry.id === id);
const grades = (id, answers) => answers.map(answer => gradeSlice(freshQuestion(id), slice(answer)).correct);

test('cycle 9 follow-up: pattern and forbidden options', () => {
  const strict = { id: 'q', required: [[{ pattern: String.raw`\bup to 2\b` }]], forbidden: ['not'], evidence: [] };
  assert.equal(gradeSlice(strict, slice('Up to 2 times.')).correct, true, 'patterns ignore case');
  assert.equal(gradeSlice(strict, slice('Up to 20 times.')).correct, false);
  assert.equal(gradeSlice(strict, slice('Not up to 2 times.')).correct, false, 'a forbidden option fails the answer');
  assert.equal(gradeSlice({ ...strict, forbidden: undefined }, slice('Not up to 2 times.')).correct, true);
});

test('cycle 9 follow-up: renewals needs the number of renewals, not "two weeks"', () => {
  assert.deepEqual(grades('renewals', [
    'A loan can be renewed up to 2 times, and each renewal adds 14 days.',
    'Each loan can be renewed up to 2 times, and each renewal extends the loan by 14 days.',
    'A loan can be renewed twice; each renewal adds two weeks.',
    'Loans allow a maximum of two renewals of fourteen days each.',
  ]), [true, true, true, true]);
  assert.deepEqual(grades('renewals', [
    'Loans can be renewed without limit; each renewal adds two weeks.',
    'A loan can be renewed 14 times, each adding 2 weeks.',
    'A loan can be renewed twice, and each renewal adds 21 days.',
    'Renewals are capped at up to 2 weeks per renewal, 14 in total.',
  ]), [false, false, false, false]);
});

test('cycle 9 follow-up: renew-on-hold refuses an answer that says the renewal goes through', () => {
  assert.deepEqual(grades('renew-on-hold', [
    "The renewal throws 'Item is on hold for another member.'",
    'The renewal is rejected because another member holds the item.',
    'When a member tries to renew a loan while another member has a hold on the item, the renewal process fails and an error is thrown.',
  ]), [true, true, true]);
  assert.deepEqual(grades('renew-on-hold', [
    'The renewal still succeeds; holds only matter at checkout.',
    'The renewal is not rejected: the hold is placed after the loan ends.',
    'Nothing special happens and it does not fail.',
    'No error is thrown, the hold waits.',
  ]), [false, false, false, false]);
});

test('cycle 9 follow-up: hold-expiry needs the expiry and the next waiting member', () => {
  assert.deepEqual(grades('hold-expiry', [
    'The hold expires and the item becomes available for the next waiting member.',
    "The hold's status is set to 'expired', and itemReturned promotes the next waiting hold to 'on-shelf'.",
  ]), [true, true]);
  assert.deepEqual(grades('hold-expiry', [
    "The hold's status changes to 'expired', and a reminder is scheduled for the member.",
    'The hold is marked as expired and the item is returned to the waiting queue.',
    'The hold never expires; it stays until the next member picks it up.',
    'The item goes to the next member in the queue.',
  ]), [false, false, false, false]);
});
