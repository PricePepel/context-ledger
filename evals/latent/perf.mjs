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
import {
  delta, kvBytesPerToken, kvDtypeMismatch, measureReads, parsePrometheus, snapshot, startKvPoller, summarizeRun,
} from './perf-lib.mjs';

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

// A failed scrape mid-run resolves to null instead of stopping the run; measureReads
// then takes a fresh baseline before the next read.
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

const gpu = startGpuSampler(values['nvidia-smi']);
const stopGpu = () => gpu.stop();
process.once('SIGINT', () => { stopGpu(); process.exit(130); });
try {
  const firstSeries = await scrape();
  const models = snapshot(firstSeries).models;
  const model = values.model ?? (models.length === 1 ? models[0] : null);
  if (!model) throw new Error(`/metrics names ${models.length ? `several models (${models.join(', ')}); pass --model` : 'no model'}.`);
  const start = snapshot(firstSeries, { model });
  const mismatch = kvDtypeMismatch(kvDtype, start.kvPool?.cacheDtype);
  if (mismatch) throw new Error(mismatch);
  await gpu.first;
  const { reads, end, covered, restarted } = await measureReads({
    questions: set.questions,
    repeat,
    start,
    ask,
    take: () => take(model),
    grade: gradeSlice,
    poll: () => startKvPoller(async () => (await take(model))?.gauges['vllm:kv_cache_usage_perc'] ?? null),
    log: line => console.log(line),
  });
  const totalDelta = delta(start, end);
  const gpuSamplesMiB = gpu.samples();
  const summary = summarizeRun({
    reads, totalDelta, coveredReads: covered, restarted, gpuSamplesMiB, kvPool: end.kvPool ?? start.kvPool, bytesPerToken,
  });
  const fmt = (value, digits = 3) => (value === null || value === undefined ? 'n/a' : Number(value).toFixed(digits));
  console.log(`config ${values.label || '(no label)'} model ${model}: ${reads.length} reads`);
  console.log(`  accuracy ${summary.accuracy.correct}/${summary.accuracy.total} correct, ${summary.accuracy.cited}/${summary.accuracy.total} cited, ${summary.accuracy.correctAndCited}/${summary.accuracy.total} both`);
  console.log(`  ttft mean ${fmt(summary.ttft?.mean)}s p50 ${fmt(summary.ttft?.p50)}s p90 ${fmt(summary.ttft?.p90)}s over ${summary.vllmCalls ?? 'n/a'} calls`);
  console.log(`  prefix cache hit ${fmt(summary.prefixCache.hitRate)} receipts cached ${fmt(summary.prefixCache.receiptCachedShare)}`);
  console.log(`  tokens/s decode ${fmt(summary.tokensPerSecond.perRequestDecode, 1)} aggregate ${fmt(summary.tokensPerSecond.aggregate, 1)}`);
  if (summary.specDecode) console.log(`  spec decode accepted ${summary.specDecode.acceptedTokens}/${summary.specDecode.draftTokens} draft tokens (${fmt(summary.specDecode.acceptanceRate)})`);
  console.log(`  read ms p50 ${fmt(summary.latency.readMs.p50, 0)} p90 ${fmt(summary.latency.readMs.p90, 0)} mean ${fmt(summary.latency.readMs.mean, 0)}`);
  console.log(`  gpu MiB idle ${summary.memory.gpuUsedMiB?.idle ?? 'n/a'} peak ${summary.memory.gpuUsedMiB?.peak ?? 'n/a'}; kv pool ${summary.memory.kvPool?.tokens ?? 'n/a'} tokens; peak kv use ${fmt(summary.memory.peakKvUsage)}; kv MiB/read mean ${fmt(summary.memory.kvMiBPerRead?.mean, 1)} max ${fmt(summary.memory.kvMiBPerRead?.max, 1)}`);
  console.log(`  cold read ${summary.cold?.failed ? 'failed' : `${summary.cold?.readMs ?? 'n/a'}ms`} vs steady ${fmt(summary.cold?.steadyReadMs, 0)}ms; ${summary.latency.failedReads} failed reads left out of latency`);
  if (summary.serverReset) console.log('  vLLM restarted during the run: whole-run counters are not usable.');
  if (summary.metricsCoverage.reads < summary.metricsCoverage.total) {
    console.log(`  whole-run vLLM figures cover ${summary.metricsCoverage.reads} of ${summary.metricsCoverage.total} reads (final /metrics scrapes failed).`);
  }
  if (summary.missing.length) console.log(`  missing: ${summary.missing.join(', ')}`);
  const report = {
    label: values.label || null, model, date: new Date().toISOString(), ledger, vllm, set: values.set, repeat,
    kvDtype, hfConfig: values['hf-config'] ?? null, reads, totalDelta, summary,
  };
  if (values.out) await writeFile(values.out, JSON.stringify(report, (key, value) => (value === Infinity ? '+Inf' : value), 2) + '\n');
} finally {
  stopGpu();
}
