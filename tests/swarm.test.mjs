import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createSwarm, metricsView, parseMetrics, swarmUrls } from '../src/swarm.mjs';
import { causes, combine, incidents, isCorrect, isVerified, parseAnswer, systemPrompt } from '../src/swarm-task.mjs';
import { bearer, ledgerToken } from './ledger-auth.mjs';

// Card S1: the swarm demo. Synthetic incident reports only.

async function until(check, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('timed out');
}

test('reports are the same for a seed, and each states its downtime and service', () => {
  const a = incidents(50, 7);
  assert.deepEqual(a, incidents(50, 7));
  assert.notDeepEqual(a.map(r => r.text), incidents(50, 8).map(r => r.text));
  for (const report of a) {
    assert.ok(report.text.includes(`${report.truth.downtimeMinutes} minutes`));
    assert.ok(report.text.includes(`The ${report.truth.service} service`));
    assert.ok(causes.includes(report.truth.cause));
  }
});

test('an answer is verified only when its quote is in the report and states the downtime', () => {
  const [report] = incidents(1, 7);
  const sentence = report.text.split('. ').find(part => part.includes(' minutes after '));
  const answer = { ...report.truth, quote: `${sentence}.` };
  assert.equal(isVerified(answer, report.text), true);
  assert.equal(isVerified({ ...answer, quote: `  ${sentence.replace(/ /gu, '  ')}.  ` }, report.text), true, 'whitespace is folded');
  assert.equal(isVerified({ ...answer, quote: 'The service was down.' }, report.text), false, 'not in the report');
  assert.equal(isVerified({ ...answer, downtimeMinutes: answer.downtimeMinutes + 1 }, report.text), false, 'number not in the quote');
  const digit = String(answer.downtimeMinutes).slice(0, 1);
  if (String(answer.downtimeMinutes).length > 1) assert.equal(isVerified({ ...answer, downtimeMinutes: Number(digit) }, report.text), false, 'a digit inside a number is not the number');
  assert.equal(isVerified({ ...answer, quote: '' }, report.text), false);
  // Review round 1: a number elsewhere in the quote (a date, the incident number) is not the downtime.
  const dated = report.text.slice(0, report.text.indexOf('.', report.text.indexOf('2026-')) + 1);
  assert.equal(isVerified({ ...answer, downtimeMinutes: 2026, quote: dated }, report.text), false, 'a year is not a downtime');
  assert.equal(isVerified({ ...answer, downtimeMinutes: report.id, quote: report.text }, report.text), false, 'the incident number is not a downtime');
  assert.equal(isVerified(null, report.text), false);
  assert.equal(isCorrect(answer, report.truth), true);
  assert.equal(isCorrect({ ...answer, cause: 'bad deploy' === report.truth.cause ? 'capacity limit' : 'bad deploy' }, report.truth), false);
});

test('replies are parsed leniently but typed strictly', () => {
  assert.deepEqual(parseAnswer('Sure: {"service": " Search ", "cause": "Bad Deploy", "downtimeMinutes": 12, "quote": "q"} done'),
    { service: 'Search', cause: 'bad deploy', downtimeMinutes: 12, quote: 'q' });
  assert.equal(parseAnswer('no json'), null);
  assert.equal(parseAnswer('[1, 2]'), null);
  const base = { service: 's', cause: 'bad deploy', quote: 'q' };
  assert.equal(parseAnswer(JSON.stringify({ ...base, downtimeMinutes: '12' })), null, 'a string is not a number');
  assert.equal(parseAnswer(JSON.stringify({ ...base, downtimeMinutes: 1.5 })), null);
  // Round 2: {} or a partial object is no answer.
  assert.equal(parseAnswer('{}'), null);
  assert.equal(parseAnswer('{"service": "", "cause": "x", "quote": "q", "downtimeMinutes": 3}'), null);
  const long = parseAnswer(JSON.stringify({ service: 's'.repeat(5000), cause: 'c'.repeat(500), quote: 'q'.repeat(5000), downtimeMinutes: -3 }));
  assert.deepEqual([long.service.length, long.cause.length, long.quote.length, long.downtimeMinutes], [80, 40, 400, null], 'fields are capped');
});

test('the combined answer uses verified answers only and shows the truth beside it', () => {
  const reports = incidents(30, 7);
  const agents = reports.map(report => ({ verified: true, answer: { ...report.truth, quote: '' } }));
  const all = combine(agents, reports);
  assert.deepEqual(all.fromAgents.services, all.truth.services);
  assert.equal(all.fromAgents.totalDowntimeMinutes, all.truth.totalDowntimeMinutes);
  const hit = reports.findIndex(report => report.truth.cause === 'configuration change');
  agents[hit].verified = false;
  const less = combine(agents, reports);
  assert.equal(less.fromAgents.answersUsed, 29);
  assert.equal(less.fromAgents.totalDowntimeMinutes, all.truth.totalDowntimeMinutes - reports[hit].truth.downtimeMinutes);
});

test('the shared instructions come first and hold no report text', () => {
  assert.ok(systemPrompt.length > 600, 'long enough for prefix caching to matter');
  for (const report of incidents(5, 7)) assert.ok(!systemPrompt.includes(report.text));
});

test('model servers must be local http URLs', () => {
  assert.deepEqual(swarmUrls(' http://127.0.0.1:8000/v1/ , http://localhost:8001/v1'), ['http://127.0.0.1:8000/v1', 'http://localhost:8001/v1']);
  assert.deepEqual(swarmUrls(''), []);
  for (const bad of ['https://127.0.0.1:8000/v1', 'http://10.0.0.2:8000/v1', 'http://example.com/v1', 'http://user:pw@127.0.0.1/v1',
    'http://127.0.0.1:8000/v1?x=1', 'not a url', 'http://127.0.0.1.example.com/v1']) {
    assert.throws(() => swarmUrls(bad), /SWARM_URLS/u, bad);
  }
});

test('metrics sum vLLM series across labels and ignore everything else', () => {
  const text = ['# HELP x', 'vllm:kv_cache_usage_perc{model_name="a"} 0.25', 'vllm:num_requests_running{model_name="a"} 3',
    'vllm:num_requests_running{model_name="b"} 2', 'other_metric 9', 'vllm:prefix_cache_hits_total{x="y"} 1e3'].join('\n');
  assert.deepEqual(parseMetrics(text), { 'vllm:kv_cache_usage_perc': 0.25, 'vllm:num_requests_running': 5, 'vllm:prefix_cache_hits_total': 1000 });
});

test('start checks its input, runs one swarm at a time and keeps at most five finished runs', async () => {
  const swarm = createSwarm({ env: {}, simScale: 0.001 });
  for (const bad of [{}, { agents: 0, mode: 'simulated' }, { agents: 201, mode: 'simulated' }, { agents: 1.5, mode: 'simulated' },
    { agents: '10', mode: 'simulated' }, { agents: 10, mode: 'fast' }]) {
    assert.throws(() => swarm.start(bad), /agents must|mode must/u, JSON.stringify(bad));
  }
  assert.throws(() => swarm.start({ agents: 3, mode: 'live' }), /No model server configured/u);
  const ids = [];
  for (let i = 0; i < 6; i += 1) {
    const { id } = swarm.start({ agents: 1, mode: 'simulated' });
    assert.ok(/^[a-f0-9]{64}$/u.test(id));
    // Review round 1 (high): a second run while one is running is refused, so the
    // concurrency limit bounds what the GPU sees and no running run is ever dropped.
    assert.throws(() => swarm.start({ agents: 1, mode: 'simulated' }), /already running/u);
    await until(() => swarm.snapshot(id).state === 'done');
    ids.push(id);
  }
  assert.equal(swarm.snapshot(ids[0]), undefined, 'the oldest finished run is dropped');
  assert.ok(swarm.snapshot(ids[5]));
});

test('a simulated run finishes, says it is simulated and reports no GPU numbers', async () => {
  const swarm = createSwarm({ env: { SWARM_CONCURRENCY: '16' }, simScale: 0.002 });
  const { id } = swarm.start({ agents: 100, mode: 'simulated' });
  const run = await until(() => (swarm.snapshot(id).state === 'done' ? swarm.snapshot(id) : null));
  assert.equal(run.simulated, true);
  assert.deepEqual(run.models, ['simulated']);
  assert.equal(run.counts.finished, 100);
  assert.equal(run.metrics, null);
  assert.ok(run.counts.verified >= 90 && run.counts.verified < 100, 'a few seeded answers fail the quote check');
  assert.ok(run.counts.correct < run.counts.finished, 'a few seeded answers are wrong');
  // Card S1b: a simulated run takes no solo baseline, so there is no honest speed-up to show.
  assert.equal(run.baseline, null);
  assert.equal(run.oneAfterAnotherMs, null);
  assert.equal(run.speedup, null);
  assert.ok(run.agentMsSum >= run.elapsedMs, 'the old sum stays in the API only');
  assert.ok(run.answer.truth.incidents > 0);
});

/** A local OpenAI-compatible stand-in that answers from the report, counting concurrent requests. */
async function fakeModelServer(t, { model, failFor = new Set(), metrics = () => '', reply, onComplete = () => {}, delayMs = 15 }) {
  const state = { active: 0, peak: 0, calls: 0, prompts: [] };
  const server = createServer(async (request, response) => {
    if (request.url === '/v1/models') return response.end(JSON.stringify({ data: [{ id: model }] }));
    if (request.url === '/metrics') return response.end(metrics());
    let body = '';
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    state.calls += 1;
    state.active += 1;
    state.peak = Math.max(state.peak, state.active);
    state.prompts.push(input.messages);
    await new Promise(resolve => setTimeout(resolve, typeof delayMs === 'function' ? delayMs(state.active) : delayMs));
    state.active -= 1;
    const report = input.messages[1].content.replace(/^Report: /u, '');
    const id = Number(/^Incident (\d+)/u.exec(report)[1]);
    if (failFor.has(id)) { response.statusCode = 500; return response.end('{}'); }
    onComplete();
    if (reply) return response.end(JSON.stringify({ choices: [{ message: { content: reply } }] }));
    const truth = incidents(id, 7)[id - 1].truth;
    const quote = report.split('. ').find(part => part.includes(' minutes after '));
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ...truth, quote: `${quote}.` }) } }],
      usage: { prompt_tokens: 400, completion_tokens: 40 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}/v1`, state };
}

test('a live run spreads agents over the servers, keeps to the concurrency limit and reads the metrics', async t => {
  let hits = 0;
  const metricsText = () => { hits += 50; return `vllm:kv_cache_usage_perc 0.4\nvllm:prefix_cache_hits_total ${hits}\nvllm:prefix_cache_queries_total ${hits * 2}\nvllm:num_requests_running 4\n`; };
  const a = await fakeModelServer(t, { model: 'model-a', metrics: metricsText, failFor: new Set([7]) });
  const b = await fakeModelServer(t, { model: 'model-b' });
  const swarm = createSwarm({ env: { SWARM_URLS: `${a.url},${b.url}`, SWARM_CONCURRENCY: '4' } });
  assert.deepEqual(await swarm.config(), { live: true, models: ['model-a', 'model-b'], concurrency: 4 });
  const { id } = swarm.start({ agents: 20, mode: 'live' });
  const run = await until(() => (swarm.snapshot(id).state === 'done' ? swarm.snapshot(id) : null));
  assert.equal(run.simulated, false);
  assert.deepEqual(run.models, ['model-a', 'model-b']);
  // Card S1b: each server also got one warm-up and three timed solo requests first.
  assert.equal(a.state.calls + b.state.calls, 20 + 2 * 4);
  assert.deepEqual(run.baseline.perServer.map(entry => entry.model), ['model-a', 'model-b']);
  assert.ok(a.state.peak + b.state.peak <= 4 + 1 && Math.max(a.state.peak, b.state.peak) <= 4, 'never more than the limit at once');
  assert.deepEqual(run.agents.map(agent => agent.model), Array.from({ length: 20 }, (_, i) => (i % 2 ? 'model-b' : 'model-a')));
  assert.equal(run.agents[6].state, 'failed', 'agent 7 got a server error');
  assert.equal(run.counts.failed, 1);
  assert.equal(run.counts.verified, 19);
  assert.equal(run.counts.correct, 19);
  assert.equal(run.tokensOut, 19 * 40);
  assert.equal(run.metrics.kvCacheUsage, 0.4);
  assert.equal(run.metrics.kvCachePeak, 0.4);
  assert.equal(run.metrics.prefixCacheHitRate, 0.5, 'hits over queries since the run started');
  for (const messages of [...a.state.prompts, ...b.state.prompts]) assert.equal(messages[0].content, systemPrompt, 'the shared prefix comes first');
});

test('a live run with a silent server fails cleanly', async () => {
  const swarm = createSwarm({ env: { SWARM_URLS: 'http://127.0.0.1:9/v1' } });
  const config = await swarm.config();
  assert.equal(config.live, false);
  const { id } = swarm.start({ agents: 3, mode: 'live' });
  const run = await until(() => (swarm.snapshot(id).state === 'failed' ? swarm.snapshot(id) : null));
  assert.equal(run.error, 'The model server is not answering.');
  assert.equal(run.answer, null);
});

test('review round 1: model requests do not follow redirects and refuse oversized bodies', async t => {
  const requests = [];
  const offsite = createServer((request, response) => { requests.push(request.url); response.end('{}'); });
  await new Promise(resolve => offsite.listen(0, '127.0.0.1', resolve));
  t.after(() => offsite.close());
  const redirecting = createServer((request, response) => {
    response.writeHead(302, { Location: `http://127.0.0.1:${offsite.address().port}${request.url}` });
    response.end();
  });
  await new Promise(resolve => redirecting.listen(0, '127.0.0.1', resolve));
  t.after(() => redirecting.close());
  const swarm = createSwarm({ env: { SWARM_URLS: `http://127.0.0.1:${redirecting.address().port}/v1` } });
  assert.equal((await swarm.config()).live, false);
  assert.deepEqual(requests, [], 'the redirect target was never contacted');

  const huge = createServer((request, response) => {
    if (request.url === '/v1/models') return response.end(JSON.stringify({ data: [{ id: 'm' }], pad: 'x'.repeat(300 * 1024) }));
    response.end('{}');
  });
  await new Promise(resolve => huge.listen(0, '127.0.0.1', resolve));
  t.after(() => huge.close());
  assert.equal((await createSwarm({ env: { SWARM_URLS: `http://127.0.0.1:${huge.address().port}/v1` } }).config()).live, false);
});

test('review round 1: the prefix-cache rate needs a baseline and counters that only grow', () => {
  const sample = (hits, queries) => ({ 'vllm:prefix_cache_hits_total': hits, 'vllm:prefix_cache_queries_total': queries });
  assert.equal(metricsView([sample(150, 300)], [sample(100, 200)]).prefixCacheHitRate, 0.5);
  assert.equal(metricsView([sample(150, 300)], [{}]).prefixCacheHitRate, null, 'no baseline: old traffic would count');
  assert.equal(metricsView([sample(10, 20)], [sample(100, 200)]).prefixCacheHitRate, null, 'a restarted server');
  assert.equal(metricsView([{}], [{}]), null, 'nothing reported');
  const view = metricsView([{ 'vllm:num_requests_running': 3 }, { 'vllm:num_requests_running': 2 }], [{}, {}]);
  assert.equal(view.requestsRunning, 5);
  assert.equal(view.kvCacheUsage, null, 'missing is not zero');
});

test('review round 1: a short live run still gets its metrics, and a run where every agent fails is a failure', async t => {
  // Round 2: the counters move only when the completion finishes, so only a scrape after
  // the agent finished can see the hits; an earlier scrape sees no queries at all.
  let hits = 0;
  const metricsText = () => `vllm:prefix_cache_hits_total ${hits}\nvllm:prefix_cache_queries_total ${hits * 4}\n`;
  const ok = await fakeModelServer(t, { model: 'm', metrics: metricsText, onComplete: () => { hits += 10; } });
  const swarm = createSwarm({ env: { SWARM_URLS: ok.url } });
  const { id } = swarm.start({ agents: 1, mode: 'live' });
  const run = await until(() => (swarm.snapshot(id).state === 'done' ? swarm.snapshot(id) : null));
  assert.equal(run.metrics.prefixCacheHitRate, 0.25, 'the last sample after the agents finished');

  const failing = await fakeModelServer(t, { model: 'm', failFor: new Set([1, 2, 3]) });
  const swarm2 = createSwarm({ env: { SWARM_URLS: failing.url } });
  const second = swarm2.start({ agents: 3, mode: 'live' }).id;
  const failed = await until(() => (swarm2.snapshot(second).state === 'failed' ? swarm2.snapshot(second) : null));
  assert.match(failed.error, /Every agent failed/u);
  assert.equal(failed.answer, null);

  // Round 2: a model that answers {} to every agent gives no usable answer either.
  const empty = await fakeModelServer(t, { model: 'm', reply: '{}' });
  const swarm3 = createSwarm({ env: { SWARM_URLS: empty.url } });
  const third = swarm3.start({ agents: 2, mode: 'live' }).id;
  const emptyRun = await until(() => (swarm3.snapshot(third).state === 'failed' ? swarm3.snapshot(third) : null));
  assert.match(emptyRun.error, /Every agent failed/u);
});

test('round 2: when the last metrics scrape fails, the earlier sample is marked stale and nothing is "running now"', async t => {
  let scrapes = 0;
  let stopAfter = Infinity;
  const metrics = () => {
    scrapes += 1;
    return scrapes > stopAfter ? '' : 'vllm:num_requests_running 2\nvllm:kv_cache_usage_perc 0.3\n';
  };
  // The scrapes stop when the agent's request completes; S1b's two baseline requests come first.
  let completions = 0;
  const slow = await fakeModelServer(t, { model: 'm', metrics, delayMs: active => (completions >= 2 ? 1200 : 5),
    onComplete: () => { completions += 1; if (completions === 3) stopAfter = scrapes; } });
  const swarm = createSwarm({ env: { SWARM_URLS: slow.url, SWARM_BASELINE_RUNS: '1' } });
  const { id } = swarm.start({ agents: 1, mode: 'live' });
  const run = await until(() => (swarm.snapshot(id).state === 'done' ? swarm.snapshot(id) : null));
  assert.ok(run.metrics, 'a scrape during the 1.2 s agent saw the server');
  assert.equal(run.metrics.stale, true);
  assert.equal(run.metrics.requestsRunning, null);
  assert.equal(run.metrics.kvCacheUsage, 0.3);
});

test('S1b: the speed-up uses one agent timed alone, not the agents’ own times under load', async t => {
  // Each request takes 40 ms per request in flight, so it is 8x slower when 8 share the server.
  const server = await fakeModelServer(t, { model: 'm', delayMs: active => 40 * active });
  const swarm = createSwarm({ env: { SWARM_URLS: server.url, SWARM_CONCURRENCY: '8' } });
  const { id } = swarm.start({ agents: 16, mode: 'live' });
  const run = await until(() => (swarm.snapshot(id).state === 'done' ? swarm.snapshot(id) : null));
  const [solo] = run.baseline.perServer;
  assert.ok(solo.ms >= 35 && solo.ms < 150, `solo ${solo.ms} ms is one request alone`);
  assert.equal(run.baseline.runs, 3);
  assert.equal(run.baseline.reused, false);
  assert.ok(Math.abs(run.oneAfterAnotherMs - 16 * solo.ms) <= 16, 'one after another is 16 solo runs');
  assert.ok(Math.abs(run.speedup - run.oneAfterAnotherMs / run.elapsedMs) < 0.05);
  const oldRatio = run.agentMsSum / run.elapsedMs;
  assert.ok(run.speedup < oldRatio / 2, `honest ${run.speedup.toFixed(2)}x is well below the old ${oldRatio.toFixed(2)}x`);

  // A second run on the same servers reuses the baseline instead of timing again.
  const calls = server.state.calls;
  const second = swarm.start({ agents: 2, mode: 'live' }).id;
  const again = await until(() => (swarm.snapshot(second).state === 'done' ? swarm.snapshot(second) : null));
  assert.equal(again.baseline.reused, true);
  assert.equal(again.baseline.measuredAt, run.baseline.measuredAt);
  assert.equal(server.state.calls - calls, 2, 'no new solo requests');
});

test('S1b: the KV-cache tile shows the peak during the run, not the idle last sample', async t => {
  const holder = {};
  const metrics = () => `vllm:kv_cache_usage_perc ${holder.server?.state.active ? 0.7 : 0}
`;
  holder.server = await fakeModelServer(t, { model: 'm', metrics, delayMs: 1200 });
  const swarm = createSwarm({ env: { SWARM_URLS: holder.server.url, SWARM_BASELINE_RUNS: '1' } });
  const { id } = swarm.start({ agents: 1, mode: 'live' });
  const run = await until(() => (swarm.snapshot(id).state === 'done' ? swarm.snapshot(id) : null), 20_000);
  assert.equal(run.metrics.kvCacheUsage, 0, 'the last sample, after the agent, is idle');
  assert.equal(run.metrics.kvCachePeak, 0.7, 'the peak is the highest sample during the run');
});

test('S1b: if the solo baseline fails the run still goes on, with no speed-up', async t => {
  const server = await fakeModelServer(t, { model: 'm', failFor: new Set([1]) });
  const swarm = createSwarm({ env: { SWARM_URLS: server.url } });
  const { id } = swarm.start({ agents: 3, mode: 'live' });
  const run = await until(() => (swarm.snapshot(id).state === 'done' ? swarm.snapshot(id) : null));
  assert.equal(run.baseline, null);
  assert.equal(run.oneAfterAnotherMs, null);
  assert.equal(run.speedup, null);
  assert.equal(run.counts.finished, 3);
  assert.equal(run.counts.failed, 1, 'agent 1 uses the same report and fails too');
  assert.equal(run.tokensOut, 2 * 40, 'baseline requests add no tokens');
});

async function startServer(t, env = {}) {
  const { spawn } = await import('node:child_process');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'ledger-s1-'));
  const child = spawn(process.execPath, ['src/server.mjs'], {
    env: { ...process.env, PORT: '0', CONTEXT_LEDGER_DB: join(dir, 'ledger.sqlite'), SWARM_SIM_SCALE: '0.002', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    child.kill();
    await new Promise(resolve => child.once('exit', resolve));
    await rm(dir, { recursive: true, force: true });
  });
  let output = '';
  for await (const chunk of child.stdout) {
    output += chunk;
    const match = output.match(/listening at http:\/\/127\.0\.0\.1:(\d+)/u);
    if (match) {
      const database = join(dir, 'ledger.sqlite');
      return { origin: `http://127.0.0.1:${match[1]}`, auth: bearer(await ledgerToken(database, Number(match[1]))) };
    }
  }
  throw new Error('server did not start');
}

test('the swarm routes need the token, check the origin and serve snapshots', async t => {
  const { origin, auth } = await startServer(t);
  const post = (body, headers = {}) => fetch(`${origin}/api/swarm/runs`, { method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json', Origin: origin, ...headers }, body: JSON.stringify(body) });

  assert.equal((await fetch(`${origin}/api/swarm`)).status, 401);
  const config = await (await fetch(`${origin}/api/swarm`, { headers: auth })).json();
  assert.equal(config.live, false);
  assert.equal((await post({ agents: 5, mode: 'simulated' }, { Origin: 'http://evil.test' })).status, 403);
  assert.equal((await post({ agents: 500, mode: 'simulated' })).status, 400);
  assert.equal((await post({ agents: 5, mode: 'live' })).status, 400, 'no model server configured');

  const started = await post({ agents: 12, mode: 'simulated' });
  assert.equal(started.status, 200);
  const { run: { id } } = await started.json();
  let run;
  for (let i = 0; i < 200; i += 1) {
    run = (await (await fetch(`${origin}/api/swarm/runs/${id}`, { headers: auth })).json()).run;
    if (run.state === 'done') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(run.state, 'done');
  assert.equal(run.agents.length, 12);
  assert.equal((await fetch(`${origin}/api/swarm/runs/${'0'.repeat(64)}`, { headers: auth })).status, 404);
  assert.equal((await fetch(`${origin}/api/swarm/runs/${id}`)).status, 401);
  for (const path of ['/swarm/', '/swarm/swarm.mjs', '/swarm/swarm.css']) assert.equal((await fetch(origin + path)).status, 200, path);
  assert.equal((await fetch(`${origin}/swarm/other.mjs`)).status, 401, 'only the listed files are open');
});

test('a server started with a non-local model URL refuses to start', async t => {
  const { spawn } = await import('node:child_process');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'ledger-s1-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const child = spawn(process.execPath, ['src/server.mjs'], {
    env: { ...process.env, PORT: '0', CONTEXT_LEDGER_DB: join(dir, 'ledger.sqlite'), SWARM_URLS: 'http://example.com/v1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  const code = await new Promise(resolve => child.once('exit', resolve));
  assert.equal(code, 1);
  assert.match(errors, /SWARM_URLS must hold/u);
});
