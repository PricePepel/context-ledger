// Card S1: run many agents at once on local open models and keep what each one did.
// Model servers are OpenAI-compatible (vLLM) and come only from SWARM_URLS on this
// machine; a request picks the number of agents and live or simulated, nothing else.
import { randomBytes } from 'node:crypto';
import { ConflictError, InputError } from './errors.mjs';
import { combine, incidents, isCorrect, isVerified, parseAnswer, seeded, systemPrompt, userPrompt } from './swarm-task.mjs';

export const maxAgents = 200;
export const maxRuns = 5;
export const maxResponseBytes = 256 * 1024;
const requestTimeoutMs = 60_000;
const metricsEveryMs = 500;
// Card S1b round 2: the solo baseline reads reports from its own seed, so it never sends
// a run's exact prompts ahead of the run (a prefix cache would then serve them faster).
export const baselineSeed = 1_000_003;

/** The median: the middle value, or the mean of the two middle values for an even count. */
export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** The model servers from SWARM_URLS: loopback http only, refused at start otherwise. */
export function swarmUrls(text) {
  if (!text?.trim()) return [];
  return text.split(',').map(item => item.trim()).filter(Boolean).map(item => {
    let url;
    try { url = new URL(item); } catch { throw new Error('SWARM_URLS must hold http://127.0.0.1 or http://localhost URLs.'); }
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password
      || url.search || url.hash) {
      throw new Error('SWARM_URLS must hold http://127.0.0.1 or http://localhost URLs.');
    }
    return url.href.replace(/\/+$/u, '');
  });
}

/** Prometheus text to { name: summed value } for the vLLM series the page shows. */
export function parseMetrics(text) {
  const totals = {};
  for (const line of text.split('\n')) {
    const match = /^(vllm:[a-z_]+)(?:\{[^}]*\})?\s+([0-9.eE+-]+)\s*$/u.exec(line);
    if (match && Number.isFinite(Number(match[2]))) totals[match[1]] = (totals[match[1]] ?? 0) + Number(match[2]);
  }
  return totals;
}

const firstOf = (totals, names) => names.map(name => totals?.[name]).find(value => Number.isFinite(value));
const hitNames = ['vllm:prefix_cache_hits_total', 'vllm:gpu_prefix_cache_hits_total'];
const queryNames = ['vllm:prefix_cache_queries_total', 'vllm:gpu_prefix_cache_queries_total'];

/**
 * What the page shows from the servers' metrics. A server's prefix-cache counters count
 * only when both its baseline (taken before the first agent starts) and its latest
 * sample have them and they did not go backwards; otherwise the rate is not reported.
 */
export function metricsView(samples, baseline) {
  if (!samples.some(sample => Object.keys(sample).length)) return null;
  const gauges = names => samples.map(sample => firstOf(sample, names)).filter(Number.isFinite);
  const kv = gauges(['vllm:kv_cache_usage_perc', 'vllm:gpu_cache_usage_perc']);
  const running = gauges(['vllm:num_requests_running']);
  let hits = 0;
  let queries = 0;
  let valid = true;
  samples.forEach((sample, index) => {
    const pairs = [[firstOf(baseline[index], hitNames), firstOf(sample, hitNames)], [firstOf(baseline[index], queryNames), firstOf(sample, queryNames)]];
    if (pairs.every(([before, after]) => before === undefined && after === undefined)) return;
    if (pairs.some(([before, after]) => before === undefined || after === undefined || after < before)) { valid = false; return; }
    hits += pairs[0][1] - pairs[0][0];
    queries += pairs[1][1] - pairs[1][0];
  });
  return {
    kvCacheUsage: kv.length ? Math.max(...kv) : null,
    requestsRunning: running.length ? running.reduce((a, b) => a + b, 0) : null,
    prefixCacheHitRate: valid && queries > 0 ? hits / queries : null,
  };
}

/** The body as text, refused past maxResponseBytes (the stream is cancelled). */
async function cappedText(response) {
  const declared = Number(response.headers.get('content-length'));
  if (declared > maxResponseBytes) {
    await response.body?.cancel();
    throw new Error('response too large');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxResponseBytes) {
      await reader.cancel();
      throw new Error('response too large');
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks, size));
}

export function createSwarm({ env = process.env, fetchImpl = fetch, now = () => performance.now(), simScale } = {}) {
  const urls = swarmUrls(env.SWARM_URLS);
  const concurrency = Math.min(Math.max(Number.parseInt(env.SWARM_CONCURRENCY ?? '32', 10) || 32, 1), maxAgents);
  const scale = simScale ?? (Number(env.SWARM_SIM_SCALE) > 0 ? Number(env.SWARM_SIM_SCALE) : 1);
  // Card S1b: timed solo requests per server for the baseline, after one untimed warm-up.
  const baselineRuns = Math.min(Math.max(Number.parseInt(env.SWARM_BASELINE_RUNS ?? '3', 10) || 3, 1), 5);
  const runs = new Map();
  let active = null;
  let baselineCache = null;

  // Every request to a model server: no redirects (they could leave this machine), a
  // timeout, and a size cap before anything is parsed.
  async function request(url, init = {}) {
    const response = await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(init.timeoutMs ?? requestTimeoutMs) });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`status ${response.status}`);
    }
    return cappedText(response);
  }
  const getJson = async (url, init) => JSON.parse(await request(url, init));

  /** The first model each server lists, as { url, model }. */
  async function models() {
    return Promise.all(urls.map(async url => {
      const body = await getJson(`${url}/models`, { timeoutMs: 3000 });
      const model = body?.data?.[0]?.id;
      if (typeof model !== 'string' || !model || model.length > 200) throw new Error('no model listed');
      return { url, model };
    }));
  }

  async function config() {
    if (!urls.length) return { live: false, reason: 'No model server configured (set SWARM_URLS).', concurrency };
    try {
      return { live: true, models: (await models()).map(entry => entry.model), concurrency };
    } catch {
      return { live: false, reason: 'The configured model server is not answering.', concurrency };
    }
  }

  async function liveAgent(run, agent, report, server) {
    const body = await getJson(`${server.url}/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: server.model, temperature: 0, max_tokens: 160,
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt(report.text) }] }),
    });
    const reply = body?.choices?.[0]?.message?.content;
    const count = value => (Number.isInteger(value) && value >= 0 ? value : null);
    return { reply: typeof reply === 'string' ? reply : '', tokensIn: count(body?.usage?.prompt_tokens), tokensOut: count(body?.usage?.completion_tokens) };
  }

  // Seeded stand-in for a model server: the timings and the few wrong answers are made up,
  // and every snapshot of a simulated run says so.
  function simulatedAgent(run, agent, report) {
    const random = seeded(run.seed + agent.index * 7919);
    const delay = (350 + random() * 900) * scale;
    const roll = random();
    const truth = report.truth;
    const sentence = report.text.split('. ').find(part => part.includes(' minutes after ')) ?? '';
    let answer = { ...truth, quote: sentence.endsWith('.') ? sentence : `${sentence}.` };
    if (roll < 0.03) answer = { ...answer, cause: truth.cause === 'capacity limit' ? 'bad deploy' : 'capacity limit' };
    else if (roll < 0.05) answer = { ...answer, downtimeMinutes: truth.downtimeMinutes + 10, quote: `${truth.service} was down for ${truth.downtimeMinutes + 10} minutes.` };
    return new Promise(resolve => setTimeout(() => resolve({ reply: JSON.stringify(answer),
      tokensIn: 380 + Math.round(report.text.length / 4), tokensOut: 30 + Math.floor(random() * 25) }), delay));
  }

  async function runAgents(run, servers) {
    let next = 0;
    const worker = async () => {
      while (next < run.agents.length) {
        const agent = run.agents[next++];
        const report = run.reports[agent.index];
        agent.state = 'running';
        agent.startedMs = now() - run.started;
        try {
          const out = run.mode === 'live' ? await liveAgent(run, agent, report, servers[agent.index % servers.length])
            : await simulatedAgent(run, agent, report);
          agent.answer = parseAnswer(out.reply);
          agent.tokensIn = out.tokensIn;
          agent.tokensOut = out.tokensOut;
          agent.verified = isVerified(agent.answer, report.text);
          agent.correct = isCorrect(agent.answer, report.truth);
          agent.state = agent.answer ? 'done' : 'failed';
          if (!agent.answer) agent.error = 'The reply held no answer.';
        } catch {
          agent.state = 'failed';
          agent.error = 'The model server did not answer.';
        }
        agent.ms = now() - run.started - agent.startedMs;
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, run.agents.length) }, worker));
  }

  const readMetrics = servers => Promise.all(servers.map(server => request(`${server.url.replace(/\/v1$/u, '')}/metrics`,
    { timeoutMs: 2000 }).then(parseMetrics).catch(() => ({}))));

  // Card S1b: keep the highest KV-cache sample seen during the run, since the last sample
  // (after every agent finished) is usually near zero.
  function noteMetrics(run, view) {
    if (!view) return;
    if (Number.isFinite(view.kvCacheUsage)) run.kvPeak = Math.max(run.kvPeak ?? 0, view.kvCacheUsage);
    run.metrics = { ...view, kvCachePeak: run.kvPeak ?? null };
  }

  async function pollMetrics(run, servers, baseline) {
    while (!run.agentsDone) {
      noteMetrics(run, metricsView(await readMetrics(servers), baseline));
      await new Promise(resolve => setTimeout(resolve, metricsEveryMs));
    }
  }

  /**
   * Card S1b: how long one agent takes on each server with nothing else running: one
   * untimed warm-up, then baselineRuns timed requests one at a time, the median kept.
   * Each timed request reads a different report than the warm-up, as an agent would, so
   * only the shared instructions come from the prefix cache. A reply counts only if it
   * holds an answer an agent would accept. Measured once per ledger process for the same
   * servers and models. Null if any request fails, and the run goes on without a speed-up.
   */
  async function soloBaseline(servers) {
    const key = JSON.stringify(servers);
    if (baselineCache?.key === key) return { ...baselineCache.value, reused: true };
    const reports = incidents(baselineRuns + 1, baselineSeed);
    const usable = async (report, server) => {
      if (!parseAnswer((await liveAgent(null, null, report, server)).reply)) throw new Error('no usable answer');
    };
    try {
      const perServer = [];
      for (const server of servers) {
        await usable(reports[0], server);
        const times = [];
        for (const report of reports.slice(1)) {
          const begin = now();
          await usable(report, server);
          times.push(now() - begin);
        }
        perServer.push({ model: server.model, ms: median(times) });
      }
      const value = { perServer, runs: baselineRuns, measuredAt: new Date().toISOString() };
      baselineCache = { key, value };
      return { ...value, reused: false };
    } catch {
      return null;
    }
  }

  async function execute(run) {
    try {
      let servers = [];
      let baseline = [];
      if (run.mode === 'live') {
        servers = await models();
        run.models = servers.map(server => server.model);
        run.agents.forEach(agent => { agent.model = run.models[agent.index % run.models.length]; });
        run.phase = 'baseline';
        run.baseline = await soloBaseline(servers);
        run.phase = null;
        baseline = await readMetrics(servers);
      }
      run.started = now();
      run.state = 'running';
      const metrics = run.mode === 'live' ? pollMetrics(run, servers, baseline) : null;
      await runAgents(run, servers);
      run.wallMs = now() - run.started;
      run.agentsDone = true;
      await metrics;
      // A last sample after every agent finished, so a short run still gets its numbers.
      // If it fails, the last sample from during the run stays, marked stale, with no "running now".
      if (run.mode === 'live') {
        const last = metricsView(await readMetrics(servers), baseline);
        if (last) noteMetrics(run, last);
        else if (run.metrics) run.metrics = { ...run.metrics, requestsRunning: null, stale: true };
      }
      if (run.agents.every(agent => agent.state === 'failed')) {
        run.state = 'failed';
        run.error = 'Every agent failed: the model server did not give usable answers.';
      } else {
        run.state = 'done';
      }
    } catch {
      run.state = 'failed';
      run.error = 'The model server is not answering.';
    } finally {
      run.agentsDone = true;
      if (active === run) active = null;
    }
  }

  function start(input) {
    const agents = input?.agents;
    const mode = input?.mode;
    if (!Number.isInteger(agents) || agents < 1 || agents > maxAgents) throw new InputError(`agents must be a whole number from 1 to ${maxAgents}.`);
    if (mode !== 'live' && mode !== 'simulated') throw new InputError('mode must be live or simulated.');
    if (mode === 'live' && !urls.length) throw new InputError('No model server configured (set SWARM_URLS).');
    // One run at a time, so SWARM_CONCURRENCY bounds the requests the GPU sees.
    if (active) throw new ConflictError('A swarm run is already running. Wait for it to finish.', { runId: active.id });
    const id = randomBytes(32).toString('hex');
    const seed = 7;
    const reports = incidents(agents, seed);
    const run = {
      id, mode, seed, reports, state: 'starting', phase: null, agentsDone: false, started: now(), wallMs: null, metrics: null, baseline: null, kvPeak: null,
      models: mode === 'simulated' ? ['simulated'] : [],
      agents: reports.map((report, index) => ({ index, id: report.id, model: mode === 'simulated' ? 'simulated' : null,
        state: 'queued', answer: null, verified: false, correct: false })),
    };
    active = run;
    runs.set(id, run);
    // Only finished runs are dropped; the running one is never among the oldest kept.
    for (const [key, kept] of runs) {
      if (runs.size <= maxRuns) break;
      if (kept !== active) runs.delete(key);
    }
    execute(run);
    return { id };
  }

  function snapshot(id) {
    const run = runs.get(id);
    if (!run) return undefined;
    const finished = run.agents.filter(agent => agent.state === 'done' || agent.state === 'failed');
    const sum = key => run.agents.reduce((total, agent) => total + (agent[key] ?? 0), 0);
    const elapsed = run.wallMs ?? (run.state === 'running' ? now() - run.started : 0);
    // Card S1b: one after another is estimated from each answered agent's server running it
    // alone, not from the agents' own times under load (each request is slower when shared).
    // Failed agents add nothing, so fast errors cannot raise the speed-up.
    const solo = run.baseline?.perServer;
    const answered = run.agents.filter(agent => agent.state === 'done');
    const oneAfterAnother = solo && answered.length ? answered.reduce((total, agent) => total + solo[agent.index % solo.length].ms, 0) : null;
    return {
      id: run.id, mode: run.mode, simulated: run.mode === 'simulated', state: run.state, error: run.error,
      models: run.models, concurrency,
      elapsedMs: Math.round(elapsed),
      phase: run.phase,
      baseline: run.baseline && { perServer: run.baseline.perServer.map((entry, index) => ({ model: entry.model, ms: Math.round(entry.ms),
          answered: answered.filter(agent => agent.index % run.baseline.perServer.length === index).length })),
        runs: run.baseline.runs, measuredAt: run.baseline.measuredAt, reused: run.baseline.reused },
      oneAfterAnotherMs: oneAfterAnother === null ? null : Math.round(oneAfterAnother),
      speedup: oneAfterAnother !== null && elapsed > 0 ? oneAfterAnother / elapsed : null,
      answeredForSpeedup: answered.length,
      agentMsSum: Math.round(sum('ms')),
      tokensIn: sum('tokensIn'), tokensOut: sum('tokensOut'),
      counts: { total: run.agents.length, finished: finished.length,
        running: run.agents.filter(agent => agent.state === 'running').length,
        failed: run.agents.filter(agent => agent.state === 'failed').length,
        verified: run.agents.filter(agent => agent.verified).length,
        correct: run.agents.filter(agent => agent.correct).length },
      metrics: run.metrics,
      agents: run.agents.map(agent => ({ id: agent.id, model: agent.model, state: agent.state,
        ms: agent.ms === undefined ? null : Math.round(agent.ms), tokensIn: agent.tokensIn ?? null, tokensOut: agent.tokensOut ?? null,
        answer: agent.answer, verified: agent.verified, correct: agent.correct, error: agent.error,
        report: run.reports[agent.index].text })),
      answer: run.state === 'done' ? combine(run.agents, run.reports) : null,
    };
  }

  return { config, start, snapshot, urls, concurrency };
}
