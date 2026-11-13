// Pure helpers for the latent runtime performance harness (card C11, docs/evals.md
// "Cycle 11"). No I/O: perf.mjs fetches vLLM's Prometheus /metrics and nvidia-smi
// samples and hands the text and numbers to these functions.

export const COUNTERS = [
  'vllm:prefix_cache_queries_total',
  'vllm:prefix_cache_hits_total',
  'vllm:prompt_tokens_total',
  'vllm:prompt_tokens_cached_total',
  'vllm:generation_tokens_total',
  'vllm:request_success_total',
  'vllm:num_preemptions_total',
];

export const HISTOGRAMS = [
  'vllm:time_to_first_token_seconds',
  'vllm:inter_token_latency_seconds',
  'vllm:request_time_per_output_token_seconds',
  'vllm:e2e_request_latency_seconds',
  'vllm:request_prefill_time_seconds',
  'vllm:request_decode_time_seconds',
  'vllm:request_queue_time_seconds',
  'vllm:request_prompt_tokens',
  'vllm:request_generation_tokens',
];

export const GAUGES = ['vllm:kv_cache_usage_perc', 'vllm:num_requests_running'];

export const CACHE_CONFIG = 'vllm:cache_config_info';

const MIB = 1024 * 1024;

// ------------------------------------------------------------------ parsing

function parseValue(token) {
  if (token === undefined || token === '') return NaN;
  const lower = token.toLowerCase();
  if (lower === 'nan') return NaN;
  if (lower === '+inf' || lower === 'inf') return Infinity;
  if (lower === '-inf') return -Infinity;
  return Number(token);
}

// Reads `{key="value",...}` starting at text[start] === '{'. Returns the labels and
// the index after the closing brace. Values unescape \\, \" and \n as in the
// Prometheus text exposition format.
function parseLabels(text, start) {
  const labels = {};
  let index = start + 1;
  const skipSpace = () => { while (text[index] === ' ' || text[index] === '\t') index += 1; };
  for (;;) {
    skipSpace();
    if (text[index] === '}') return { labels, end: index + 1 };
    if (text[index] === ',') { index += 1; continue; }
    const keyStart = index;
    while (index < text.length && text[index] !== '=' && text[index] !== '}' && text[index] !== ',') index += 1;
    const key = text.slice(keyStart, index).trim();
    if (text[index] !== '=') throw new Error(`Bad label set near "${text.slice(keyStart, keyStart + 20)}".`);
    index += 1;
    skipSpace();
    if (text[index] !== '"') throw new Error(`Label ${key} has no quoted value.`);
    index += 1;
    let value = '';
    for (;;) {
      if (index >= text.length) throw new Error(`Label ${key} has an unterminated value.`);
      const char = text[index];
      if (char === '\\') {
        const next = text[index + 1];
        value += next === 'n' ? '\n' : next;
        index += 2;
        continue;
      }
      if (char === '"') { index += 1; break; }
      value += char;
      index += 1;
    }
    labels[key] = value;
  }
}

// Prometheus text format to [{ name, labels, value }]. Comment (# HELP, # TYPE) and
// blank lines are skipped; an optional trailing timestamp is ignored.
export function parsePrometheus(text) {
  const series = [];
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/\r$/u, '').trim();
    if (!line || line.startsWith('#')) continue;
    let index = 0;
    while (index < line.length && line[index] !== '{' && line[index] !== ' ' && line[index] !== '\t') index += 1;
    const name = line.slice(0, index);
    let labels = {};
    if (line[index] === '{') {
      const parsed = parseLabels(line, index);
      labels = parsed.labels;
      index = parsed.end;
    }
    const [valueToken] = line.slice(index).trim().split(/\s+/u);
    series.push({ name, labels, value: parseValue(valueToken) });
  }
  return series;
}

// ------------------------------------------------------------------ snapshots

const sum = values => values.reduce((total, value) => total + value, 0);
const mean = values => (values.length ? sum(values) / values.length : null);

// One /metrics scrape reduced to the series the harness reports. Values are summed
// across label sets (finished_reason, engine). With `model`, series whose model_name
// label names another model are dropped; series without a model_name label are kept.
// A metric with no series is null and its name is listed in `missing`.
export function snapshot(series, { model } = {}) {
  const kept = series.filter(entry => !entry.name.endsWith('_created')
    && (model === undefined || model === null || entry.labels.model_name === undefined || entry.labels.model_name === model));
  const byName = new Map();
  for (const entry of kept) {
    if (!byName.has(entry.name)) byName.set(entry.name, []);
    byName.get(entry.name).push(entry);
  }
  const missing = [];
  const counters = {};
  for (const name of COUNTERS) {
    const entries = byName.get(name);
    counters[name] = entries ? sum(entries.map(entry => entry.value)) : null;
    if (!entries) missing.push(name);
  }
  const histograms = {};
  for (const name of HISTOGRAMS) {
    const buckets = byName.get(`${name}_bucket`);
    const sums = byName.get(`${name}_sum`);
    const counts = byName.get(`${name}_count`);
    if (!buckets || !counts) {
      histograms[name] = null;
      missing.push(name);
      continue;
    }
    const byLe = new Map();
    for (const entry of buckets) {
      const le = parseValue(entry.labels.le);
      byLe.set(le, (byLe.get(le) ?? 0) + entry.value);
    }
    histograms[name] = {
      buckets: [...byLe].map(([le, count]) => ({ le, count })).sort((a, b) => a.le - b.le),
      sum: sums ? sum(sums.map(entry => entry.value)) : null,
      count: sum(counts.map(entry => entry.value)),
    };
  }
  const gauges = {};
  for (const name of GAUGES) {
    // One engine is expected; the sum keeps the rule "summed across label sets".
    const entries = byName.get(name);
    gauges[name] = entries ? sum(entries.map(entry => entry.value)) : null;
    if (!entries) missing.push(name);
  }
  let kvPool = null;
  const config = byName.get(CACHE_CONFIG)?.[0];
  if (config) {
    const blockSize = Number(config.labels.block_size);
    const numGpuBlocks = Number(config.labels.num_gpu_blocks);
    if (Number.isFinite(blockSize) && Number.isFinite(numGpuBlocks) && config.labels.block_size && config.labels.num_gpu_blocks) {
      kvPool = { blockSize, numGpuBlocks, tokens: blockSize * numGpuBlocks, cacheDtype: config.labels.cache_dtype ?? null };
    }
  }
  if (!kvPool) missing.push(CACHE_CONFIG);
  const models = [...new Set(kept.map(entry => entry.labels.model_name).filter(name => name !== undefined))];
  return { models, counters, histograms, gauges, kvPool, missing };
}

// after - before for counters and histograms. A counter, histogram count, sum or
// bucket that went down means the server restarted between the scrapes, so the
// delta is { reset: true } rather than negative numbers.
export function delta(before, after) {
  const missing = [...new Set([...before.missing, ...after.missing])];
  const counters = {};
  for (const name of COUNTERS) {
    const a = before.counters[name];
    const b = after.counters[name];
    if (a === null || b === null || a === undefined || b === undefined) { counters[name] = null; continue; }
    if (b < a) return { reset: true, missing };
    counters[name] = b - a;
  }
  const histograms = {};
  for (const name of HISTOGRAMS) {
    const a = before.histograms[name];
    const b = after.histograms[name];
    if (!a || !b) { histograms[name] = null; continue; }
    if (b.count < a.count || (a.sum !== null && b.sum !== null && b.sum < a.sum)) return { reset: true, missing };
    const earlier = new Map(a.buckets.map(bucket => [bucket.le, bucket.count]));
    const buckets = [];
    for (const bucket of b.buckets) {
      const diff = bucket.count - (earlier.get(bucket.le) ?? 0);
      if (diff < 0) return { reset: true, missing };
      buckets.push({ le: bucket.le, count: diff });
    }
    histograms[name] = { buckets, sum: a.sum === null || b.sum === null ? null : b.sum - a.sum, count: b.count - a.count };
  }
  return { reset: false, counters, histograms, missing };
}

// ------------------------------------------------------------------ statistics

// Prometheus histogram_quantile: linear interpolation inside the bucket that holds
// rank q * total, with 0 as the lower bound of the first bucket. A quantile in the
// +Inf bucket returns the largest finite bound. Null for an empty histogram (no
// observations or no finite bucket) and for q outside [0, 1].
export function histogramQuantile(buckets, q) {
  if (!Array.isArray(buckets) || !(q >= 0 && q <= 1)) return null;
  const sorted = [...buckets].sort((a, b) => a.le - b.le);
  const finite = sorted.filter(bucket => Number.isFinite(bucket.le));
  if (!finite.length) return null;
  const total = sorted.at(-1).count;
  if (!(total > 0)) return null;
  const rank = q * total;
  const index = finite.findIndex(bucket => bucket.count >= rank);
  if (index === -1) return finite.at(-1).le;
  if (index === 0 && finite[0].le <= 0) return finite[0].le;
  const start = index > 0 ? finite[index - 1].le : 0;
  const below = index > 0 ? finite[index - 1].count : 0;
  const inBucket = finite[index].count - below;
  if (inBucket <= 0) return start;
  return start + (finite[index].le - start) * ((rank - below) / inBucket);
}

// Percentile of raw samples by linear interpolation between closest ranks (the
// numpy "linear" default): position (p / 100) * (n - 1) in the sorted samples.
// p is 0..100. Non-finite samples are ignored; null when none remain.
export function percentile(values, p) {
  const sorted = (values ?? []).filter(value => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length || !(p >= 0 && p <= 100)) return null;
  const position = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

const KV_BYTES = { auto: 2, bfloat16: 2, float16: 2 };

// KV-cache bytes per token: layers x KV heads x head dim x 2 (K and V) x bytes per
// value. 'auto' takes the model's 16-bit dtype; every fp8 variant is 1 byte.
export function kvBytesPerToken(hfConfig, kvDtype = 'auto') {
  const config = hfConfig?.num_hidden_layers === undefined && hfConfig?.text_config ? hfConfig.text_config : hfConfig;
  const dtype = String(kvDtype).toLowerCase();
  const bytes = KV_BYTES[dtype] ?? (dtype.startsWith('fp8') ? 1 : undefined);
  if (bytes === undefined) throw new Error(`Unknown KV-cache dtype "${kvDtype}" (use auto, bfloat16, float16 or an fp8 variant).`);
  const layers = config?.num_hidden_layers;
  const heads = config?.num_attention_heads;
  const kvHeads = config?.num_key_value_heads ?? heads;
  const headDim = config?.head_dim ?? (config?.hidden_size && heads ? config.hidden_size / heads : undefined);
  for (const [field, value] of [['num_hidden_layers', layers], ['num_key_value_heads', kvHeads], ['head_dim', headDim]]) {
    if (!(Number.isFinite(value) && value > 0)) throw new Error(`The model config has no usable ${field}.`);
  }
  return layers * kvHeads * headDim * 2 * bytes;
}

const histogramMean = histogram => (histogram && histogram.count > 0 && histogram.sum !== null ? histogram.sum / histogram.count : null);
const ratio = (top, bottom) => (Number.isFinite(top) && Number.isFinite(bottom) && bottom > 0 ? top / bottom : null);

// Per-read figures from one read's delta: TTFT mean over its vLLM calls, prefix-cache
// hit rate and generated tokens. All null when the delta is missing or reset.
export function readStats(readDelta) {
  if (!readDelta || readDelta.reset) return { ttftMean: null, vllmCalls: null, hitRate: null, generatedTokens: null };
  const ttft = readDelta.histograms['vllm:time_to_first_token_seconds'];
  return {
    ttftMean: histogramMean(ttft),
    vllmCalls: ttft ? ttft.count : null,
    hitRate: ratio(readDelta.counters['vllm:prefix_cache_hits_total'], readDelta.counters['vllm:prefix_cache_queries_total']),
    generatedTokens: readDelta.counters['vllm:generation_tokens_total'],
  };
}

// Tokens a read put through the KV cache: prompt plus completion over its calls.
export const readTokens = read => sum((read.calls ?? []).map(call => (call.promptTokens ?? 0) + (call.completionTokens ?? 0)));

const MISSING_REASONS = {
  gpuMemory: 'nvidia-smi was not available, so GPU memory was not sampled.',
  kvBytesPerToken: 'No --hf-config was given, so KV bytes per token (and KV MiB per read) are unknown.',
};

// The report summary. `reads` are perf.mjs read records: { ms, correct, cited, calls,
// ttftMean, kvUsagePeak }. `totalDelta` is the whole-run delta, `gpuSamplesMiB` the
// nvidia-smi samples (null when nvidia-smi was missing), `wallMs` the summed read time.
export function summarizeRun({ reads, totalDelta, gpuSamplesMiB, kvPool, bytesPerToken, wallMs }) {
  const usable = totalDelta && !totalDelta.reset ? totalDelta : null;
  const histogram = name => usable?.histograms[name] ?? null;
  const counter = name => usable?.counters[name] ?? null;
  const ttft = histogram('vllm:time_to_first_token_seconds');
  const tpot = histogram('vllm:request_time_per_output_token_seconds') ?? histogram('vllm:inter_token_latency_seconds');
  const tpotMean = histogramMean(tpot);
  const generated = counter('vllm:generation_tokens_total');
  const calls = reads.flatMap(read => read.calls ?? []);
  const promptTotal = sum(calls.map(call => call.promptTokens ?? 0));
  const cachedTotal = sum(calls.map(call => call.cachedTokens ?? 0));
  const withCalls = reads.filter(read => (read.calls ?? []).length > 0);
  const kvMiB = bytesPerToken ? withCalls.map(read => (readTokens(read) * bytesPerToken) / MIB) : [];
  const gpu = Array.isArray(gpuSamplesMiB) && gpuSamplesMiB.length ? gpuSamplesMiB : null;
  const kvPeaks = reads.map(read => read.kvUsagePeak).filter(Number.isFinite);
  const readMs = reads.map(read => read.ms);
  const rest = reads.slice(1);
  const restTtft = rest.map(read => read.ttftMean).filter(Number.isFinite);
  const missing = [...(totalDelta?.missing ?? [])];
  const missingReasons = Object.fromEntries(missing.map(name => [name, 'vLLM did not export this metric.']));
  for (const [name, absent] of [['gpuMemory', !gpu], ['kvBytesPerToken', !bytesPerToken]]) {
    if (absent) { missing.push(name); missingReasons[name] = MISSING_REASONS[name]; }
  }
  return {
    serverReset: Boolean(totalDelta?.reset),
    vllmCalls: ttft ? ttft.count : null,
    ttft: ttft ? { mean: histogramMean(ttft), p50: histogramQuantile(ttft.buckets, 0.5), p90: histogramQuantile(ttft.buckets, 0.9) } : null,
    prefixCache: {
      hitRate: ratio(counter('vllm:prefix_cache_hits_total'), counter('vllm:prefix_cache_queries_total')),
      receiptCachedShare: ratio(cachedTotal, promptTotal),
    },
    tokensPerSecond: {
      perRequestDecode: tpotMean ? 1 / tpotMean : null,
      aggregate: generated !== null && wallMs > 0 ? generated / (wallMs / 1000) : null,
    },
    memory: {
      gpuUsedMiB: gpu ? { idle: gpu[0], peak: Math.max(...gpu) } : null,
      kvPool: kvPool ?? null,
      peakKvUsage: kvPeaks.length ? Math.max(...kvPeaks) : null,
      kvBytesPerToken: bytesPerToken ?? null,
      kvMiBPerRead: kvMiB.length ? { mean: mean(kvMiB), max: Math.max(...kvMiB) } : null,
      kvMiBPerReadBasis: 'Upper bound: prompt plus completion tokens summed over every call of a read, so prefix blocks shared between calls are counted once per call.',
    },
    latency: { readMs: { p50: percentile(readMs, 50), p90: percentile(readMs, 90), mean: mean(readMs.filter(Number.isFinite)) } },
    accuracy: { correct: reads.filter(read => read.correct).length, cited: reads.filter(read => read.cited).length, total: reads.length },
    cold: reads.length ? {
      readMs: reads[0].ms,
      ttft: reads[0].ttftMean ?? null,
      steadyReadMs: rest.length ? mean(rest.map(read => read.ms)) : null,
      steadyTtft: restTtft.length ? mean(restTtft) : null,
    } : null,
    missing,
    missingReasons,
  };
}
