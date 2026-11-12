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

test('review of the follow-up: each strict rule is needed, and paraphrases grade right', () => {
  // renewals: the third pattern alone, and its weeks lookahead.
  assert.deepEqual(grades('renewals', ['Renewals: at most 2, each adding 14 days.']), [true]);
  assert.deepEqual(grades('renewals', ['Each renewal adds at most 2 weeks, fourteen renewals in total.']), [false]);
  const renewals = freshQuestion('renewals');
  const [count, length] = renewals.required;
  const renewalExamples = ['It can be renewed 2 times, 14 days each.', 'It can be renewed twice, 14 days each.', 'At most 2, 14 days each.',
    'The renewal limit is 2; 14 days each.'];
  assert.equal(count.length, renewalExamples.length);
  for (const index of count.keys()) {
    const only = { ...renewals, required: [[count[index]], length] };
    const example = renewalExamples[index];
    assert.equal(gradeSlice(only, slice(example)).correct, true, `renewals option ${index} matches its own example`);
  }

  // renew-on-hold: every forbidden option is needed on its own.
  const hold = freshQuestion('renew-on-hold');
  const base = "The renewal throws 'Item is on hold for another member.'";
  const wrong = ['It is not rejected.', 'It succeeds.', 'The loan goes through.', 'There is no error.', 'The member is allowed to renew anyway.',
    'The due date is extended.', 'The loan is still renewed.', 'The loan can still be renewed.', 'The renewal is allowed.'];
  assert.equal(wrong.length, hold.forbidden.length);
  for (const [index, phrase] of wrong.entries()) {
    assert.equal(gradeSlice(hold, slice(`${base} ${phrase}`)).correct, false, phrase);
    const without = { ...hold, forbidden: hold.forbidden.filter((_, other) => other !== index) };
    assert.equal(gradeSlice(without, slice(`${base} ${phrase}`)).correct, true, `forbidden option ${index} is the one that catches "${phrase}"`);
  }
  assert.deepEqual(grades('renew-on-hold', [
    'The renewal is rejected; the member is not allowed to renew while another member holds the item.',
    'The loan cannot be renewed: renew() throws.',
    "The renewal won't throw.", 'The library does not refuse it.', 'It will not reject the renewal.',
  ]), [true, true, false, false, false]);

  // hold-expiry: the next member in other words, and not "the next day".
  assert.deepEqual(grades('hold-expiry', [
    'The hold expires and the following waiting member gets the item.',
    'The hold expires, and itemReturned promotes the next hold in the queue.',
    "The hold expires; the second member in the queue is promoted.",
    'The hold expires; a reminder is sent the next day.',
    'The hold does not expire; the next waiting member waits.',
  ]), [true, true, true, false, false]);
  // Forbidden options read the answer, not finding labels.
  const expiry = freshQuestion('hold-expiry');
  assert.equal(gradeSlice(expiry, slice('The hold expires and the next waiting member gets the item.',
    [{ label: 'A hold does not expire before pickUpBy', evidence: [] }])).correct, true);
});

test('second review of the follow-up: negated success, spaced negations, and the promoted hold', () => {
  assert.deepEqual(grades('renew-on-hold', [
    'The renewal fails; it does not succeed while another member has a hold.',
    'The renewal is rejected; the member is never allowed to renew.',
    'The renewal is rejected; the member is not  allowed to renew.',
    'The renewal throws, so it never goes through.',
    'The renewal still succeeds.',
    'The renewal goes through and no error is shown.',
  ]), [true, true, true, true, false, false]);
  assert.deepEqual(grades('hold-expiry', [
    'The hold expires and the next eligible waiting member gets the item.',
    'The hold expires and the next queued hold is moved to the shelf.',
    "The hold expires and itemReturned promotes the next 'waiting' hold.",
    'The hold expires and promotes another reminder for the original member.',
    'The hold expires; the next day the member gets a reminder.',
  ]), [true, true, true, false, false]);
  // Each hold-expiry pattern is needed on its own.
  const expiry = freshQuestion('hold-expiry');
  const [expired, member] = expiry.required;
  const examples = ['The hold expires and the following waiting member gets the item.', 'The hold expires, promoting another waiting hold to the shelf.',
    'The hold expires and the first person in the queue gets the item.'];
  assert.equal(member.length, examples.length);
  for (const [index, example] of examples.entries()) {
    assert.equal(gradeSlice({ ...expiry, required: [expired, [member[index]]] }, slice(example)).correct, true, `pattern ${index} matches its example`);
    const others = member.filter((_, other) => other !== index);
    assert.equal(gradeSlice({ ...expiry, required: [expired, others] }, slice(example)).correct, false, `only pattern ${index} matches "${example}"`);
  }
});

test('third review of the follow-up: negation windows and the promoted next entry', () => {
  assert.deepEqual(grades('renew-on-hold', [
    'The renewal fails; it cannot succeed while another member has a hold.',
    'The renewal is rejected; it will not be allowed to renew.',
    'The loan is not renewed and fails with an error.',
    'The loan cannot be renewed and throws.',
    'The item is on hold for another member, but the renewal is not actually rejected and proceeds normally.',
  ]), [true, true, true, true, false]);
  assert.deepEqual(grades('hold-expiry', [
    'The hold expires and itemReturned puts the first waiting hold on the shelf.',
    'If the member does not pick up the item in time, the hold expires and the next waiting member gets it.',
    'The hold expires and promotes the original member back onto the shelf.',
    'The hold will not actually expire; the next waiting member remains waiting.',
  ]), [true, true, false, false]);
});

test('final review of the follow-up: ordinary paraphrases that were refused', () => {
  assert.deepEqual(grades('renew-on-hold', [
    'An error is thrown and the due date remains unchanged.',
    'The renewal is rejected; no exception is made for the current borrower.',
    'The renewal is denied because another member holds the item.',
    'No error is thrown and the loan is extended.',
    'The renewal is not denied.',
  ]), [true, true, true, false, false]);
  assert.deepEqual(grades('hold-expiry', [
    'The hold expires and itemReturned promotes the earliest waiting hold to on-shelf.',
    'The hold expires and the earliest waiting member gets the item.',
    "The first member's hold expires and nothing else happens.",
  ]), [true, true, false]);
  assert.deepEqual(grades('renewals', [
    'The renewal limit is 2; each renewal adds 14 days.',
    'There is a cap of two renewals, each adding 14 days.',
    'The renewal cap is 2 weeks; up to 14 renewals.',
  ]), [true, true, false]);
});

test('confirming review of the follow-up: blocked renewals, a cap at two, and the handover to the next member', () => {
  assert.deepEqual(grades('renew-on-hold', [
    'Renewal is blocked until the other hold is cleared.',
    'The loan cannot be extended while another member has a hold.',
    'The renewal is not blocked and the due date is extended.',
  ]), [true, true, false]);
  assert.deepEqual(grades('renewals', ['Renewals are capped at two, adding 14 days each time.']), [true]);
  assert.deepEqual(grades('hold-expiry', [
    'The hold expires and the next waiting member is sent a reminder.',
    'The hold expires and the next waiting member gets the item.',
    'The hold expires and the next queued hold is moved to the shelf.',
  ]), [false, true, true]);
});

test('second confirming review: raises an error, two successive renewals, offered to the next member', () => {
  assert.deepEqual(grades('renew-on-hold', ['The system raises an error and leaves the due date unchanged.']), [true]);
  assert.deepEqual(grades('renewals', ['The loan permits two successive renewals, each adding 14 days.', 'Two weeks renewals, unlimited.']), [true, false]);
  assert.deepEqual(grades('hold-expiry', [
    'The hold expires and the item is offered to the next waiting member.',
    'The hold expires and the next waiting member can collect the item.',
  ]), [true, true]);
});
