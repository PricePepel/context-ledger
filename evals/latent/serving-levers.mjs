// Card L1: fire N agents at once at one vLLM server and report time, tokens per second,
// prefix-cache hit rate, peak KV use and peak GPU memory.
// Usage: node evals/latent/serving-levers.mjs --agents 100 [--label baseline]
//   [--base http://127.0.0.1:8000] [--model <id>] [--handbook-words 0] [--unique-words 0]
//   [--max-tokens 160] [--salt <text>: repeat an earlier run's prompts] [--out report.json] [--nvidia-smi nvidia-smi] [--timeout-s 600]
// Reports come from the swarm's own task (src/swarm-task.mjs): the same instructions,
// answer checks and incident reports as the swarm page. Every agent starts at the same
// moment; a run's prefix is salted so the previous run's cache does not count.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { incidents, isCorrect, isVerified, parseAnswer, systemPrompt } from '../../src/swarm-task.mjs';
import { agentMessages, metricsDelta, parseMetrics, summarizeRun } from './serving-lib.mjs';

const { values } = parseArgs({
  options: {
    agents: { type: 'string', default: '25' },
    label: { type: 'string', default: '' },
    base: { type: 'string', default: 'http://127.0.0.1:8000' },
    model: { type: 'string' },
    'handbook-words': { type: 'string', default: '0' },
    'unique-words': { type: 'string', default: '0' },
    'max-tokens': { type: 'string', default: '160' },
    seed: { type: 'string', default: '7' },
    salt: { type: 'string' },
    out: { type: 'string' },
    'nvidia-smi': { type: 'string', default: 'nvidia-smi' },
    'timeout-s': { type: 'string', default: '600' },
  },
});
const whole = (name, text, min = 0) => {
  const value = Number(text);
  if (!Number.isInteger(value) || value < min) throw new Error(`--${name} must be a whole number of at least ${min}.`);
  return value;
};
const agentCount = whole('agents', values.agents, 1);
const handbookWords = whole('handbook-words', values['handbook-words']);
const uniqueWords = whole('unique-words', values['unique-words']);
const maxTokens = whole('max-tokens', values['max-tokens'], 1);
const seed = whole('seed', values.seed);
const timeoutMs = whole('timeout-s', values['timeout-s'], 1) * 1000;
const base = new URL(values.base);
if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(base.hostname)) throw new Error('--base must be a loopback http URL.');
const root = base.href.replace(/\/+$/u, '');

const text = async path => {
  const response = await fetch(`${root}${path}`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`${path}: status ${response.status}`);
  return response.text();
};
const sample = async () => parseMetrics(await text('/metrics').catch(() => ''));
const model = values.model ?? JSON.parse(await text('/v1/models')).data[0].id;

/** GPU memory used, in MiB, from nvidia-smi; NaN when the command fails. */
function gpuUsed() {
  return new Promise(resolve => {
    const child = spawn(values['nvidia-smi'], ['--query-gpu=memory.used', '--format=csv,noheader,nounits', '--id=0']);
    let settled = false;
    const done = value => { if (!settled) { settled = true; clearTimeout(timer); child.kill('SIGKILL'); resolve(value); } };
    const timer = setTimeout(() => done(Number.NaN), 3000);
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.on('error', () => done(Number.NaN));
    child.on('close', () => done(Number.parseInt(out, 10)));
  });
}

const reports = incidents(agentCount, seed);
// --salt repeats an earlier run's prompts exactly, so a second wave can find the first one's cache.
const salt = values.salt ?? randomBytes(4).toString('hex');
const gpuSamples = [];
let kvPeak = null;
let running = true;
const startPoll = () => (async () => {
  while (running) {
    const [gpu, metrics] = await Promise.all([gpuUsed(), sample()]);
    gpuSamples.push(gpu);
    const usage = metrics['vllm:kv_cache_usage_perc'];
    if (Number.isFinite(usage)) kvPeak = Math.max(kvPeak ?? 0, usage);
    await new Promise(resolve => setTimeout(resolve, 300));
  }
})();

async function agent(report, index) {
  const started = performance.now();
  try {
    const response = await fetch(`${root}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({ model, temperature: 0, max_tokens: maxTokens,
        messages: agentMessages({ system: systemPrompt, report: report.text, salt, handbookWords, uniqueWords, index }) }),
    });
    if (!response.ok) return { ok: false, responded: false, ms: performance.now() - started, error: `status ${response.status}` };
    const body = await response.json();
    const answer = parseAnswer(body?.choices?.[0]?.message?.content ?? '');
    return { ok: Boolean(answer), responded: true, ms: performance.now() - started, correct: isCorrect(answer, report.truth),
      verified: isVerified(answer, report.text), promptTokens: body?.usage?.prompt_tokens ?? 0,
      completionTokens: body?.usage?.completion_tokens ?? 0, cachedTokens: body?.usage?.prompt_tokens_details?.cached_tokens ?? 0 };
  } catch (error) {
    return { ok: false, ms: performance.now() - started, error: String(error?.name ?? error) };
  }
}

const before = await sample();
const poll = startPoll();
const started = performance.now();
const results = await Promise.all(reports.map(agent));
const wallMs = performance.now() - started;
const after = await sample();
running = false;
await poll;

const report = {
  label: values.label, model, salt, handbookWords, uniqueWords, maxTokens, measured: true,
  ...summarizeRun({ agents: results, wallMs, delta: metricsDelta(before, after), kvPeak, gpuSamplesMiB: gpuSamples }),
  promptTokensPerAgent: Math.round(results.reduce((total, item) => total + (item.promptTokens ?? 0), 0) / Math.max(1, results.filter(item => item.responded).length)),
  cachedTokensShare: Number((results.reduce((total, item) => total + (item.cachedTokens ?? 0), 0)
    / Math.max(1, results.reduce((total, item) => total + (item.promptTokens ?? 0), 0))).toFixed(3)),
  errors: [...new Set(results.filter(item => !item.ok && item.error).map(item => item.error))],
};
console.log(JSON.stringify(report));
if (values.out) await writeFile(values.out, `${JSON.stringify(report, null, 2)}\n`);
