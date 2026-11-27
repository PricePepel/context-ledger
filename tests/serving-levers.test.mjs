import assert from 'node:assert/strict';
import test from 'node:test';
import { agentMessages, fillerText, kvGiB, metricsDelta, parseStartupLog, percentile, serveEnv, summarizeRun } from '../evals/latent/serving-lib.mjs';

const log = [
  '(EngineCore pid=1) INFO Model loading took 5.21 GiB memory and 6.4 seconds',
  '(EngineCore pid=1) INFO Available KV cache memory: 7.51 GiB',
  '(EngineCore pid=1) INFO GPU KV cache size: 137,136 tokens, Maximum concurrency for 32,768 tokens per request: 4.18x',
  '(EngineCore pid=1) INFO Graph capturing finished in 8 secs, took 0.37 GiB',
  '(EngineCore pid=1) INFO Graph capturing finished in 9 secs, took 0.24 GiB',
  '(EngineCore pid=1) INFO init engine (profile, create kv cache, warmup model) took 25.24 s (compilation: 0.34 s)',
].join('\n');

test('startup log: weights, KV pool, tokens, concurrency and graphs', () => {
  const info = parseStartupLog(log);
  assert.equal(info.weightsGiB, 5.21);
  assert.equal(info.kvPoolGiB, 7.51);
  assert.equal(info.kvTokens, 137136);
  assert.equal(info.maxConcurrency, 4.18);
  assert.equal(info.maxConcurrencyTokensPerRequest, 32768);
  assert.equal(info.cudaGraphGiB, 0.61);
  assert.equal(info.engineInitSeconds, 25.24);
  assert.equal(info.loadSeconds, 6.4);
});

test('startup log: a missing line is null, not a guess; the last mention wins', () => {
  const info = parseStartupLog('GPU KV cache size: 10 tokens\nGPU KV cache size: 20 tokens');
  assert.equal(info.kvTokens, 20);
  assert.equal(info.weightsGiB, null);
  assert.equal(parseStartupLog('').cudaGraphGiB, null);
});

test('percentile: nearest rank, ignores non-numbers, null when empty', () => {
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(percentile([1, 2, 3, 4], 90), 4);
  assert.equal(percentile([Number.NaN], 50), null);
});

test('filler text is deterministic per seed and sized in words', () => {
  assert.equal(fillerText(50, 3), fillerText(50, 3));
  assert.notEqual(fillerText(50, 3), fillerText(50, 4));
  assert.equal(fillerText(60, 1).split(/\s+/u).filter(word => word !== '.').length, 60);
});

test('agent messages: the salt and handbook are shared, the notes are not', () => {
  const a = agentMessages({ system: 'S', report: 'R1', salt: 'abc', handbookWords: 10, uniqueWords: 5, index: 0 });
  const b = agentMessages({ system: 'S', report: 'R2', salt: 'abc', handbookWords: 10, uniqueWords: 5, index: 1 });
  assert.equal(a[0].content, b[0].content);
  assert.match(a[0].content, /^Run abc\./u);
  assert.notEqual(a[1].content, b[1].content);
  assert.equal(agentMessages({ system: 'S', report: 'R', salt: 'x' })[0].content, 'Run x.\nS');
});

test('metrics delta: hit rate from counters, null when a counter is missing', () => {
  const before = { 'vllm:prefix_cache_queries_total': 100, 'vllm:prefix_cache_hits_total': 10 };
  const after = { 'vllm:prefix_cache_queries_total': 300, 'vllm:prefix_cache_hits_total': 110, 'vllm:num_preemptions_total': 2 };
  const delta = metricsDelta(before, after);
  assert.equal(delta.prefixHitRate, 0.5);
  assert.equal(delta.preemptions, null);
  assert.equal(metricsDelta({}, {}).prefixHitRate, null);
  // A counter that went down (restart), or a missing hit counter, is not a hit rate.
  assert.equal(metricsDelta({ 'vllm:prefix_cache_queries_total': 100, 'vllm:prefix_cache_hits_total': 50 },
    { 'vllm:prefix_cache_queries_total': 20, 'vllm:prefix_cache_hits_total': 5 }).prefixHitRate, null);
  // One counter dropping voids the others too (a restart, even if the prefix counters climbed back).
  const restart = metricsDelta({ 'vllm:prefix_cache_queries_total': 10, 'vllm:prefix_cache_hits_total': 5, 'vllm:prompt_tokens_total': 900 },
    { 'vllm:prefix_cache_queries_total': 50, 'vllm:prefix_cache_hits_total': 30, 'vllm:prompt_tokens_total': 100 });
  assert.equal(restart.prefixHitRate, null);
  assert.equal(restart.promptTokens, null);
  assert.equal(metricsDelta({ 'vllm:prefix_cache_queries_total': 1 }, { 'vllm:prefix_cache_queries_total': 9 }).prefixHitRate, null);
});

test('run summary: counts, rates and the GPU peak', () => {
  const agents = [
    { ok: true, responded: true, ms: 1000, correct: true, verified: true, promptTokens: 400, completionTokens: 40 },
    { ok: true, responded: true, ms: 3000, correct: false, verified: true, promptTokens: 400, completionTokens: 60 },
    { ok: false, responded: false, ms: 5000 },
  ];
  const run = summarizeRun({ agents, wallMs: 4000, delta: { prefixHitRate: 0.8123, preemptions: 0 }, kvPeak: 0.4567, gpuSamplesMiB: [100, Number.NaN, 900] });
  assert.equal(run.answered, 2);
  assert.equal(run.failed, 1);
  assert.equal(run.correct, 1);
  assert.equal(run.verified, 2);
  assert.equal(run.wallSeconds, 4);
  assert.equal(run.completionTokensPerSecond, 25);
  assert.equal(run.promptTokensPerSecond, 200);
  assert.equal(run.prefixHitRate, 0.812);
  assert.equal(run.kvPeakShare, 0.457);
  assert.equal(run.gpuPeakMiB, 900);
});

test('serve environment names only what is set', () => {
  assert.deepEqual(serveEnv({}), {});
  assert.deepEqual(serveEnv({ maxNumSeqs: 64, kvOffloadGiB: 8, kvDtype: 'fp8_per_token_head', gpuUtil: 0.9 }),
    { VLLM_MAX_NUM_SEQS: '64', VLLM_KV_OFFLOAD_GIB: '8', VLLM_KV_DTYPE: 'fp8_per_token_head', VLLM_GPU_UTIL: '0.9' });
});

test('run summary: tokens of unusable replies still count, a missing KV sample is null', () => {
  const agents = [{ ok: false, responded: true, ms: 100, promptTokens: 400, completionTokens: 160 }];
  const run = summarizeRun({ agents, wallMs: 1000, delta: { prefixHitRate: null, preemptions: null }, kvPeak: null, gpuSamplesMiB: [] });
  assert.equal(run.responded, 1);
  assert.equal(run.answered, 0);
  assert.equal(run.promptTokens, 400);
  assert.equal(run.kvPeakShare, null);
  assert.equal(run.gpuPeakMiB, null);
});

test('KV GiB from tokens and bytes per token', () => {
  assert.equal(kvGiB(1024 ** 3 / 57344, 57344), 1);
});
