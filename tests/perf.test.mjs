// Card C11: units for the performance harness (evals/latent/perf-lib.mjs) and an end-to-end
// run of evals/latent/perf.mjs against an in-process fake ledger and fake vLLM /metrics.
// No GPU, no model server: every number here is synthetic.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  delta, histogramQuantile, kvBytesPerToken, kvDtypeMismatch, measureReads, parsePrometheus, percentile, readStats, snapshot,
  startKvPoller, summarizeRun,
} from '../evals/latent/perf-lib.mjs';

const execute = promisify(execFile);
const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message ?? ''} expected ${expected}, got ${actual}`);
const MODEL = 'Qwen/Qwen2.5-7B-Instruct-AWQ';
const QWEN7B = { num_hidden_layers: 28, num_attention_heads: 28, num_key_value_heads: 4, hidden_size: 3584 };

// ------------------------------------------------------------------ parsing

test('parsePrometheus reads names, labels, values and skips comments', () => {
  const text = String.raw`# HELP vllm:prompt_tokens_total Number of prefill tokens processed.
# TYPE vllm:prompt_tokens_total counter
vllm:prompt_tokens_total{engine="0",model_name="m"} 1.5e3

vllm:num_requests_running{engine="0",model_name="m"} 0 1700000000000
plain_metric 7
weird{a="q\"uote",b="back\\slash",c="new\nline",d="x,y=z}"} NaN
pos{le="+Inf"} +Inf
neg -Inf
small 2.5E-4
`;
  const series = parsePrometheus(text);
  assert.equal(series.length, 7);
  assert.deepEqual(series[0], { name: 'vllm:prompt_tokens_total', labels: { engine: '0', model_name: 'm' }, value: 1500 });
  assert.equal(series[1].value, 0, 'a trailing timestamp is ignored');
  assert.deepEqual(series[2], { name: 'plain_metric', labels: {}, value: 7 });
  assert.deepEqual(series[3].labels, { a: 'q"uote', b: 'back\\slash', c: 'new\nline', d: 'x,y=z}' });
  assert.ok(Number.isNaN(series[3].value));
  assert.equal(series[4].value, Infinity);
  assert.equal(series[4].labels.le, '+Inf');
  assert.equal(series[5].value, -Infinity);
  assert.equal(series[6].value, 0.00025);
});

test('parsePrometheus accepts CRLF line endings', () => {
  const series = parsePrometheus('# TYPE a counter\r\na_total{x="1"} 3\r\n');
  assert.deepEqual(series, [{ name: 'a_total', labels: { x: '1' }, value: 3 }]);
});

// ------------------------------------------------------------------ snapshots and deltas

// A minimal vLLM 0.33-like exposition. Only some metrics are present, so `missing` is exercised.
function exposition({ model = MODEL, queries, hits, prompt, cached, gen, stop, length, ttft, other = false }) {
  const l = `engine="0",model_name="${model}"`;
  const lines = [
    '# HELP vllm:prefix_cache_queries_total Prefix cache queries, in terms of number of queried tokens.',
    '# TYPE vllm:prefix_cache_queries_total counter',
    `vllm:prefix_cache_queries_total{${l}} ${queries}`,
    `vllm:prefix_cache_queries_created{${l}} 1.7e9`,
    `vllm:prefix_cache_hits_total{${l}} ${hits}`,
    `vllm:prompt_tokens_total{${l}} ${prompt}`,
    `vllm:prompt_tokens_cached_total{${l}} ${cached}`,
    `vllm:generation_tokens_total{${l}} ${gen}`,
    `vllm:request_success_total{${l},finished_reason="stop"} ${stop}`,
    `vllm:request_success_total{${l},finished_reason="length"} ${length}`,
    `vllm:request_success_total{${l},finished_reason="abort"} 0`,
    '# TYPE vllm:time_to_first_token_seconds histogram',
    `vllm:time_to_first_token_seconds_bucket{${l},le="0.1"} ${ttft[0]}`,
    `vllm:time_to_first_token_seconds_bucket{${l},le="0.5"} ${ttft[1]}`,
    `vllm:time_to_first_token_seconds_bucket{${l},le="+Inf"} ${ttft[2]}`,
    `vllm:time_to_first_token_seconds_sum{${l}} ${ttft[3]}`,
    `vllm:time_to_first_token_seconds_count{${l}} ${ttft[2]}`,
    `vllm:time_to_first_token_seconds_created{${l}} 1.7e9`,
    `vllm:kv_cache_usage_perc{${l}} 0.25`,
    `vllm:num_requests_running{${l}} 1`,
    `vllm:cache_config_info{block_size="16",cache_dtype="auto",enable_prefix_caching="True",engine="0",num_gpu_blocks="8571",model_name="${model}"} 1`,
  ];
  if (other) {
    const o = 'engine="0",model_name="other/model"';
    lines.push(`vllm:prefix_cache_queries_total{${o}} 99999`, `vllm:time_to_first_token_seconds_bucket{${o},le="0.1"} 500`,
      `vllm:time_to_first_token_seconds_bucket{${o},le="+Inf"} 500`, `vllm:time_to_first_token_seconds_count{${o}} 500`);
  }
  return lines.join('\n') + '\n';
}

const beforeText = exposition({ queries: 1000, hits: 600, prompt: 1000, cached: 600, gen: 100, stop: 4, length: 1, ttft: [3, 5, 5, 1.2] });
const afterText = exposition({ queries: 1500, hits: 1000, prompt: 1500, cached: 1000, gen: 160, stop: 6, length: 2, ttft: [5, 8, 9, 2.4] });

test('snapshot sums label sets, reads histograms, gauges and the KV pool, and lists missing metrics', () => {
  const snap = snapshot(parsePrometheus(beforeText), { model: MODEL });
  assert.deepEqual(snap.models, [MODEL]);
  assert.equal(snap.counters['vllm:prefix_cache_queries_total'], 1000);
  assert.equal(snap.counters['vllm:request_success_total'], 5, 'finished_reason label sets are summed');
  assert.equal(snap.counters['vllm:num_preemptions_total'], null);
  assert.deepEqual(snap.histograms['vllm:time_to_first_token_seconds'], {
    buckets: [{ le: 0.1, count: 3 }, { le: 0.5, count: 5 }, { le: Infinity, count: 5 }], sum: 1.2, count: 5,
  });
  assert.equal(snap.histograms['vllm:inter_token_latency_seconds'], null);
  assert.equal(snap.gauges['vllm:kv_cache_usage_perc'], 0.25);
  assert.equal(snap.gauges['vllm:num_requests_running'], 1);
  assert.deepEqual(snap.kvPool, { blockSize: 16, numGpuBlocks: 8571, tokens: 137136, cacheDtype: 'auto' });
  assert.ok(snap.missing.includes('vllm:num_preemptions_total'));
  assert.ok(snap.missing.includes('vllm:inter_token_latency_seconds'));
  assert.ok(!snap.missing.includes('vllm:prefix_cache_queries_total'));
  assert.ok(!snap.missing.some(name => name.endsWith('_created')));
});

test('snapshot filters by model_name and ignores *_created series', () => {
  const series = parsePrometheus(exposition({ queries: 1000, hits: 600, prompt: 1000, cached: 600, gen: 100, stop: 4, length: 1, ttft: [3, 5, 5, 1.2], other: true }));
  const mine = snapshot(series, { model: MODEL });
  assert.equal(mine.counters['vllm:prefix_cache_queries_total'], 1000);
  assert.equal(mine.histograms['vllm:time_to_first_token_seconds'].count, 5);
  const all = snapshot(series);
  assert.deepEqual(all.models.sort(), [MODEL, 'other/model'].sort());
  assert.equal(all.counters['vllm:prefix_cache_queries_total'], 100999, 'no model: every label set is summed');
  assert.equal(all.histograms['vllm:time_to_first_token_seconds'].count, 505);
  const none = snapshot(parsePrometheus('vllm:prefix_cache_queries_created{model_name="m"} 5\n'), { model: 'm' });
  assert.equal(none.counters['vllm:prefix_cache_queries_total'], null);
  assert.equal(none.kvPool, null);
  assert.ok(none.missing.includes('vllm:cache_config_info'));
});

test('delta of two snapshots differences counters and histogram buckets', () => {
  const before = snapshot(parsePrometheus(beforeText), { model: MODEL });
  const after = snapshot(parsePrometheus(afterText), { model: MODEL });
  const change = delta(before, after);
  assert.equal(change.reset, false);
  assert.equal(change.counters['vllm:prefix_cache_queries_total'], 500);
  assert.equal(change.counters['vllm:prefix_cache_hits_total'], 400);
  assert.equal(change.counters['vllm:generation_tokens_total'], 60);
  assert.equal(change.counters['vllm:request_success_total'], 3);
  assert.equal(change.counters['vllm:num_preemptions_total'], null);
  const ttft = change.histograms['vllm:time_to_first_token_seconds'];
  assert.deepEqual(ttft.buckets, [{ le: 0.1, count: 2 }, { le: 0.5, count: 3 }, { le: Infinity, count: 4 }]);
  close(ttft.sum, 1.2);
  assert.equal(ttft.count, 4);
  assert.equal(change.histograms['vllm:request_prompt_tokens'], null);
  assert.ok(change.missing.includes('vllm:num_preemptions_total'));
  const stats = readStats(change);
  close(stats.ttftMean, 0.3);
  assert.equal(stats.vllmCalls, 4);
  close(stats.hitRate, 0.8);
  assert.equal(stats.generatedTokens, 60);
});

test('delta marks a counter reset instead of returning negatives', () => {
  const before = snapshot(parsePrometheus(afterText), { model: MODEL });
  const restarted = snapshot(parsePrometheus(exposition({ queries: 10, hits: 5, prompt: 10, cached: 5, gen: 2, stop: 1, length: 0, ttft: [1, 1, 1, 0.05] })), { model: MODEL });
  const change = delta(before, restarted);
  assert.equal(change.reset, true);
  assert.equal(change.counters, undefined);
  assert.deepEqual(readStats(change), { ttftMean: null, vllmCalls: null, hitRate: null, generatedTokens: null });
  // A histogram that went down alone is also a reset.
  const histogramOnly = structuredClone(before);
  histogramOnly.histograms['vllm:time_to_first_token_seconds'].count -= 1;
  assert.equal(delta(before, histogramOnly).reset, true);
});

// ------------------------------------------------------------------ statistics

test('histogramQuantile interpolates inside a bucket, caps at the largest finite bound, and is null when empty', () => {
  const buckets = [{ le: 0.1, count: 2 }, { le: 0.5, count: 4 }, { le: 1, count: 4 }, { le: Infinity, count: 4 }];
  close(histogramQuantile(buckets, 0.5), 0.1, 'rank 2 is the top of the first bucket');
  close(histogramQuantile(buckets, 0.25), 0.05, 'first bucket starts at 0');
  close(histogramQuantile(buckets, 0.75), 0.3, 'rank 3 is half way through (0.1, 0.5]');
  const tail = [{ le: 0.1, count: 1 }, { le: 0.5, count: 2 }, { le: Infinity, count: 10 }];
  assert.equal(histogramQuantile(tail, 0.9), 0.5, 'a quantile in +Inf returns the largest finite bound');
  assert.equal(histogramQuantile([{ le: 0.1, count: 0 }, { le: Infinity, count: 0 }], 0.5), null);
  assert.equal(histogramQuantile([], 0.5), null);
  assert.equal(histogramQuantile([{ le: Infinity, count: 3 }], 0.5), null, 'no finite bucket');
  assert.equal(histogramQuantile(buckets, 1.5), null);
});

test('percentile uses linear interpolation between closest ranks', () => {
  assert.equal(percentile([3, 1, 2, 4], 50), 2.5);
  assert.equal(percentile([3, 1, 2, 4], 0), 1);
  assert.equal(percentile([3, 1, 2, 4], 100), 4);
  close(percentile([10, 20], 90), 19);
  assert.equal(percentile([5], 90), 5);
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([NaN, null, 7], 50), 7, 'non-finite samples are ignored');
});

test('kvBytesPerToken: Qwen2.5-7B-like config, fp8 halves it, fallbacks and errors', () => {
  assert.equal(kvBytesPerToken(QWEN7B, 'auto'), 57344);
  assert.equal(kvBytesPerToken(QWEN7B, 'bfloat16'), 57344);
  assert.equal(kvBytesPerToken(QWEN7B, 'float16'), 57344);
  assert.equal(kvBytesPerToken(QWEN7B, 'fp8'), 28672);
  assert.equal(kvBytesPerToken(QWEN7B, 'fp8_e4m3'), 28672);
  assert.equal(kvBytesPerToken(QWEN7B, 'fp8_e5m2'), 28672);
  assert.equal(kvBytesPerToken({ ...QWEN7B, head_dim: 64 }, 'auto'), 28672, 'an explicit head_dim wins');
  assert.equal(kvBytesPerToken({ ...QWEN7B, num_key_value_heads: undefined }, 'auto'), 28 * 28 * 128 * 2 * 2, 'no KV heads: attention heads');
  assert.equal(kvBytesPerToken({ text_config: QWEN7B }, 'auto'), 57344, 'nested text_config');
  assert.throws(() => kvBytesPerToken(QWEN7B, 'int4'), /Unknown KV-cache dtype/u);
  assert.throws(() => kvBytesPerToken({ hidden_size: 10 }, 'auto'), /num_hidden_layers/u);
});

test('summarizeRun on a hand-built two-read input', () => {
  const totalDelta = {
    reset: false,
    missing: ['vllm:num_preemptions_total'],
    counters: {
      'vllm:prefix_cache_queries_total': 1000, 'vllm:prefix_cache_hits_total': 750, 'vllm:prompt_tokens_total': 1000,
      'vllm:prompt_tokens_cached_total': 750, 'vllm:generation_tokens_total': 300, 'vllm:request_success_total': 4,
      'vllm:num_preemptions_total': null,
    },
    histograms: {
      'vllm:time_to_first_token_seconds': { buckets: [{ le: 0.1, count: 2 }, { le: 0.5, count: 4 }, { le: Infinity, count: 4 }], sum: 0.8, count: 4 },
      'vllm:request_time_per_output_token_seconds': { buckets: [{ le: 0.1, count: 4 }, { le: Infinity, count: 4 }], sum: 0.2, count: 4 },
    },
  };
  const reads = [
    { ms: 2000, correct: true, cited: true, ttftMean: 0.3, kvUsagePeak: 0.02,
      calls: [{ role: 'worker', promptTokens: 1000, cachedTokens: 0, completionTokens: 24 }, { role: 'reducer', promptTokens: 1000, cachedTokens: 900, completionTokens: 0 }] },
    { ms: 1000, correct: true, cited: false, ttftMean: 0.1, kvUsagePeak: 0.05,
      calls: [{ role: 'worker', promptTokens: 1000, cachedTokens: 900, completionTokens: 24 }] },
  ];
  const kvPool = { blockSize: 16, numGpuBlocks: 8571, tokens: 137136, cacheDtype: 'auto' };
  const summary = summarizeRun({ reads, totalDelta, gpuSamplesMiB: [1000, 1500, 1200], kvPool, bytesPerToken: 57344 });
  assert.equal(summary.serverReset, false);
  assert.equal(summary.vllmCalls, 4);
  close(summary.ttft.mean, 0.2);
  close(summary.ttft.p50, 0.1);
  close(summary.ttft.p90, 0.42, 'rank 3.6: 0.1 + 0.4 * 1.6 / 2');
  close(summary.prefixCache.hitRate, 0.75);
  close(summary.prefixCache.receiptCachedShare, 0.6, '1800 cached of 3000 prompt tokens');
  close(summary.tokensPerSecond.perRequestDecode, 20, '1 / 0.05 s per output token');
  close(summary.tokensPerSecond.aggregate, 100, '300 tokens over 3 s');
  assert.deepEqual(summary.memory.gpuUsedMiB, { idle: 1000, peak: 1500 });
  assert.deepEqual(summary.memory.kvPool, kvPool);
  assert.equal(summary.memory.peakKvUsage, 0.05);
  assert.equal(summary.memory.kvBytesPerToken, 57344);
  // read 1: 2024 tokens x 57344 B = 110.6875 MiB; read 2: 1024 tokens = 56 MiB.
  close(summary.memory.kvMiBPerRead.mean, 83.34375);
  close(summary.memory.kvMiBPerRead.max, 110.6875);
  assert.match(summary.memory.kvMiBPerReadBasis, /Upper bound/u);
  assert.deepEqual(summary.latency, { readMs: { p50: 1500, p90: 1900, mean: 1500 }, reads: 2, failedReads: 0 });
  assert.deepEqual(summary.accuracy, { correct: 2, cited: 1, correctAndCited: 1, total: 2 });
  assert.deepEqual(summary.cold, { failed: false, readMs: 2000, ttft: 0.3, steadyReadMs: 1000, steadyTtft: 0.1 });
  assert.deepEqual(summary.metricsCoverage, { reads: 2, total: 2 });
  assert.deepEqual(summary.missing, ['vllm:num_preemptions_total']);
  assert.match(summary.missingReasons['vllm:num_preemptions_total'], /did not export/u);
});

test('summarizeRun without GPU samples, model config or a usable delta', () => {
  const reads = [{ ms: 500, correct: false, cited: false, error: 'boom', calls: [], ttftMean: null, kvUsagePeak: null }];
  const summary = summarizeRun({ reads, totalDelta: { reset: true, missing: [] }, gpuSamplesMiB: null, kvPool: null, bytesPerToken: null });
  assert.equal(summary.serverReset, true);
  assert.equal(summary.ttft, null);
  assert.equal(summary.prefixCache.hitRate, null);
  assert.equal(summary.prefixCache.receiptCachedShare, null);
  assert.equal(summary.tokensPerSecond.aggregate, null);
  assert.equal(summary.memory.gpuUsedMiB, null);
  assert.equal(summary.memory.kvMiBPerRead, null);
  assert.deepEqual(summary.missing, ['gpuMemory', 'kvBytesPerToken']);
  assert.deepEqual(summary.accuracy, { correct: 0, cited: 0, correctAndCited: 0, total: 1 });
  assert.deepEqual(summary.cold, { failed: true, readMs: null, ttft: null, steadyReadMs: null, steadyTtft: null }, 'a failed first read is not a cold measurement');
  assert.equal(summary.latency.readMs.p50, null);
  assert.equal(summary.latency.failedReads, 1);
});

// ------------------------------------------------------------------ end to end

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));

// Fake vLLM: every successful read adds 3 calls with TTFT 0.05 s, 0.02 s per output
// token, 300 queried / 240 hit prefix tokens and 60 generated tokens. The KV gauge is
// 0.5 while state.busy (a read in progress) and 0.01 otherwise once a read has run.
function fakeVllmMetrics(state) {
  const l = `engine="0",model_name="${MODEL}"`;
  const histogram = (name, value) => [
    `# TYPE ${name} histogram`,
    `${name}_bucket{${l},le="0.01"} 0`,
    `${name}_bucket{${l},le="0.1"} ${state.calls}`,
    `${name}_bucket{${l},le="1.0"} ${state.calls}`,
    `${name}_bucket{${l},le="+Inf"} ${state.calls}`,
    `${name}_sum{${l}} ${value * state.calls}`,
    `${name}_count{${l}} ${state.calls}`,
    `${name}_created{${l}} 1.7e9`,
  ];
  return [
    `vllm:prefix_cache_queries_total{${l}} ${state.reads * 300}`,
    `vllm:prefix_cache_hits_total{${l}} ${state.reads * 240}`,
    `vllm:prompt_tokens_total{${l}} ${state.reads * 300}`,
    `vllm:prompt_tokens_cached_total{${l}} ${state.reads * 240}`,
    `vllm:generation_tokens_total{${l}} ${state.reads * 60}`,
    `vllm:request_success_total{${l},finished_reason="stop"} ${state.calls}`,
    `vllm:request_success_total{${l},finished_reason="length"} 0`,
    `vllm:num_preemptions_total{${l}} 0`,
    ...histogram('vllm:time_to_first_token_seconds', 0.05),
    ...histogram('vllm:inter_token_latency_seconds', 0.02),
    ...histogram('vllm:request_time_per_output_token_seconds', 0.02),
    ...histogram('vllm:e2e_request_latency_seconds', 0.5),
    ...histogram('vllm:request_prefill_time_seconds', 0.05),
    ...histogram('vllm:request_decode_time_seconds', 0.4),
    ...histogram('vllm:request_queue_time_seconds', 0.001),
    ...histogram('vllm:request_prompt_tokens', 0.1),
    ...histogram('vllm:request_generation_tokens', 0.1),
    `vllm:kv_cache_usage_perc{${l}} ${state.busy ? 0.5 : state.reads ? 0.01 : 0}`,
    `vllm:num_requests_running{${l}} 0`,
    `vllm:cache_config_info{block_size="16",cache_dtype="${state.cacheDtype ?? 'auto'}",engine="0",num_gpu_blocks="8571",model_name="${MODEL}"} 1`,
    '# TYPE process_start_time_seconds gauge',
    `process_start_time_seconds ${state.processStart ?? 1.7e9}`,
  ].join('\n') + '\n';
}

// ------------------------------------------------------------------ measurement loop (scripted I/O)

const metricsSnap = state => snapshot(parsePrometheus(fakeVllmMetrics({ calls: state.reads * 3, ...state })), { model: MODEL });
const okReply = {
  graph: { answer: 'a' },
  receipt: { calls: [{ role: 'worker', promptTokens: 100, cachedTokens: 80, completionTokens: 20, ms: 40 }] },
};

// takes: one fake-vLLM state per expected scrape (null = that scrape fails); replies:
// one { ms, error? } per read. The clock advances only inside ask(), so read times are exact.
async function runScript({ takes, replies, start = { reads: 0 } }) {
  let clock = 0;
  let asked = 0;
  const queue = takes.map(state => (state === null ? null : metricsSnap(state)));
  const questions = replies.map((_, index) => ({ id: `q${index + 1}`, question: `question ${index + 1}` }));
  const first = metricsSnap(start);
  const result = await measureReads({
    questions,
    start: first,
    now: () => clock,
    take: async () => {
      if (!queue.length) throw new Error('unexpected /metrics scrape');
      return queue.shift();
    },
    ask: async () => {
      const reply = replies[asked++];
      clock += reply.ms;
      if (reply.error) throw new Error(reply.error);
      return okReply;
    },
    grade: question => ({ id: question.id, correct: true, cited: true }),
  });
  const summary = summarizeRun({
    reads: result.reads, totalDelta: delta(first, result.end), coveredReads: result.covered, restarted: result.restarted,
    gpuSamplesMiB: null, kvPool: null, bytesPerToken: null,
  });
  return { ...result, summary, unusedScrapes: queue.length };
}

const reads = n => Array.from({ length: n }, () => ({ ms: 1000 }));
const at = n => ({ reads: n });

test('measureReads: a restart inside a read is reported even when the counters climb back past the start', async () => {
  // Fresh server at 0; reads 1-3 bring it to 180 tokens; it restarts during read 4.
  const run = await runScript({ takes: [at(1), at(2), at(3), at(1), at(2)], replies: reads(5) });
  assert.equal(run.reads[3].delta.reset, true);
  assert.equal(run.reads[3].generatedTokens, null);
  assert.equal(delta(metricsSnap(at(0)), run.end).reset, false, 'start-to-end alone cannot see this restart');
  assert.equal(run.restarted, true);
  assert.equal(run.summary.serverReset, true);
  assert.equal(run.summary.tokensPerSecond.aggregate, null, 'no undercounted aggregate');
  assert.equal(run.summary.vllmCalls, null);
  // summarizeRun alone also catches it from the reads' own deltas.
  const again = summarizeRun({ reads: run.reads, totalDelta: delta(metricsSnap(at(0)), run.end), gpuSamplesMiB: null, kvPool: null, bytesPerToken: null });
  assert.equal(again.serverReset, true);
});

test('measureReads: a restart hidden behind a failed scrape is caught by comparing consecutive good scrapes', async () => {
  // Scrape after read 2 fails; the server restarted meanwhile, so the baseline for read 3 is back at 0.
  const run = await runScript({ takes: [at(1), null, at(0), at(1)], replies: reads(3) });
  assert.equal(run.reads[1].delta, null);
  assert.equal(run.reads[2].delta.reset, false, 'read 3 itself is clean');
  assert.equal(run.restarted, true);
  assert.equal(run.summary.serverReset, true);
});

test('measureReads: one failed scrape nulls one read delta, not two', async () => {
  // The scrape after read 2 fails; read 3 takes a fresh baseline first.
  const run = await runScript({ takes: [at(1), null, at(2), at(3), at(4)], replies: reads(4) });
  assert.equal(run.unusedScrapes, 0);
  assert.equal(run.reads[1].delta, null);
  assert.equal(run.reads[1].generatedTokens, null);
  for (const index of [0, 2, 3]) {
    assert.equal(run.reads[index].generatedTokens, 60, `read ${index + 1}`);
    close(run.reads[index].ttftMean, 0.05);
    close(run.reads[index].hitRate, 0.8);
    assert.equal(run.reads[index].vllmCalls, 3);
  }
  assert.deepEqual(run.summary.metricsCoverage, { reads: 4, total: 4 });
  close(run.summary.tokensPerSecond.aggregate, 60, '240 tokens over 4 s');
});

test('measureReads: a failed final scrape is retried once so the totals include the last read', async () => {
  const takes = [1, 2, 3, 4, 5, 6, 7].map(at);
  const run = await runScript({ takes: [...takes, null, at(8)], replies: reads(8) });
  assert.equal(run.unusedScrapes, 0);
  assert.equal(run.covered, 8);
  assert.equal(run.summary.vllmCalls, 24);
  close(run.summary.tokensPerSecond.aggregate, 60, '480 tokens over 8 s');
  assert.deepEqual(run.summary.metricsCoverage, { reads: 8, total: 8 });
  assert.ok(!run.summary.missing.includes('wholeRunMetrics'));
});

test('measureReads: when the retry also fails the summary says so and divides by the covered reads only', async () => {
  const takes = [1, 2, 3, 4, 5, 6, 7].map(at);
  const run = await runScript({ takes: [...takes, null, null], replies: reads(8) });
  assert.equal(run.covered, 7);
  assert.deepEqual(run.summary.metricsCoverage, { reads: 7, total: 8 });
  assert.equal(run.summary.vllmCalls, 21);
  close(run.summary.tokensPerSecond.aggregate, 60, '420 tokens over the 7 s those counters cover');
  assert.ok(run.summary.missing.includes('wholeRunMetrics'));
  assert.match(run.summary.missingReasons.wholeRunMetrics, /first 7 of 8 reads/u);
});

test('measureReads and summarizeRun: failed reads stay out of latency and the cold read', async () => {
  // Reads 1 and 4 fail at once with HTTP 500; nothing reaches vLLM for them.
  const replies = [{ ms: 20, error: 'q1: HTTP 500' }, { ms: 1000 }, { ms: 1000 }, { ms: 20, error: 'q4: HTTP 500' }, { ms: 1000 }];
  const run = await runScript({ takes: [at(0), at(1), at(2), at(2), at(3)], replies });
  const { summary } = run;
  assert.deepEqual(summary.latency, { readMs: { p50: 1000, p90: 1000, mean: 1000 }, reads: 3, failedReads: 2 });
  const { steadyTtft, ...cold } = summary.cold;
  assert.deepEqual(cold, { failed: true, readMs: null, ttft: null, steadyReadMs: 1000 });
  close(steadyTtft, 0.05);
  assert.equal(run.reads[0].ms, 20, 'the read record keeps its own time');
  // The counters' window includes the failed reads, so their time stays in the aggregate.
  close(summary.tokensPerSecond.aggregate, 180 / 3.04);
});

test('startKvPoller: stop waits for a poll in flight and keeps its sample', async () => {
  let finish;
  let polls = 0;
  const poller = startKvPoller(() => {
    polls += 1;
    return new Promise(resolve => { finish = resolve; });
  }, 10);
  while (!polls) await new Promise(resolve => setTimeout(resolve, 5));
  const stopping = poller.stop();
  setTimeout(() => finish(0.8), 30);
  assert.equal(await stopping, 0.8);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(polls, 1, 'no poll starts after stop');
  const idle = startKvPoller(async () => 0.3, 10_000);
  assert.equal(await idle.stop(), null, 'no poll ran');
  const failing = startKvPoller(async () => { throw new Error('scrape failed'); }, 5);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(await failing.stop(), null);
});

test('summarizeRun: correct-and-cited is counted per read', () => {
  const summary = summarizeRun({
    reads: [{ ms: 1, correct: true, cited: false }, { ms: 1, correct: false, cited: true }, { ms: 1, correct: true, cited: true }],
    totalDelta: null, gpuSamplesMiB: null, kvPool: null, bytesPerToken: null,
  });
  assert.deepEqual(summary.accuracy, { correct: 2, cited: 2, correctAndCited: 1, total: 3 });
});

test('summarizeRun: no request TPOT histogram means no per-request decode figure', () => {
  const totalDelta = {
    reset: false,
    missing: ['vllm:request_time_per_output_token_seconds'],
    counters: { 'vllm:generation_tokens_total': 101 },
    histograms: {
      // Request 1: one interval of 0.01 s; request 2: 100 intervals of 0.1 s.
      'vllm:inter_token_latency_seconds': { buckets: [{ le: 0.01, count: 1 }, { le: 0.1, count: 101 }, { le: Infinity, count: 101 }], sum: 10.01, count: 101 },
      'vllm:request_time_per_output_token_seconds': null,
    },
  };
  const summary = summarizeRun({ reads: [{ ms: 1000 }], totalDelta, gpuSamplesMiB: null, kvPool: null, bytesPerToken: null });
  assert.equal(summary.tokensPerSecond.perRequestDecode, null);
  assert.ok(summary.missing.includes('vllm:request_time_per_output_token_seconds'));
});

test('delta treats a changed process start time as a restart', () => {
  const before = metricsSnap({ reads: 3, processStart: 1.7e9 });
  const after = metricsSnap({ reads: 9, processStart: 1.7e9 + 600 });
  assert.equal(before.processStart, 1.7e9);
  assert.equal(delta(before, after).reset, true, 'counters went up, but it is a new process');
  assert.equal(delta(before, metricsSnap({ reads: 9 })).reset, false);
  const noStart = structuredClone(before);
  noStart.processStart = null;
  assert.equal(delta(noStart, after).reset, false, 'unknown start time: counters decide');
});

test('speculative decoding counters are optional: read when exported, never listed as missing', () => {
  const l = `engine="0",model_name="${MODEL}"`;
  const spec = (drafts, tokens, accepted) => [
    `vllm:spec_decode_num_drafts_total{${l}} ${drafts}`,
    `vllm:spec_decode_num_draft_tokens_total{${l}} ${tokens}`,
    `vllm:spec_decode_num_accepted_tokens_total{${l}} ${accepted}`,
  ].join('\n');
  const before = snapshot(parsePrometheus(spec(10, 40, 12)), { model: MODEL });
  const after = snapshot(parsePrometheus(spec(110, 440, 172)), { model: MODEL });
  assert.equal(before.missing.some(name => name.includes('spec_decode')), false);
  const d = delta(before, after);
  assert.equal(d.counters['vllm:spec_decode_num_draft_tokens_total'], 400);
  assert.equal(d.counters['vllm:spec_decode_num_accepted_tokens_total'], 160);
  const reads = [{ ms: 1000, correct: true, cited: true, calls: [], ttftMean: null, kvUsagePeak: null }];
  const on = summarizeRun({ reads, totalDelta: d, gpuSamplesMiB: null, kvPool: null, bytesPerToken: null });
  assert.deepEqual(on.specDecode, { drafts: 100, draftTokens: 400, acceptedTokens: 160, acceptanceRate: 0.4 });
  const plain = snapshot(parsePrometheus(`vllm:generation_tokens_total{${l}} 5`), { model: MODEL });
  assert.equal(plain.counters['vllm:spec_decode_num_draft_tokens_total'], null);
  assert.equal(plain.missing.some(name => name.includes('spec_decode')), false);
  const off = summarizeRun({ reads, totalDelta: delta(plain, plain), gpuSamplesMiB: null, kvPool: null, bytesPerToken: null });
  assert.equal(off.specDecode, null, 'no speculative decoding, no specDecode block');
});

test('kvDtypeMismatch compares bytes per value with the server cache dtype', () => {
  assert.match(kvDtypeMismatch('auto', 'fp8'), /KV cache dtype fp8 but --kv-dtype is auto/u);
  assert.match(kvDtypeMismatch('fp8', 'auto'), /pass --kv-dtype auto/u);
  assert.equal(kvDtypeMismatch('fp8', 'fp8_e4m3'), null);
  assert.equal(kvDtypeMismatch('bfloat16', 'auto'), null);
  assert.equal(kvDtypeMismatch('auto', null), null, 'server does not say');
  assert.equal(kvDtypeMismatch('auto', 'something-new'), null, 'unknown server dtype cannot be checked');
});

test('perf.mjs end to end against a fake ledger and fake vLLM', async () => {
  const questions = JSON.parse(await readFile(new URL('../evals/latent/questions.json', import.meta.url), 'utf8'));
  const state = { reads: 0, calls: 0, requests: 0 };
  const seen = [];
  const vllm = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/metrics') {
      response.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
      response.end(fakeVllmMetrics(state));
      return;
    }
    response.writeHead(404).end();
  });
  let ledgerUrl;
  const ledger = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      if (request.method !== 'POST' || request.url !== '/api/latent/read') { response.writeHead(404).end(); return; }
      const parsed = JSON.parse(body);
      seen.push({ origin: request.headers.origin, body: parsed });
      state.requests += 1;
      const reply = (status, data) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data)); };
      if (state.requests === 3) { reply(500, { error: 'synthetic failure' }); return; }
      const question = questions.questions.find(entry => entry.question === parsed.question);
      const answer = question.required.map(group => group[0]).join(', ');
      const [{ path, lines: [startLine, endLine] }] = question.evidence;
      const send = () => {
        state.busy = false;
        state.reads += 1;
        state.calls += 3;
        reply(200, {
          mode: 'latent',
          graph: { answer, findings: [{ label: answer, evidence: [{ path, startLine, endLine }], quoteVerified: true }], rejectedFindings: 0, badQuotes: 0 },
          receipt: { calls: [1, 2, 3].map(index => ({ role: index === 3 ? 'reducer' : 'worker', promptTokens: 100, cachedTokens: 80, completionTokens: 20, ms: 40 })) },
          stats: { prefixTokens: 1000, sliceTokensEstimate: 50, cachedShare: 0.8 },
        });
      };
      // Read 2 runs for 700 ms with the KV gauge at 0.5; only the poller can see that.
      if (state.requests === 2) {
        state.busy = true;
        setTimeout(send, 700);
        return;
      }
      send();
    });
  });
  const vllmUrl = await listen(vllm);
  ledgerUrl = await listen(ledger);
  const dir = await mkdtemp(join(tmpdir(), 'ledger-perf-'));
  try {
    const out = join(dir, 'report.json');
    const hfConfig = join(dir, 'config.json');
    await writeFile(hfConfig, JSON.stringify(QWEN7B));
    const script = fileURLToPath(new URL('../evals/latent/perf.mjs', import.meta.url));
    const { stdout } = await execute(process.execPath, [script, '--repeat', '1', '--label', 'fake', '--out', out,
      '--vllm', vllmUrl, '--hf-config', hfConfig, '--nvidia-smi', 'nvidia-smi-not-installed-c11'],
    { env: { ...process.env, LEDGER: ledgerUrl }, timeout: 60_000 });
    assert.match(stdout, /FAILED/u);
    assert.match(stdout, /accuracy 7\/8 correct/u);

    assert.equal(seen.length, 8);
    assert.equal(seen[0].origin, ledgerUrl);
    assert.deepEqual(seen[0].body, { paths: questions.paths, question: questions.questions[0].question, budgetTokens: 400, workers: 3 });

    const report = JSON.parse(await readFile(out, 'utf8'));
    assert.equal(report.label, 'fake');
    assert.equal(report.model, MODEL);
    assert.ok(!Number.isNaN(Date.parse(report.date)));
    assert.equal(report.reads.length, 8);
    const failed = report.reads[2];
    assert.equal(failed.correct, false);
    assert.equal(failed.cited, false);
    assert.match(failed.error, /HTTP 500/u);
    assert.equal(failed.ttftMean, null, 'nothing reached vLLM for the failed read');
    assert.equal(failed.vllmCalls, 0);
    const first = report.reads[0];
    assert.equal(first.correct, true);
    assert.equal(first.cited, true);
    assert.equal(first.calls.length, 3);
    assert.equal(first.tokens, 360);
    close(first.ttftMean, 0.05);
    close(first.hitRate, 0.8);
    assert.equal(first.generatedTokens, 60);
    close(first.receiptCachedShare, 0.8);
    assert.equal(first.kvUsagePeak, 0.01);
    assert.equal(report.reads[1].kvUsagePeak, 0.5, 'the poller saw the gauge during the slow read');

    const { summary } = report;
    assert.deepEqual(summary.accuracy, { correct: 7, cited: 7, correctAndCited: 7, total: 8 });
    assert.equal(summary.vllmCalls, 21);
    close(summary.ttft.mean, 0.05);
    close(summary.ttft.p50, 0.055, 'bucket estimate inside (0.01, 0.1]');
    close(summary.ttft.p90, 0.091);
    close(summary.prefixCache.hitRate, 0.8);
    close(summary.prefixCache.receiptCachedShare, 0.8);
    close(summary.tokensPerSecond.perRequestDecode, 50);
    const readSeconds = report.reads.reduce((total, read) => total + read.ms, 0) / 1000;
    close(summary.tokensPerSecond.aggregate, 420 / readSeconds, '420 generated tokens over the summed read time');
    assert.deepEqual(summary.metricsCoverage, { reads: 8, total: 8 });
    assert.equal(summary.serverReset, false);
    assert.equal(summary.latency.failedReads, 1);
    assert.equal(summary.latency.reads, 7);
    assert.equal(summary.memory.gpuUsedMiB, null);
    assert.deepEqual(summary.memory.kvPool, { blockSize: 16, numGpuBlocks: 8571, tokens: 137136, cacheDtype: 'auto' });
    assert.equal(summary.memory.kvBytesPerToken, 57344);
    close(summary.memory.kvMiBPerRead.mean, 19.6875, '360 tokens x 57344 B');
    assert.equal(summary.memory.peakKvUsage, 0.5);
    assert.ok(summary.latency.readMs.p50 >= 0);
    assert.deepEqual(summary.missing, ['gpuMemory']);
    assert.equal(report.totalDelta.counters['vllm:generation_tokens_total'], 420);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await new Promise(resolve => vllm.close(resolve));
    await new Promise(resolve => ledger.close(resolve));
  }
});

// Runs perf.mjs against a fake /metrics that it should refuse before any ledger call.
async function perfRefuses(metricsText, args = []) {
  const ledgerRequests = [];
  const vllm = createServer((request, response) => {
    if (request.url === '/metrics') { response.writeHead(200, { 'Content-Type': 'text/plain' }); response.end(metricsText); return; }
    response.writeHead(404).end();
  });
  const ledger = createServer((request, response) => { ledgerRequests.push(request.url); response.writeHead(500).end(); });
  const vllmUrl = await listen(vllm);
  const ledgerUrl = await listen(ledger);
  try {
    const script = fileURLToPath(new URL('../evals/latent/perf.mjs', import.meta.url));
    let failure = null;
    try {
      await execute(process.execPath, [script, '--repeat', '1', '--vllm', vllmUrl, '--nvidia-smi', 'nvidia-smi-not-installed-c11', ...args],
        { env: { ...process.env, LEDGER: ledgerUrl }, timeout: 30_000 });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure, 'perf.mjs should exit with an error');
    assert.notEqual(failure.code, 0);
    return { stderr: String(failure.stderr), ledgerRequests };
  } finally {
    await new Promise(resolve => vllm.close(resolve));
    await new Promise(resolve => ledger.close(resolve));
  }
}

test('perf.mjs refuses /metrics with several models unless --model is given', async () => {
  const text = exposition({ queries: 1000, hits: 600, prompt: 1000, cached: 600, gen: 100, stop: 4, length: 1, ttft: [3, 5, 5, 1.2], other: true });
  const { stderr, ledgerRequests } = await perfRefuses(text);
  assert.match(stderr, /several models \(.*other\/model.*\); pass --model/u);
  assert.equal(ledgerRequests.length, 0);
});

test('perf.mjs refuses a --kv-dtype that does not match the server KV cache dtype', async () => {
  const { stderr, ledgerRequests } = await perfRefuses(fakeVllmMetrics({ reads: 0, calls: 0, cacheDtype: 'fp8' }));
  assert.match(stderr, /KV cache dtype fp8 but --kv-dtype is auto/u);
  assert.equal(ledgerRequests.length, 0);
});
