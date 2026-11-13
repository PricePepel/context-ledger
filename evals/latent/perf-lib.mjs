// Helpers for the latent runtime performance harness (card C11, docs/evals.md
// "Cycle 11"). No direct I/O: perf.mjs fetches vLLM's Prometheus /metrics and
// nvidia-smi samples and hands the text and numbers to these functions, and the
// measurement loop (measureReads) and KV poller (startKvPoller) take their I/O as
// functions so tests can script failed scrapes and server restarts.

export const COUNTERS = [
  'vllm:prefix_cache_queries_total',
  'vllm:prefix_cache_hits_total',
  'vllm:prompt_tokens_total',
  'vllm:prompt_tokens_cached_total',
  'vllm:generation_tokens_total',
  'vllm:request_success_total',
  'vllm:num_preemptions_total',
];

// Exported only when speculative decoding is on, so their absence is not "missing".
export const OPTIONAL_COUNTERS = [
  'vllm:spec_decode_num_drafts_total',
  'vllm:spec_decode_num_draft_tokens_total',
  'vllm:spec_decode_num_accepted_tokens_total',
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

const PROCESS_START = 'process_start_time_seconds';

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
  for (const name of OPTIONAL_COUNTERS) {
    const entries = byName.get(name);
    counters[name] = entries ? sum(entries.map(entry => entry.value)) : null;
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
  // Used only to detect a restart; not every vLLM build exports it, so it is not listed in `missing`.
  const started = byName.get(PROCESS_START)?.[0]?.value;
  const processStart = Number.isFinite(started) ? started : null;
  return { models, counters, histograms, gauges, kvPool, processStart, missing };
}

// after - before for counters and histograms. A counter, histogram count, sum or
// bucket that went down, or a changed process start time, means the server
// restarted between the scrapes, so the delta is { reset: true } rather than
// negative (or silently too small) numbers.
export function delta(before, after) {
  const missing = [...new Set([...before.missing, ...after.missing])];
  if (Number.isFinite(before.processStart) && Number.isFinite(after.processStart) && before.processStart !== after.processStart) {
    return { reset: true, missing };
  }
  const counters = {};
  for (const name of [...COUNTERS, ...OPTIONAL_COUNTERS]) {
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

// Bytes per stored KV value for a vLLM --kv-cache-dtype; undefined when unknown.
export function kvBytesPerValue(kvDtype) {
  const dtype = String(kvDtype).toLowerCase();
  return KV_BYTES[dtype] ?? (dtype.startsWith('fp8') ? 1 : undefined);
}

// Compares perf.mjs --kv-dtype with the cache_dtype vLLM reports in
// vllm:cache_config_info. Returns an error message when they store a different
// number of bytes per value, null when they agree or the server value is unknown.
export function kvDtypeMismatch(flag, serverDtype) {
  if (serverDtype === null || serverDtype === undefined || serverDtype === '') return null;
  const server = kvBytesPerValue(serverDtype);
  if (server === undefined || server === kvBytesPerValue(flag)) return null;
  return `vLLM reports KV cache dtype ${serverDtype} but --kv-dtype is ${flag}; pass --kv-dtype ${serverDtype} so KV bytes per token match the server.`;
}

// --repeat must be a finite positive integer: Infinity never ends and a fraction
// would run a different number of rounds than the report states.
export function parseRepeat(value) {
  const text = String(value ?? '').trim();
  if (!/^[1-9][0-9]*$/u.test(text)) throw new Error(`--repeat must be a positive whole number, got ${JSON.stringify(value)}.`);
  return Number(text);
}

// The model whose series the report reads. An explicit --model must be one that
// /metrics names, or every model-labelled metric would be filtered away while the
// ledger still runs its own model.
export function chooseModel(models, requested) {
  if (requested !== undefined && requested !== null && requested !== '') {
    if (!models.includes(requested)) {
      throw new Error(`--model ${requested} is not served by this vLLM (/metrics names ${models.length ? models.join(', ') : 'no model'}).`);
    }
    return requested;
  }
  if (models.length === 1) return models[0];
  throw new Error(`/metrics names ${models.length ? `several models (${models.join(', ')}); pass --model` : 'no model'}.`);
}

// nvidia-smi arguments for one GPU, so a multi-GPU machine does not mix devices
// into one series of samples. The index is nvidia-smi's own (--id).
export function nvidiaSmiArgs(gpu) {
  const text = String(gpu ?? '').trim();
  if (!/^[0-9]+$/u.test(text)) throw new Error(`--gpu must be a GPU index such as 0, got ${JSON.stringify(gpu)}.`);
  return [`--id=${text}`, '--query-gpu=memory.used', '--format=csv,noheader,nounits', '-lms', '200'];
}

// KV-cache bytes per token: layers x KV heads x head dim x 2 (K and V) x bytes per
// value. 'auto' takes the model's 16-bit dtype; every fp8 variant is 1 byte.
export function kvBytesPerToken(hfConfig, kvDtype = 'auto') {
  const config = hfConfig?.num_hidden_layers === undefined && hfConfig?.text_config ? hfConfig.text_config : hfConfig;
  const bytes = kvBytesPerValue(kvDtype);
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

// The report summary. `reads` are measureReads read records: { ms, correct, cited,
// error?, calls, ttftMean, kvUsagePeak, delta }. `totalDelta` is the whole-run delta
// and covers the first `coveredReads` reads (all of them unless the last /metrics
// scrapes failed); aggregate tokens/s divides its generated tokens by the summed time
// of those same reads. `restarted` is measureReads' scrape-to-scrape restart flag;
// a reset in any read's own delta also counts, and either makes the whole-run vLLM
// figures null. `gpuSamplesMiB` are the nvidia-smi samples (null when it was missing).
// Latency and cold/steady figures use only reads that finished without an error.
export function summarizeRun({ reads, totalDelta, coveredReads = reads.length, restarted = false, gpuSamplesMiB, kvPool, bytesPerToken }) {
  const serverReset = Boolean(totalDelta?.reset || restarted || reads.some(read => read.delta?.reset));
  const usable = totalDelta && !serverReset ? totalDelta : null;
  const histogram = name => usable?.histograms[name] ?? null;
  const counter = name => usable?.counters[name] ?? null;
  const ttft = histogram('vllm:time_to_first_token_seconds');
  // Request TPOT only: the inter-token histogram has one observation per token
  // interval, not per request, so it is not a stand-in for it.
  const tpotMean = histogramMean(histogram('vllm:request_time_per_output_token_seconds'));
  const generated = counter('vllm:generation_tokens_total');
  const covered = Math.max(0, Math.min(reads.length, coveredReads));
  const coveredMs = sum(reads.slice(0, covered).map(read => (Number.isFinite(read.ms) ? read.ms : 0)));
  const calls = reads.flatMap(read => read.calls ?? []);
  const promptTotal = sum(calls.map(call => call.promptTokens ?? 0));
  const cachedTotal = sum(calls.map(call => call.cachedTokens ?? 0));
  const withCalls = reads.filter(read => (read.calls ?? []).length > 0);
  const kvMiB = bytesPerToken ? withCalls.map(read => (readTokens(read) * bytesPerToken) / MIB) : [];
  const gpu = Array.isArray(gpuSamplesMiB) && gpuSamplesMiB.length ? gpuSamplesMiB : null;
  const kvPeaks = reads.map(read => read.kvUsagePeak).filter(Number.isFinite);
  const finished = read => !read.error;
  const readMs = reads.filter(finished).map(read => read.ms);
  const first = reads[0];
  const rest = reads.slice(1).filter(finished);
  const restTtft = rest.map(read => read.ttftMean).filter(Number.isFinite);
  const missing = [...(totalDelta?.missing ?? [])];
  const missingReasons = Object.fromEntries(missing.map(name => [name, 'vLLM did not export this metric.']));
  for (const [name, absent] of [['gpuMemory', !gpu], ['kvBytesPerToken', !bytesPerToken]]) {
    if (absent) { missing.push(name); missingReasons[name] = MISSING_REASONS[name]; }
  }
  if (covered < reads.length) {
    missing.push('wholeRunMetrics');
    missingReasons.wholeRunMetrics = `The last /metrics scrapes failed, so whole-run vLLM figures cover only the first ${covered} of ${reads.length} reads.`;
  }
  return {
    serverReset,
    metricsCoverage: { reads: covered, total: reads.length },
    vllmCalls: ttft ? ttft.count : null,
    ttft: ttft ? { mean: histogramMean(ttft), p50: histogramQuantile(ttft.buckets, 0.5), p90: histogramQuantile(ttft.buckets, 0.9) } : null,
    prefixCache: {
      hitRate: ratio(counter('vllm:prefix_cache_hits_total'), counter('vllm:prefix_cache_queries_total')),
      receiptCachedShare: ratio(cachedTotal, promptTotal),
    },
    tokensPerSecond: {
      perRequestDecode: tpotMean ? 1 / tpotMean : null,
      aggregate: generated !== null && coveredMs > 0 ? generated / (coveredMs / 1000) : null,
    },
    // Null when speculative decoding is off (vLLM then exports no spec_decode counters).
    specDecode: counter('vllm:spec_decode_num_draft_tokens_total') === null ? null : {
      drafts: counter('vllm:spec_decode_num_drafts_total'),
      draftTokens: counter('vllm:spec_decode_num_draft_tokens_total'),
      acceptedTokens: counter('vllm:spec_decode_num_accepted_tokens_total'),
      acceptanceRate: ratio(counter('vllm:spec_decode_num_accepted_tokens_total'), counter('vllm:spec_decode_num_draft_tokens_total')),
    },
    memory: {
      gpuUsedMiB: gpu ? { idle: gpu[0], peak: Math.max(...gpu) } : null,
      kvPool: kvPool ?? null,
      peakKvUsage: kvPeaks.length ? Math.max(...kvPeaks) : null,
      kvBytesPerToken: bytesPerToken ?? null,
      kvMiBPerRead: kvMiB.length ? { mean: mean(kvMiB), max: Math.max(...kvMiB) } : null,
      kvMiBPerReadBasis: 'Upper bound: prompt plus completion tokens summed over every call of a read, so prefix blocks shared between calls are counted once per call.',
    },
    latency: {
      readMs: { p50: percentile(readMs, 50), p90: percentile(readMs, 90), mean: mean(readMs.filter(Number.isFinite)) },
      reads: readMs.length,
      failedReads: reads.length - readMs.length,
    },
    accuracy: {
      correct: reads.filter(read => read.correct).length,
      cited: reads.filter(read => read.cited).length,
      correctAndCited: reads.filter(read => read.correct && read.cited).length,
      total: reads.length,
    },
    cold: first ? {
      failed: !finished(first),
      readMs: finished(first) ? first.ms : null,
      ttft: finished(first) ? first.ttftMean ?? null : null,
      steadyReadMs: rest.length ? mean(rest.map(read => read.ms)) : null,
      steadyTtft: restTtft.length ? mean(restTtft) : null,
    } : null,
    missing,
    missingReasons,
  };
}

// ------------------------------------------------------------------ measurement

export const KV_POLL_MS = 200;

// Polls sample() (an async function resolving to the KV-cache usage gauge, or null)
// every intervalMs while a read runs; the gauge is near zero between reads. stop()
// clears the timer and waits for a poll still in flight, so its sample is counted,
// then resolves to the peak (null when no poll returned a number).
export function startKvPoller(sample, intervalMs = KV_POLL_MS) {
  let peak = null;
  let inFlight = null;
  const poll = async () => {
    try {
      const usage = await sample();
      if (Number.isFinite(usage)) peak = peak === null ? usage : Math.max(peak, usage);
    } catch {
      // A failed poll only loses that sample.
    }
  };
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = poll().finally(() => { inFlight = null; });
  }, intervalMs);
  return {
    async stop() {
      clearInterval(timer);
      if (inFlight) await inFlight;
      return peak;
    },
  };
}

export const maxOf = (...items) => {
  const finite = items.filter(Number.isFinite);
  return finite.length ? Math.max(...finite) : null;
};

const noPoller = () => ({ stop: async () => null });

// The perf.mjs measurement loop with its I/O passed in. `start` is the first good
// snapshot. ask(question) resolves to the ledger reply or throws; take() resolves to
// a snapshot, or null when the scrape failed; grade(question, graph) returns
// { id, correct, cited }; poll() starts a KV poller (startKvPoller) for one read.
//
// Scrape bookkeeping:
// - A read's delta needs a good scrape on each side. After a failed scrape the next
//   read takes a fresh baseline before it starts, so one failure costs one delta.
// - Every good scrape is compared with the previous good one, so a restart anywhere
//   in the run sets `restarted`, even when the counters later climb past where
//   they were.
// - `end` is the last good scrape and `covered` the number of reads it covers. When
//   the scrape after the last read fails, one more scrape is tried after the loop.
export async function measureReads({ questions, repeat = 1, start, ask, take, grade, poll = noPoller, now = Date.now, log = () => {} }) {
  const reads = [];
  let restarted = false;
  let lastGood = start;
  let end = start;
  let covered = 0;
  const good = snap => {
    if (!snap) return;
    if (lastGood && delta(lastGood, snap).reset) restarted = true;
    lastGood = snap;
    end = snap;
    covered = reads.length;
  };
  let before = start;
  for (let round = 1; round <= repeat; round += 1) {
    for (const question of questions) {
      if (!before) {
        before = await take();
        good(before);
      }
      const poller = poll();
      const started = now();
      let data = null;
      let error = null;
      try {
        data = await ask(question);
      } catch (failure) {
        error = String(failure?.message ?? failure);
      }
      const ms = now() - started;
      const pollPeak = await poller.stop();
      const after = await take();
      const readDelta = before && after ? delta(before, after) : null;
      const graded = data ? grade(question, data.graph) : { id: question.id, correct: false, cited: false };
      const calls = (data?.receipt?.calls ?? []).map(call => ({
        role: call.role ?? null, promptTokens: call.promptTokens ?? 0, cachedTokens: call.cachedTokens ?? 0,
        completionTokens: call.completionTokens ?? 0, ms: call.ms ?? null,
      }));
      const promptTokens = sum(calls.map(call => call.promptTokens));
      const read = {
        round, ...graded, ...(error ? { error } : {}), ms, calls,
        tokens: readTokens({ calls }),
        receiptCachedShare: promptTokens > 0 ? sum(calls.map(call => call.cachedTokens)) / promptTokens : null,
        ...readStats(readDelta),
        kvUsagePeak: maxOf(pollPeak, after?.gauges['vllm:kv_cache_usage_perc']),
        answer: data?.graph?.answer ?? '',
        delta: readDelta,
      };
      reads.push(read);
      good(after);
      before = after;
      const ttft = read.ttftMean === null ? 'n/a' : `${(read.ttftMean * 1000).toFixed(0)}ms`;
      log(error
        ? `round ${round} ${question.id}: FAILED ${error}`
        : `round ${round} ${question.id}: correct=${graded.correct} cited=${graded.cited} ${ms}ms ttft=${ttft} hit=${read.hitRate?.toFixed(3) ?? 'n/a'} gen=${read.generatedTokens ?? 'n/a'}`);
    }
  }
  if (covered < reads.length) good(await take());
  return { reads, end, covered, restarted };
}
