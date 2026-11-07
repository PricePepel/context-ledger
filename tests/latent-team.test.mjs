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
    latentStepsPerAgent: 40, latentVectors: 120, generatedTokens: 96, seconds: 3.2 });
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
