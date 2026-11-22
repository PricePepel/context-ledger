// Card S1: run many agents at once on local open models and keep what each one did.
// Model servers are OpenAI-compatible (vLLM) and come only from SWARM_URLS on this
// machine; a request picks the number of agents and live or simulated, nothing else.
import { randomBytes } from 'node:crypto';
import { InputError } from './errors.mjs';
import { combine, incidents, isCorrect, isVerified, parseAnswer, seeded, systemPrompt, userPrompt } from './swarm-task.mjs';

export const maxAgents = 200;
export const maxRuns = 5;
const requestTimeoutMs = 60_000;
const metricsEveryMs = 500;

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
    if (match) totals[match[1]] = (totals[match[1]] ?? 0) + Number(match[2]);
  }
  return totals;
}

const firstOf = (totals, names) => names.map(name => totals[name]).find(value => Number.isFinite(value));

function metricsView(samples, baseline) {
  if (!samples.length) return null;
  const pick = names => samples.map(sample => firstOf(sample, names)).filter(Number.isFinite);
  const kv = pick(['vllm:kv_cache_usage_perc', 'vllm:gpu_cache_usage_perc']);
  const running = pick(['vllm:num_requests_running']);
  const sum = (list, names) => list.reduce((total, sample) => total + (firstOf(sample, names) ?? 0), 0);
  const hitNames = ['vllm:prefix_cache_hits_total', 'vllm:gpu_prefix_cache_hits_total'];
  const queryNames = ['vllm:prefix_cache_queries_total', 'vllm:gpu_prefix_cache_queries_total'];
  const hits = sum(samples, hitNames) - sum(baseline, hitNames);
  const queries = sum(samples, queryNames) - sum(baseline, queryNames);
  return {
    kvCacheUsage: kv.length ? Math.max(...kv) : null,
    requestsRunning: running.length ? running.reduce((a, b) => a + b, 0) : null,
    prefixCacheHitRate: queries > 0 ? hits / queries : null,
  };
}

export function createSwarm({ env = process.env, fetchImpl = fetch, now = () => performance.now(), simScale } = {}) {
  const urls = swarmUrls(env.SWARM_URLS);
  const concurrency = Math.min(Math.max(Number.parseInt(env.SWARM_CONCURRENCY ?? '32', 10) || 32, 1), maxAgents);
  const scale = simScale ?? (Number(env.SWARM_SIM_SCALE) > 0 ? Number(env.SWARM_SIM_SCALE) : 1);
  const runs = new Map();

  async function getJson(url, init = {}) {
    const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? requestTimeoutMs) });
    if (!response.ok) throw new Error(`status ${response.status}`);
    return response.json();
  }

  /** The first model each server lists, as { url, model }. */
  async function models() {
    return Promise.all(urls.map(async url => {
      const body = await getJson(`${url}/models`, { timeoutMs: 3000 });
      const model = body?.data?.[0]?.id;
      if (typeof model !== 'string') throw new Error('no model listed');
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
    return { reply: typeof reply === 'string' ? reply : '',
      tokensIn: body?.usage?.prompt_tokens ?? null, tokensOut: body?.usage?.completion_tokens ?? null };
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
          agent.reply = out.reply.slice(0, 2000);
          agent.tokensIn = out.tokensIn;
          agent.tokensOut = out.tokensOut;
          agent.verified = isVerified(agent.answer, report.text);
          agent.correct = isCorrect(agent.answer, report.truth);
          agent.state = agent.answer ? 'done' : 'failed';
        } catch {
          agent.state = 'failed';
          agent.error = 'The model server did not answer.';
        }
        agent.ms = now() - run.started - agent.startedMs;
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, run.agents.length) }, worker));
  }

  async function pollMetrics(run, servers) {
    const read = () => Promise.all(servers.map(server => fetchImpl(`${server.url.replace(/\/v1$/u, '')}/metrics`,
      { signal: AbortSignal.timeout(2000) }).then(response => (response.ok ? response.text() : '')).then(parseMetrics)
      .catch(() => ({}))));
    const baseline = await read();
    while (!run.done) {
      const samples = await read();
      if (samples.some(sample => Object.keys(sample).length)) run.metrics = metricsView(samples, baseline);
      await new Promise(resolve => setTimeout(resolve, metricsEveryMs));
    }
  }

  async function execute(run) {
    let servers = [];
    try {
      if (run.mode === 'live') {
        servers = await models();
        run.models = servers.map(server => server.model);
        run.agents.forEach(agent => { agent.model = run.models[agent.index % run.models.length]; });
      }
      run.started = now();
      run.state = 'running';
      const metrics = run.mode === 'live' ? pollMetrics(run, servers) : null;
      await runAgents(run, servers);
      run.wallMs = now() - run.started;
      run.done = true;
      await metrics;
      run.state = 'done';
    } catch {
      run.done = true;
      run.state = 'failed';
      run.error = 'The model server is not answering.';
    }
  }

  function start(input) {
    const agents = input?.agents;
    const mode = input?.mode;
    if (!Number.isInteger(agents) || agents < 1 || agents > maxAgents) throw new InputError(`agents must be a whole number from 1 to ${maxAgents}.`);
    if (mode !== 'live' && mode !== 'simulated') throw new InputError('mode must be live or simulated.');
    if (mode === 'live' && !urls.length) throw new InputError('No model server configured (set SWARM_URLS).');
    const id = randomBytes(32).toString('hex');
    const seed = 7;
    const reports = incidents(agents, seed);
    const run = {
      id, mode, seed, reports, state: 'starting', done: false, started: now(), wallMs: null, metrics: null,
      models: mode === 'simulated' ? ['simulated'] : [],
      agents: reports.map((report, index) => ({ index, id: report.id, model: mode === 'simulated' ? 'simulated' : null,
        state: 'queued', answer: null, verified: false, correct: false })),
    };
    runs.set(id, run);
    while (runs.size > maxRuns) runs.delete(runs.keys().next().value);
    execute(run);
    return { id };
  }

  function snapshot(id) {
    const run = runs.get(id);
    if (!run) return undefined;
    const finished = run.agents.filter(agent => agent.state === 'done' || agent.state === 'failed');
    const sum = key => run.agents.reduce((total, agent) => total + (agent[key] ?? 0), 0);
    const elapsed = run.wallMs ?? (run.state === 'running' ? now() - run.started : 0);
    return {
      id: run.id, mode: run.mode, simulated: run.mode === 'simulated', state: run.state, error: run.error,
      models: run.models, concurrency,
      elapsedMs: Math.round(elapsed),
      oneAfterAnotherMs: Math.round(sum('ms')),
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
