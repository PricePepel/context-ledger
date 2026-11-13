// Cycle 11 performance baseline: the dev questions through the ledger's /api/latent/read,
// graded, with vLLM's /metrics read before and after every read and GPU memory sampled.
// Usage: LEDGER=http://127.0.0.1:4317 node evals/latent/perf.mjs [--set questions|heldout|fresh]
//   [--repeat 3] [--label A] [--out report.json] [--vllm http://127.0.0.1:8000]
//   [--hf-config path/to/config.json] [--kv-dtype auto|bfloat16|float16|fp8...]
//   [--model <id>] [--nvidia-smi <command>]
// The ledger must run with LATENT_ROOT pointing at the set's fixture, as for run.mjs.
// --model is needed only when /metrics carries more than one model; --nvidia-smi
// replaces the sampler command (tests point it at a missing command).
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { gradeSlice } from './grade.mjs';
import { delta, kvBytesPerToken, parsePrometheus, readStats, readTokens, snapshot, summarizeRun } from './perf-lib.mjs';

const { values } = parseArgs({
  options: {
    set: { type: 'string', default: 'questions' },
    repeat: { type: 'string', default: '3' },
    label: { type: 'string', default: '' },
    out: { type: 'string' },
    vllm: { type: 'string', default: 'http://127.0.0.1:8000' },
    'hf-config': { type: 'string' },
    'kv-dtype': { type: 'string', default: 'auto' },
    model: { type: 'string' },
    'nvidia-smi': { type: 'string', default: 'nvidia-smi' },
  },
});
const sets = { questions: './questions.json', heldout: './heldout.json', fresh: './fresh.json' };
if (!sets[values.set]) throw new Error('--set must be questions, heldout or fresh.');
const ledger = process.env.LEDGER ?? 'http://127.0.0.1:4317';
const vllm = values.vllm.replace(/\/+$/u, '');
const set = JSON.parse(await readFile(new URL(sets[values.set], import.meta.url), 'utf8'));
const repeat = Math.max(1, Number(values.repeat) || 1);
const kvDtype = values['kv-dtype'];

let bytesPerToken = null;
if (values['hf-config']) bytesPerToken = kvBytesPerToken(JSON.parse(await readFile(values['hf-config'], 'utf8')), kvDtype);
else kvBytesPerToken({ num_hidden_layers: 1, num_attention_heads: 1, head_dim: 1 }, kvDtype); // validates --kv-dtype

async function ask(question) {
  const response = await fetch(`${ledger}/api/latent/read`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ledger },
    body: JSON.stringify({ paths: set.paths, question: question.question, budgetTokens: 400, workers: 3 }),
    signal: AbortSignal.timeout(300_000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${question.id}: HTTP ${response.status} ${data.error}`);
  if (data.mode !== 'latent') throw new Error(`${question.id}: runtime unavailable (${data.reason})`);
  return data;
}

async function scrape() {
  const response = await fetch(`${vllm}/metrics`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`vLLM /metrics: HTTP ${response.status}`);
  return parsePrometheus(await response.text());
}

// A failed scrape mid-run leaves that read's delta null instead of stopping the run.
async function take(model) {
  try {
    return snapshot(await scrape(), { model });
  } catch (error) {
    console.log(`metrics scrape failed: ${error.message}`);
    return null;
  }
}

// nvidia-smi prints one MiB figure per line every 200 ms. A missing command leaves
// the samples null. The child is always killed by stop().
function startGpuSampler(command) {
  const samples = [];
  let available = true;
  let child;
  let ready;
  const first = new Promise(resolve => { ready = resolve; });
  try {
    child = spawn(command, ['--query-gpu=memory.used', '--format=csv,noheader,nounits', '-lms', '200'],
      { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  } catch {
    available = false;
    ready();
  }
  if (child) {
    let pending = '';
    child.on('error', () => { available = false; ready(); });
    child.on('exit', () => ready());
    child.stdout.on('data', chunk => {
      pending += chunk.toString('utf8');
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) {
        const value = Number(line.trim());
        if (line.trim() && Number.isFinite(value)) samples.push(value);
      }
      if (samples.length) ready();
    });
  }
  const timer = setTimeout(() => ready(), 3000);
  return {
    first: first.then(() => clearTimeout(timer)),
    samples: () => (available && samples.length ? samples : null),
    stop() {
      clearTimeout(timer);
      // A command that never started has no process to kill (Windows throws EINVAL).
      if (!child || !available || child.pid === undefined || child.exitCode !== null || child.killed) return;
      try {
        child.kill();
      } catch {
        // Already gone.
      }
    },
  };
}

// Polls the KV-cache usage gauge while a read runs; the gauge is near zero between reads.
function startKvPoller(model) {
  let peak = null;
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    const current = await take(model).catch(() => null);
    const usage = current?.gauges['vllm:kv_cache_usage_perc'];
    if (Number.isFinite(usage)) peak = peak === null ? usage : Math.max(peak, usage);
    busy = false;
  }, 200);
  return { stop: () => { clearInterval(timer); return peak; } };
}

const maxOf = (...items) => {
  const finite = items.filter(Number.isFinite);
  return finite.length ? Math.max(...finite) : null;
};

const gpu = startGpuSampler(values['nvidia-smi']);
const stopGpu = () => gpu.stop();
process.once('SIGINT', () => { stopGpu(); process.exit(130); });
try {
  const firstSeries = await scrape();
  const models = snapshot(firstSeries).models;
  const model = values.model ?? (models.length === 1 ? models[0] : null);
  if (!model) throw new Error(`/metrics names ${models.length ? `several models (${models.join(', ')}); pass --model` : 'no model'}.`);
  await gpu.first;
  const start = snapshot(firstSeries, { model });
  const reads = [];
  let before = start;
  let end = start;
  for (let round = 1; round <= repeat; round += 1) {
    for (const question of set.questions) {
      const poller = startKvPoller(model);
      const started = Date.now();
      let data = null;
      let error = null;
      try {
        data = await ask(question);
      } catch (failure) {
        error = failure.message;
      }
      const ms = Date.now() - started;
      const pollPeak = poller.stop();
      const after = await take(model);
      const readDelta = before && after ? delta(before, after) : null;
      const grade = data ? gradeSlice(question, data.graph) : { id: question.id, correct: false, cited: false };
      const calls = (data?.receipt?.calls ?? []).map(call => ({
        role: call.role ?? null, promptTokens: call.promptTokens ?? 0, cachedTokens: call.cachedTokens ?? 0,
        completionTokens: call.completionTokens ?? 0, ms: call.ms ?? null,
      }));
      const promptTokens = calls.reduce((total, call) => total + call.promptTokens, 0);
      const read = {
        round, ...grade, ...(error ? { error } : {}), ms, calls,
        tokens: readTokens({ calls }),
        receiptCachedShare: promptTokens > 0 ? calls.reduce((total, call) => total + call.cachedTokens, 0) / promptTokens : null,
        ...readStats(readDelta),
        kvUsagePeak: maxOf(pollPeak, after?.gauges['vllm:kv_cache_usage_perc']),
        answer: data?.graph?.answer ?? '',
        delta: readDelta,
      };
      reads.push(read);
      before = after;
      if (after) end = after;
      const ttft = read.ttftMean === null ? 'n/a' : `${(read.ttftMean * 1000).toFixed(0)}ms`;
      console.log(error
        ? `round ${round} ${question.id}: FAILED ${error}`
        : `round ${round} ${question.id}: correct=${grade.correct} cited=${grade.cited} ${ms}ms ttft=${ttft} hit=${read.hitRate?.toFixed(3) ?? 'n/a'} gen=${read.generatedTokens ?? 'n/a'}`);
    }
  }
  const totalDelta = delta(start, end);
  const gpuSamplesMiB = gpu.samples();
  const wallMs = reads.reduce((total, read) => total + read.ms, 0);
  const summary = summarizeRun({ reads, totalDelta, gpuSamplesMiB, kvPool: end.kvPool ?? start.kvPool, bytesPerToken, wallMs });
  const fmt = (value, digits = 3) => (value === null || value === undefined ? 'n/a' : Number(value).toFixed(digits));
  console.log(`config ${values.label || '(no label)'} model ${model}: ${reads.length} reads`);
  console.log(`  accuracy ${summary.accuracy.correct}/${summary.accuracy.total} correct, ${summary.accuracy.cited}/${summary.accuracy.total} cited`);
  console.log(`  ttft mean ${fmt(summary.ttft?.mean)}s p50 ${fmt(summary.ttft?.p50)}s p90 ${fmt(summary.ttft?.p90)}s over ${summary.vllmCalls ?? 'n/a'} calls`);
  console.log(`  prefix cache hit ${fmt(summary.prefixCache.hitRate)} receipts cached ${fmt(summary.prefixCache.receiptCachedShare)}`);
  console.log(`  tokens/s decode ${fmt(summary.tokensPerSecond.perRequestDecode, 1)} aggregate ${fmt(summary.tokensPerSecond.aggregate, 1)}`);
  console.log(`  read ms p50 ${fmt(summary.latency.readMs.p50, 0)} p90 ${fmt(summary.latency.readMs.p90, 0)} mean ${fmt(summary.latency.readMs.mean, 0)}`);
  console.log(`  gpu MiB idle ${summary.memory.gpuUsedMiB?.idle ?? 'n/a'} peak ${summary.memory.gpuUsedMiB?.peak ?? 'n/a'}; kv pool ${summary.memory.kvPool?.tokens ?? 'n/a'} tokens; peak kv use ${fmt(summary.memory.peakKvUsage)}; kv MiB/read mean ${fmt(summary.memory.kvMiBPerRead?.mean, 1)} max ${fmt(summary.memory.kvMiBPerRead?.max, 1)}`);
  console.log(`  cold read ${summary.cold?.readMs ?? 'n/a'}ms vs steady ${fmt(summary.cold?.steadyReadMs, 0)}ms`);
  if (summary.serverReset) console.log('  vLLM restarted during the run: whole-run counters are not usable.');
  if (summary.missing.length) console.log(`  missing: ${summary.missing.join(', ')}`);
  const report = {
    label: values.label || null, model, date: new Date().toISOString(), ledger, vllm, set: values.set, repeat,
    kvDtype, hfConfig: values['hf-config'] ?? null, reads, totalDelta, summary,
  };
  if (values.out) await writeFile(values.out, JSON.stringify(report, (key, value) => (value === Infinity ? '+Inf' : value), 2) + '\n');
} finally {
  stopGpu();
}
