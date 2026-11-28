// Card U7: the swarm room. A third room in the console runs the local swarm through the
// same endpoints as /swarm/ (GET /api/swarm, POST /api/swarm/runs, GET /api/swarm/runs/:id)
// and shows one pixel agent per swarm agent, coloured by state. It never computes a
// speed-up of its own: it shows the server's, and only for a live run. Every string from a
// model or a report is set with textContent.
import { swarmAgentSvg } from './swarm-agent.mjs';

export const pollMs = 250;
const maxPollFailures = 20;
export const defaultAgents = 100;
const runStates = new Set(['starting', 'running', 'done', 'failed']);
const runId = /^[a-f0-9]{64}$/u;

/** The colour bucket of one swarm agent: done splits by whether its quote was found. */
export function agentBucket(agent) {
  const state = agent?.state;
  if (state === 'queued' || state === 'running' || state === 'failed') return state;
  if (state === 'done') return agent.verified === true ? 'verified' : 'dropped';
  return 'unknown';
}

const seconds = ms => (Number.isFinite(ms) && ms >= 0 ? `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s` : '—');
const count = value => (Number.isSafeInteger(value) && value >= 0 ? value : 0);
// Below 10× one decimal, so a slowdown such as 0.4× is never shown as 0× or 1×.
const ratio = value => (value < 10 ? value.toFixed(1) : String(Math.round(value)));

/** A run snapshot the room can draw: an object with an agents array and a known state. */
export function isRunSnapshot(run) {
  return Boolean(run) && typeof run === 'object' && Array.isArray(run.agents) && runStates.has(run.state);
}

/** What the room shows for one run snapshot. Pure, so node:test can check it. */
export function swarmSummary(run) {
  const agents = Array.isArray(run?.agents) ? run.agents : [];
  const buckets = { queued: 0, running: 0, verified: 0, dropped: 0, failed: 0, unknown: 0 };
  for (const agent of agents) buckets[agentBucket(agent)] += 1;
  const simulated = run?.simulated !== false;
  const models = Array.isArray(run?.models) ? run.models.filter(model => typeof model === 'string') : [];
  const speedup = !simulated && Number.isFinite(run?.speedup) && run.speedup > 0 ? `about ${ratio(run.speedup)}×` : 'not measured';
  const counts = run?.counts ?? {};
  const unknown = buckets.unknown ? `, ${buckets.unknown} unknown` : '';
  return {
    total: agents.length,
    buckets,
    simulated,
    mode: simulated ? 'Simulated' : `Live: ${models.join(', ') || 'model server'}`,
    wall: `${seconds(run?.elapsedMs)}${simulated ? ' (simulated)' : ''}`,
    speedup,
    finished: `${count(counts.finished)} / ${count(counts.total) || agents.length}`,
    verified: `${count(counts.verified)} / ${count(counts.finished)}`,
    correct: `${count(counts.correct)} / ${count(counts.finished)}`,
    // The same counts as the colours, in words, for touch, keyboard and screen readers.
    tally: `${buckets.verified} checked, ${buckets.running} working, ${buckets.queued} queued, ${buckets.dropped} left out, ${buckets.failed} failed${unknown}`,
    state: typeof run?.state === 'string' ? run.state : 'unknown',
  };
}

async function defaultApi(path, init = {}) {
  // Card P1f: the browser's session secret from /console/session.js goes in a header,
  // never a cookie; after a 401 it is forgotten, unless another tab stored a newer one.
  const session = globalThis.ledgerSession;
  const base = { Accept: 'application/json', ...(init.headers ?? {}) };
  const headers = session ? session.headers(base) : base;
  const response = await fetch(path, { ...init, signal: AbortSignal.timeout(5000), headers });
  if (response.status === 401) await session?.forget(headers);
  let body;
  try { body = await response.json(); } catch { body = undefined; }
  if (!response.ok) {
    const error = new Error(typeof body?.error === 'string' ? body.error : `Request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  if (!body || typeof body !== 'object') throw new Error('The ledger sent a response that is not JSON.');
  return body;
}

const labels = { queued: 'queued', running: 'working', verified: 'answer checked', dropped: 'quote not found, left out', failed: 'failed', unknown: 'unknown' };

export function createSwarmRoom(root, { api = defaultApi, agents = defaultAgents } = {}) {
  const $ = id => root.querySelector(`#${id}`);
  const grid = $('swarm-grid');
  const status = $('swarm-status');
  const tally = $('swarm-tally');
  const mode = $('swarm-mode');
  const run = $('swarm-run');
  const open = $('swarm-open');
  const stats = $('swarm-stats');
  let liveOffered = false;
  let timer = null;
  let tiles = [];

  const setStatus = text => { status.textContent = text; };
  // Run stays off until the server has said which mode it offers.
  run.disabled = true;

  function stat(label, value) {
    const box = document.createElement('div');
    const term = document.createElement('dt');
    const detail = document.createElement('dd');
    term.textContent = label;
    detail.textContent = value;
    box.append(term, detail);
    return box;
  }

  function render(snapshot) {
    const summary = swarmSummary(snapshot);
    mode.textContent = summary.mode;
    mode.dataset.mode = summary.simulated ? 'simulated' : 'live';
    root.dataset.runState = summary.state;
    const list = snapshot.agents;
    if (tiles.length !== list.length) {
      tiles = list.map(() => { const tile = document.createElement('li'); tile.append(swarmAgentSvg()); return tile; });
      grid.replaceChildren(...tiles);
    }
    list.forEach((agent, index) => {
      const bucket = agentBucket(agent);
      const tile = tiles[index];
      tile.dataset.state = bucket;
      tile.title = `Agent ${Number.isSafeInteger(agent?.id) ? agent.id : index + 1}: ${labels[bucket]}`;
    });
    grid.setAttribute('aria-label', `Swarm agents: ${summary.tally}`);
    tally.textContent = summary.tally;
    stats.replaceChildren(
      stat('Agents finished', summary.finished),
      stat('Wall time', summary.wall),
      stat('Speed-up', summary.speedup),
      stat('Quotes verified', summary.verified),
      stat('Answers correct', summary.correct),
    );
    return summary;
  }

  const stop = message => {
    run.disabled = false;
    setStatus(message);
  };

  async function poll(id, failures = 0) {
    try {
      const body = await api(`/api/swarm/runs/${id}`);
      // A malformed answer counts as a failure, so the bounded retry below still ends.
      if (!isRunSnapshot(body.run)) throw new Error('The ledger sent a swarm run it could not read.');
      const snapshot = body.run;
      const summary = render(snapshot);
      if (summary.state === 'done') return stop(`Done: ${summary.total} agents in ${summary.wall}. Open the swarm page to see each agent's proof.`);
      if (summary.state === 'failed') return stop(typeof snapshot.error === 'string' ? snapshot.error : 'The run failed.');
      setStatus(snapshot.phase === 'baseline' ? 'Timing one agent alone first, for an honest speed-up…' : `Running ${summary.total} agents…`);
      failures = 0;
    } catch (error) {
      if (error.status === 404) return stop('This run is no longer kept by the ledger. Run again.');
      if (failures + 1 >= maxPollFailures) return stop(`Lost contact with the ledger: ${error.message}`);
      failures += 1;
    }
    timer = setTimeout(() => poll(id, failures), pollMs);
  }

  run.addEventListener('click', async () => {
    clearTimeout(timer);
    run.disabled = true;
    setStatus(`Starting ${agents} agents…`);
    try {
      const body = await api('/api/swarm/runs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agents, mode: liveOffered ? 'live' : 'simulated' }),
      });
      const id = body.run?.id;
      if (typeof id !== 'string' || !runId.test(id)) throw new Error('The ledger did not return a run ID.');
      // The swarm page opens this same run, with each agent's report and proof.
      open.href = `/swarm/#run=${id}`;
      poll(id);
    } catch (error) {
      stop(error.message);
    }
  });

  (async () => {
    try {
      const config = await api('/api/swarm');
      liveOffered = config.live === true;
      if (liveOffered) {
        const models = Array.isArray(config.models) ? config.models.filter(model => typeof model === 'string') : [];
        mode.textContent = `Live: ${models.join(', ') || 'model server'}`;
        mode.dataset.mode = 'live';
        setStatus(`Runs ${agents} agents on this machine's GPU, each checked against its source.`);
      } else {
        mode.textContent = 'Simulated';
        mode.dataset.mode = 'simulated';
        // Card U11: the server's own reason names the address it tried and how to go live.
        const reason = typeof config.reason === 'string' && config.reason.length <= 300 ? config.reason : 'No model server is running.';
        setStatus(`${reason} Until then a run is simulated: it shows the flow, and its timings are made up.`);
      }
    } catch (error) {
      mode.textContent = 'Simulated';
      mode.dataset.mode = 'simulated';
      setStatus(`Could not ask the ledger for a model server (${error.message}), so a run is simulated.`);
    }
    run.disabled = false;
  })();

  return { render, stop: () => clearTimeout(timer) };
}
