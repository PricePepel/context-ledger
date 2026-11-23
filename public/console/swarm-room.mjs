// Card U7: the swarm room. A third room in the console runs the local swarm through the
// same endpoints as /swarm/ (GET /api/swarm, POST /api/swarm/runs, GET /api/swarm/runs/:id)
// and shows one pixel agent per swarm agent, coloured by state. It never computes a
// speed-up of its own: it shows the server's, and only for a live run. Every string from a
// model or a report is set with textContent.
export const pollMs = 250;
const maxPollFailures = 20;
export const defaultAgents = 100;

/** The colour bucket of one swarm agent: done splits by whether its quote was found. */
export function agentBucket(agent) {
  const state = agent?.state;
  if (state === 'queued' || state === 'running' || state === 'failed') return state;
  if (state === 'done') return agent.verified === true ? 'verified' : 'dropped';
  return 'unknown';
}

const seconds = ms => (Number.isFinite(ms) && ms >= 0 ? `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s` : '—');
const count = value => (Number.isSafeInteger(value) && value >= 0 ? value : 0);

/** What the room shows for one run snapshot. Pure, so node:test can check it. */
export function swarmSummary(run) {
  const agents = Array.isArray(run?.agents) ? run.agents : [];
  const buckets = { queued: 0, running: 0, verified: 0, dropped: 0, failed: 0, unknown: 0 };
  for (const agent of agents) buckets[agentBucket(agent)] += 1;
  const simulated = run?.simulated !== false;
  const models = Array.isArray(run?.models) ? run.models.filter(model => typeof model === 'string') : [];
  const speedup = !simulated && Number.isFinite(run?.speedup) && run.speedup > 0 ? `about ${Math.round(run.speedup)}×` : 'not measured';
  const counts = run?.counts ?? {};
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
    state: typeof run?.state === 'string' ? run.state : 'unknown',
  };
}

async function defaultApi(path, init = {}) {
  const response = await fetch(path, { ...init, signal: AbortSignal.timeout(5000), headers: { Accept: 'application/json', ...(init.headers ?? {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(typeof body.error === 'string' ? body.error : `Request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return body;
}

const labels = { queued: 'queued', running: 'working', verified: 'answer checked', dropped: 'quote not found, left out', failed: 'failed', unknown: 'unknown' };

export function createSwarmRoom(root, { api = defaultApi, agents = defaultAgents } = {}) {
  const $ = id => root.querySelector(`#${id}`);
  const grid = $('swarm-grid');
  const status = $('swarm-status');
  const mode = $('swarm-mode');
  const run = $('swarm-run');
  const stats = $('swarm-stats');
  let liveOffered = false;
  let timer = null;
  let tiles = [];

  const setStatus = text => { status.textContent = text; };

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
    const list = Array.isArray(snapshot?.agents) ? snapshot.agents : [];
    if (tiles.length !== list.length) {
      tiles = list.map(() => document.createElement('li'));
      grid.replaceChildren(...tiles);
    }
    list.forEach((agent, index) => {
      const bucket = agentBucket(agent);
      const tile = tiles[index];
      tile.dataset.state = bucket;
      tile.title = `Agent ${Number.isSafeInteger(agent?.id) ? agent.id : index + 1}: ${labels[bucket]}`;
    });
    grid.setAttribute('aria-label', `Swarm agents: ${summary.buckets.verified} checked, ${summary.buckets.running} working, ` +
      `${summary.buckets.queued} queued, ${summary.buckets.dropped} left out, ${summary.buckets.failed} failed`);
    stats.replaceChildren(
      stat('Agents finished', summary.finished),
      stat('Wall time', summary.wall),
      stat('Speed-up', summary.speedup),
      stat('Quotes verified', summary.verified),
      stat('Answers correct', summary.correct),
    );
    return summary;
  }

  async function poll(id, failures = 0) {
    try {
      const { run: snapshot } = await api(`/api/swarm/runs/${encodeURIComponent(id)}`);
      const summary = render(snapshot);
      if (snapshot?.phase === 'baseline') setStatus('Timing one agent alone first, for an honest speed-up…');
      else if (summary.state === 'running' || summary.state === 'starting') setStatus(`Running ${summary.total} agents…`);
      if (summary.state === 'done' || summary.state === 'failed') {
        run.disabled = false;
        setStatus(summary.state === 'done'
          ? `Done: ${summary.total} agents in ${summary.wall}. Open the swarm page to see each agent's proof.`
          : (typeof snapshot?.error === 'string' ? snapshot.error : 'The run failed.'));
        return;
      }
      failures = 0;
    } catch (error) {
      if (error.status === 404 || failures + 1 >= maxPollFailures) {
        run.disabled = false;
        setStatus(error.status === 404 ? 'This run is no longer kept by the ledger. Run again.' : `Lost contact with the ledger: ${error.message}`);
        return;
      }
      failures += 1;
    }
    timer = setTimeout(() => poll(id, failures), pollMs);
  }

  run.addEventListener('click', async () => {
    clearTimeout(timer);
    run.disabled = true;
    setStatus(`Starting ${agents} agents…`);
    try {
      const { run: started } = await api('/api/swarm/runs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agents, mode: liveOffered ? 'live' : 'simulated' }),
      });
      render(started);
      poll(started.id);
    } catch (error) {
      run.disabled = false;
      setStatus(error.message);
    }
  });

  (async () => {
    try {
      const config = await api('/api/swarm');
      liveOffered = config?.live === true;
      if (liveOffered) {
        const models = Array.isArray(config.models) ? config.models.filter(model => typeof model === 'string') : [];
        mode.textContent = `Live: ${models.join(', ') || 'model server'}`;
        mode.dataset.mode = 'live';
        setStatus(`Runs ${agents} agents on this machine's GPU, each checked against its source.`);
      } else {
        mode.textContent = 'Simulated';
        mode.dataset.mode = 'simulated';
        setStatus('No model server is running, so a run is simulated: it shows the flow, and its timings are made up.');
      }
    } catch (error) {
      mode.textContent = 'Simulated';
      mode.dataset.mode = 'simulated';
      setStatus(error.message);
    }
  })();

  return { render, stop: () => clearTimeout(timer) };
}
