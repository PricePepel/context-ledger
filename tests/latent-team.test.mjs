// M2c on the ledger side: latent_team forwards a question to the runtime's latent
// agent team and returns only the solver's answer, flattened and marked unverified.
import assert from 'node:assert/strict';
import test from 'node:test';

const { latentTeam } = await import('../src/latent.mjs');
const { InputError } = await import('../src/errors.mjs');

const ok = {
  mode: 'latent-team', answer: 'Step 1...\nThe answer is 18.', answerVerified: false,
  receipt: { model: 'Qwen/Qwen2.5-3B-Instruct', agents: ['planner', 'critic', 'refiner', 'solver'],
    latentStepsPerAgent: 40, latentVectors: 120, generatedTokens: 96, seconds: 3.2, extra: '<x>' },
};

function fakeRuntime(status, body, calls = []) {
  return async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    if (status === 'down') throw new TypeError('fetch failed');
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
}

test('a team run returns the one-line unverified answer and a cleaned receipt', async () => {
  const calls = [];
  const result = await latentTeam({ question: 'Janet has 16 eggs...', latentSteps: 20 }, { fetchImpl: fakeRuntime(200, ok, calls) });
  assert.equal(calls[0].url, 'http://127.0.0.1:4320/latent/team');
  assert.deepEqual(calls[0].body, { question: 'Janet has 16 eggs...', latentSteps: 20 });
  assert.equal(result.mode, 'latent-team');
  assert.equal(result.answer, 'Step 1... The answer is 18.');
  assert.equal(result.answerVerified, false);
  assert.deepEqual(result.receipt, { model: 'Qwen/Qwen2.5-3B-Instruct', agents: ['planner', 'critic', 'refiner', 'solver'],
    system: 'latent_mas', latentStepsPerAgent: 40, latentVectors: 120, generatedTokens: 96, seconds: 3.2, decision: null });
});

test('W1: the watchdog decision passes as words only, and a hold has no answer', async () => {
  const decided = { ...ok, receipt: { ...ok.receipt, system: 'single',
    decision: { action: 'release', reason: 'statistical-flag', marks: ['fallback', 'uncalibrated', '<b>', 7] } } };
  const result = await latentTeam({ question: 'q' }, { fetchImpl: fakeRuntime(200, decided) });
  assert.deepEqual(result.receipt.decision, { action: 'release', reason: 'statistical-flag', marks: ['fallback', 'uncalibrated'] });
  assert.equal(result.receipt.system, 'single');
  const odd = { ...ok, receipt: { ...ok.receipt, decision: { action: 'ship it', reason: `a${String.fromCodePoint(0x1b)}[31m`, marks: 'x' } } };
  assert.deepEqual((await latentTeam({ question: 'q' }, { fetchImpl: fakeRuntime(200, odd) })).receipt.decision,
    { action: null, reason: null, marks: [] });
  const held = await latentTeam({ question: 'q' }, { fetchImpl: fakeRuntime(409,
    { error: "The latent team's answer was held by its watchdog (memoryChecksum); no answer was returned." }) });
  assert.deepEqual(held, { mode: 'held', reason: 'memoryChecksum' });
  const strange = await latentTeam({ question: 'q' }, { fetchImpl: fakeRuntime(409, { error: 'held (<script>)' }) });
  assert.deepEqual(strange, { mode: 'held', reason: 'unknown' });
});

test('W2: declared secrets and the clearance pass to the runtime, checked first', async () => {
  const calls = [];
  const secret = 'cnry'.concat('0123456789abcdef');
  await latentTeam({ question: `keep ${secret}`, secrets: [secret], clearance: 'sensitive' }, { fetchImpl: fakeRuntime(200, ok, calls) });
  assert.deepEqual(calls[0].body, { question: `keep ${secret}`, secrets: [secret], clearance: 'sensitive' });
  for (const input of [{ question: 'q', secrets: 'abcdefgh' }, { question: 'q', secrets: ['short'] }, { question: 'q', secrets: [7] },
    { question: 'q', secrets: Array(17).fill('abcdefgh') }, { question: 'q', clearance: 'top' }]) {
    await assert.rejects(latentTeam(input, { fetchImpl: fakeRuntime(200, ok, calls) }), InputError, JSON.stringify(input));
  }
  assert.equal(calls.length, 1);
});

test('W2: a declared value the one-line printing would rebuild is redacted', async () => {
  const declared = 'harbor slate 42';
  const body = { ...ok, answer: 'It is harbor  slate\n42.' };
  const result = await latentTeam({ question: 'q', secrets: [declared] }, { fetchImpl: fakeRuntime(200, body) });
  assert.ok(!result.answer.includes(declared), result.answer);
  const cleared = await latentTeam({ question: 'q', secrets: [declared], clearance: 'sensitive' }, { fetchImpl: fakeRuntime(200, body) });
  assert.ok(cleared.answer.includes(declared));
});

test('W2: a credential the one-line printing creates is redacted', async () => {
  // An invisible character between a name and its value hides the assignment from the
  // runtime's scan; printed on one line it becomes a space.
  const value = 'harbor'.concat('-slate-42');
  const body = { ...ok, answer: `password${String.fromCodePoint(0x200b)}= ${value}` };
  const result = await latentTeam({ question: 'q' }, { fetchImpl: fakeRuntime(200, body) });
  assert.ok(!result.answer.includes(value), result.answer);
});

test('W2: every copy of a value the printed answer reveals is redacted (review W2-8)', async () => {
  // One-line printing turns an invisible character after the header's name into a space, so
  // the header becomes visible; its value's other copies, plain or escaped, go too.
  const value = 'harbor'.concat('-slate-42');
  const zwsp = String.fromCodePoint(0x200b);
  const escaped = 'harbor'.concat(String.fromCodePoint(92), 'u002d', 'slate-42');
  for (const answer of [`${value} / Authorization:${zwsp}Bearer ${value}`, `${escaped} / Authorization:${zwsp}Bearer ${value}`]) {
    const result = await latentTeam({ question: 'q' }, { fetchImpl: fakeRuntime(200, { ...ok, answer }) });
    assert.equal(result.mode, 'latent-team');
    assert.ok(!result.answer.includes(value) && !result.answer.includes(escaped), result.answer);
  }
});

test('W2: a declared value is redacted in its escaped spelling too', async () => {
  const value = 'harbor'.concat('-slate-42');
  const escaped = 'harbor'.concat(String.fromCodePoint(92), 'u002d', 'slate-42');
  const result = await latentTeam({ question: 'q', secrets: [value] }, { fetchImpl: fakeRuntime(200, { ...ok, answer: `it is ${escaped}` }) });
  assert.ok(!result.answer.includes(escaped), result.answer);
});

test('W2: a quoted copy of a declared value holding a backslash is redacted (review W2-10)', async () => {
  const bs = String.fromCodePoint(92);
  const value = 'harbor'.concat(bs, 'nslate-42');
  const quoted = 'harbor'.concat(bs, bs, 'nslate-42');
  const result = await latentTeam({ question: 'q', secrets: [value] }, { fetchImpl: fakeRuntime(200, { ...ok, answer: `it is "${quoted}"` }) });
  assert.ok(!result.answer.includes(quoted) && !result.answer.includes(value), result.answer);
});

test('W2: a marker never writes a value back (review W2-9)', async () => {
  // ACT is inside REDACTED, and so is a declared REDACTED: another marker is chosen.
  for (const [input, answer, value] of [[{ question: 'q' }, 'password=ACT', 'ACT'],
    [{ question: 'q', secrets: ['REDACTED'] }, 'the REDACTED word', 'REDACTED']]) {
    const result = await latentTeam(input, { fetchImpl: fakeRuntime(200, { ...ok, answer }) });
    assert.equal(result.mode, 'latent-team');
    assert.ok(!result.answer.includes(value), result.answer);
  }
});

test('W2: an answer whose redaction spells a known value is held', async () => {
  // The marker and the text after it spell the declared value: the final check refuses the
  // answer instead of passing it on.
  const token = 'gh'.concat('p_', 'Ab3D'.repeat(9));
  const result = await latentTeam({ question: 'q', secrets: ['token] tail'] }, { fetchImpl: fakeRuntime(200, { ...ok, answer: `${token} tail` }) });
  assert.deepEqual(result, { mode: 'held', reason: 'output-unsafe' });
});

test('bad requests never reach the runtime', async () => {
  const calls = [];
  for (const input of [{}, { question: ' ' }, { question: 'x'.repeat(8001) }, { question: 'q', latentSteps: 81 },
    { question: 'q', latentSteps: 1.5 }, { question: 'q', maxNewTokens: 0 }, { question: 'q', other: 1 }, []]) {
    await assert.rejects(latentTeam(input, { fetchImpl: fakeRuntime(200, ok, calls) }), InputError, JSON.stringify(input));
  }
  assert.equal(calls.length, 0);
});

test('no runtime, a busy team or no team loaded says so instead of failing', async () => {
  for (const [status, reason] of [['down', /not running/u], [503, /busy or not loaded/u], [404, /no agent team/u]]) {
    const result = await latentTeam({ question: 'q' }, { fetchImpl: fakeRuntime(status, { error: 'x' }) });
    assert.equal(result.mode, 'unavailable');
    assert.match(result.reason, reason);
  }
  await assert.rejects(latentTeam({ question: 'q' }, { fetchImpl: fakeRuntime(500, { error: '<script>' }) }),
    error => error.status === 502 && !error.message.includes('<script>'));
  await assert.rejects(latentTeam({ question: 'q' }, { fetchImpl: fakeRuntime(200, { mode: 'latent-team', answer: 5 }) }),
    { status: 502 });
});
