// Card L1: pure helpers for evals/latent/serving-levers.mjs. No network, no GPU.
import { parseMetrics } from '../../src/swarm.mjs';

const GIB = 1024 ** 3;

const number = text => Number(String(text).replaceAll(',', ''));

/**
 * What vLLM's startup log says about memory: weights, CUDA graphs, the KV pool and the
 * concurrency it claims. Every field is null when its line is absent, never a guess.
 * Sizes are GiB, from the log's own wording ("took 5.2 GiB", "Available KV cache memory:
 * 5.51 GiB", "GPU KV cache size: 137,136 tokens", "Maximum concurrency for 32,768
 * tokens per request: 4.18x").
 */
export function parseStartupLog(text) {
  const last = pattern => {
    const matches = [...String(text).matchAll(pattern)];
    return matches.length ? matches[matches.length - 1] : null;
  };
  const weights = last(/Model loading took ([0-9.]+) GiB/giu);
  const kv = last(/Available KV cache memory: ([0-9.]+) GiB/giu);
  const tokens = last(/(?:GPU )?KV cache size: ([0-9,]+) tokens/giu);
  const concurrency = last(/Maximum concurrency for ([0-9,]+) tokens per request: ([0-9.]+)x/giu);
  // vLLM captures graphs in more than one pass (for example 0.37 GiB and then 0.24 GiB); the memory is the sum.
  const graphs = [...String(text).matchAll(/Graph capturing finished in [0-9.]+ secs?, took ([0-9.]+) GiB/giu)];
  const loadSeconds = last(/Model loading took [0-9.]+ GiB[^\n]*? ([0-9.]+) seconds/giu);
  const ready = last(/init engine[^\n]*took ([0-9.]+) s/giu);
  return {
    weightsGiB: weights ? Number(weights[1]) : null,
    kvPoolGiB: kv ? Number(kv[1]) : null,
    kvTokens: tokens ? number(tokens[1]) : null,
    maxConcurrencyTokensPerRequest: concurrency ? number(concurrency[1]) : null,
    maxConcurrency: concurrency ? Number(concurrency[2]) : null,
    cudaGraphGiB: graphs.length ? Number(graphs.reduce((total, match) => total + Number(match[1]), 0).toFixed(2)) : null,
    loadSeconds: loadSeconds ? Number(loadSeconds[1]) : null,
    engineInitSeconds: ready ? Number(ready[1]) : null,
  };
}

/** Whole-number percentile (nearest rank) of a list, or null for an empty one. */
export function percentile(values, p) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

const FILLER_WORDS = ['gateway', 'ledger', 'queue', 'shard', 'replica', 'cache', 'rollout', 'alert', 'cluster', 'region',
  'backup', 'token', 'policy', 'router', 'worker', 'schema', 'index', 'volume', 'listener', 'balancer', 'metric', 'trace',
  'tenant', 'quota', 'canary', 'pager', 'runbook', 'handoff', 'window', 'budget'];

/** A deterministic filler paragraph of about `words` words (about one token each), different for each seed. */
export function fillerText(words, seed) {
  let state = (seed * 2654435761 + 12345) >>> 0;
  const out = [];
  for (let i = 0; i < words; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out.push(FILLER_WORDS[state % FILLER_WORDS.length]);
    if (i % 12 === 11) out.push('.');
  }
  return out.join(' ');
}

/**
 * The messages one agent sends. A per-run salt on the first line keeps a run from
 * reading the previous run's prefix out of the cache, so a run's hit rate is its own
 * sharing. `handbookWords` is shared by every agent of the run; `uniqueWords` is not.
 */
export function agentMessages({ system, report, salt, handbookWords = 0, uniqueWords = 0, index = 0 }) {
  const handbook = handbookWords > 0 ? `\n\nShared handbook (reference only, not part of the report):\n${fillerText(handbookWords, 7)}` : '';
  const unique = uniqueWords > 0 ? `Agent notes (ignore):\n${fillerText(uniqueWords, 1000 + index)}\n\n` : '';
  return [
    { role: 'system', content: `Run ${salt}.\n${system}${handbook}` },
    { role: 'user', content: `${unique}Report: ${report}` },
  ];
}

/** Counter and gauge values from two metric samples: change in the counters, the sample's gauges. */
export function metricsDelta(before, after) {
  const diff = name => (Number.isFinite(before?.[name]) && Number.isFinite(after?.[name]) ? Math.max(0, after[name] - before[name]) : null);
  const queries = diff('vllm:prefix_cache_queries_total');
  const hits = diff('vllm:prefix_cache_hits_total');
  return {
    prefixQueries: queries,
    prefixHits: hits,
    prefixHitRate: queries ? hits / queries : null,
    preemptions: diff('vllm:num_preemptions_total'),
    promptTokens: diff('vllm:prompt_tokens_total'),
    generationTokens: diff('vllm:generation_tokens_total'),
  };
}

export { parseMetrics };

/**
 * One run's report. `agents` are { ok, ms, correct, verified, promptTokens, completionTokens }
 * for each agent; `wallMs` is the time until the last agent returned.
 */
export function summarizeRun({ agents, wallMs, delta, kvPeak, gpuSamplesMiB }) {
  const ok = agents.filter(agent => agent.ok);
  const sum = key => ok.reduce((total, agent) => total + (agent[key] ?? 0), 0);
  const seconds = wallMs / 1000;
  const gpu = gpuSamplesMiB.filter(Number.isFinite);
  return {
    agents: agents.length,
    answered: ok.length,
    failed: agents.length - ok.length,
    correct: ok.filter(agent => agent.correct).length,
    verified: ok.filter(agent => agent.verified).length,
    wallSeconds: Number(seconds.toFixed(2)),
    agentSecondsP50: ok.length ? Number((percentile(ok.map(agent => agent.ms), 50) / 1000).toFixed(2)) : null,
    agentSecondsP90: ok.length ? Number((percentile(ok.map(agent => agent.ms), 90) / 1000).toFixed(2)) : null,
    promptTokens: sum('promptTokens'),
    completionTokens: sum('completionTokens'),
    completionTokensPerSecond: seconds > 0 ? Number((sum('completionTokens') / seconds).toFixed(1)) : null,
    promptTokensPerSecond: seconds > 0 ? Number((sum('promptTokens') / seconds).toFixed(0)) : null,
    prefixHitRate: delta.prefixHitRate === null ? null : Number(delta.prefixHitRate.toFixed(3)),
    preemptions: delta.preemptions,
    kvPeakShare: Number.isFinite(kvPeak) ? Number(kvPeak.toFixed(3)) : null,
    gpuPeakMiB: gpu.length ? Math.max(...gpu) : null,
    gpuMinMiB: gpu.length ? Math.min(...gpu) : null,
  };
}

/** KV bytes for `tokens` tokens of a model whose cache costs `bytesPerToken`, in GiB. */
export const kvGiB = (tokens, bytesPerToken) => (tokens * bytesPerToken) / GIB;

/** The environment `runtime/serve-vllm.sh` reads for one configuration of the levers. */
export function serveEnv(config = {}) {
  const env = {};
  if (config.model) env.LATENT_MODEL = config.model;
  if (config.gpuUtil !== undefined) env.VLLM_GPU_UTIL = String(config.gpuUtil);
  if (config.maxModelLen !== undefined) env.VLLM_MAX_MODEL_LEN = String(config.maxModelLen);
  if (config.maxNumSeqs !== undefined) env.VLLM_MAX_NUM_SEQS = String(config.maxNumSeqs);
  if (config.kvOffloadGiB !== undefined) env.VLLM_KV_OFFLOAD_GIB = String(config.kvOffloadGiB);
  if (config.kvDtype) env.VLLM_KV_DTYPE = config.kvDtype;
  return env;
}
