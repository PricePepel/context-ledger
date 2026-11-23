// Card S1: the swarm demo page. Every string from a report or a model is set with
// textContent; nothing here builds HTML from data.
import { swarmAgentSvg } from '/console/swarm-agent.mjs';

const pollMs = 250;
const $ = id => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'text') node.textContent = value;
    else if (key === 'class') node.className = value;
    else if (key.startsWith('data-') || key.startsWith('aria-') || key === 'role' || key === 'type') node.setAttribute(key, value);
    else node[key] = value;
  }
  node.append(...children);
  return node;
};

let current = null;
let selected = null;
let timer = null;
const tiles = new Map();

async function api(path, init = {}) {
  // Round 2: a deadline covers the whole response, so a stalled poll counts as a failure.
  const response = await fetch(path, { ...init, signal: AbortSignal.timeout(5000), headers: { Accept: 'application/json', ...(init.headers ?? {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error ?? `Request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return body;
}

const seconds = ms => (ms === null || ms === undefined ? '—' : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`);
const percent = value => (value === null || value === undefined ? 'not reported' : `${Math.round(value * 100)}%`);

function setStatus(text) { $('status').textContent = text; }

async function loadConfig() {
  try {
    const config = await api('/api/swarm');
    const live = $('mode-live');
    live.disabled = !config.live;
    if (config.live) {
      live.checked = true;
      $('mode-badge').textContent = `Live: ${config.models.join(', ')}`;
      $('mode-badge').dataset.mode = 'live';
      setStatus(`Up to ${config.concurrency} agents run at the same moment.`);
      $('runs-on').textContent = runsOn({ simulated: false, models: config.models, concurrency: config.concurrency });
    } else {
      $('mode-simulated').checked = true;
      $('mode-badge').textContent = 'No GPU models';
      $('live-reason').hidden = false;
      $('live-reason').textContent = `${config.reason} The simulation runs without a GPU; its timings are made up.`;
      $('runs-on').textContent = runsOn({ simulated: true, models: [] });
    }
  } catch (error) {
    $('mode-simulated').checked = true;
    $('mode-live').disabled = true;
    setStatus(error.message);
  }
}

/** What the page says the swarm runs on: the model server's models, or that it is simulated. */
function runsOn({ simulated, models, concurrency }) {
  if (simulated) return 'Runs on: nothing real. A simulated run has no model server, and its timings are made up.';
  const names = models.length ? models.join(', ') : 'the model server';
  return `Runs on: ${names}, served on this machine's GPU by an OpenAI-compatible server (vLLM)${concurrency ? `, up to ${concurrency} agents at the same moment` : ''}. Every agent shares the same instructions, so the server stores them once.`;
}

// Card U8: the dataset and the task, before any run. Report texts only; the generator's
// truth stays on the server until a run is scored.
let task = null;
function renderDataset() {
  if (!task) return;
  const agents = Number($('agents').value);
  $('dataset-note').textContent = `${agents} incident reports, one per agent. They are synthetic: made on this machine from a fixed seed (${task.seed}), so every run reads the same reports and nothing real is used. The first ${task.sample.length}:`;
}
async function loadTask() {
  try {
    const body = await api('/api/swarm/task');
    if (!Array.isArray(body.sample) || typeof body.instructions !== 'string') throw new Error('The ledger sent no task.');
    task = { seed: Number.isSafeInteger(body.seed) ? body.seed : 0, sample: body.sample.filter(report => typeof report?.text === 'string').slice(0, 5) };
    $('dataset-sample').replaceChildren(...task.sample.map(report => el('li', {},
      el('span', { class: 'report-no', text: `Report ${Number.isSafeInteger(report.id) ? report.id : ''}` }), document.createTextNode(report.text))));
    $('task-text').textContent = body.instructions;
    renderDataset();
  } catch (error) {
    $('dataset-note').textContent = `The reports could not be loaded: ${error.message}`;
  }
}

function modelIndex(run, model) {
  const index = run.models.indexOf(model);
  return index < 0 ? 0 : index % 4;
}

function renderLegend(run) {
  const items = run.models.map((model, index) => el('li', {},
    el('span', { class: 'swatch', 'data-model': String(index % 4) }), document.createTextNode(model)));
  items.push(el('li', {}, el('span', { class: 'swatch swatch-unverified' }), document.createTextNode('quote not found in report')));
  $('legend').replaceChildren(...items);
}

function renderGrid(run) {
  if (tiles.size !== run.agents.length) {
    tiles.clear();
    $('grid').replaceChildren(...run.agents.map(agent => {
      const tile = el('button', { class: 'tile', type: 'button', role: 'listitem', 'aria-pressed': 'false' }, swarmAgentSvg(), el('span', { text: String(agent.id) }));
      tile.addEventListener('click', () => { selected = agent.id; render(current); });
      tiles.set(agent.id, tile);
      return tile;
    }));
  }
  for (const agent of run.agents) {
    const tile = tiles.get(agent.id);
    tile.dataset.state = agent.state;
    tile.dataset.model = String(modelIndex(run, agent.model));
    tile.dataset.verified = String(agent.verified);
    tile.setAttribute('aria-pressed', String(agent.id === selected));
    tile.setAttribute('aria-label', `Agent ${agent.id}, ${agent.state}${agent.state === 'done' ? (agent.verified ? ', quote verified' : ', quote not found') : ''}`);
  }
}

function stat(label, value, note, simulated) {
  return el('div', { class: 'stat', 'data-simulated': String(Boolean(simulated)) },
    el('dt', { text: label }), el('dd', { text: value }), ...(note ? [el('dd', { class: 'note', text: note })] : []));
}

function renderStats(run) {
  const sim = run.simulated;
  // Card S1b: the speed-up is wall time against one agent run alone on each server
  // (measured by the ledger before the agents start), never the agents' own times under load.
  const solo = run.baseline?.perServer ?? [];
  const measured = run.baseline?.measuredAt ? new Date(run.baseline.measuredAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  const soloNote = solo.length
    ? `${solo.map(entry => `${entry.answered} × ${seconds(entry.ms)}${solo.length > 1 ? ` (${entry.model})` : ''}`).join(' + ')} per agent alone, warm (median of ${run.baseline.runs}, ${run.baseline.reused ? 'reused from' : 'measured at'} ${measured})`
    : 'one agent alone was not timed';
  const tokensPerSecond = run.elapsedMs > 0 ? run.tokensOut / (run.elapsedMs / 1000) : null;
  const metrics = run.metrics;
  $('stats').replaceChildren(
    stat('Agents finished', `${run.counts.finished} / ${run.counts.total}`, `${run.counts.running} running now`),
    stat('Wall time', seconds(run.elapsedMs), 'start to last answer', sim),
    stat('One after another', sim || run.oneAfterAnotherMs === null ? 'not measured' : seconds(run.oneAfterAnotherMs), sim ? 'simulated run' : soloNote),
    stat('Speed-up', sim || !run.speedup ? 'not measured' : `${run.speedup.toFixed(1)}×`, sim ? 'simulated run' : 'one after another ÷ wall time'),
    stat('Tokens out per second', tokensPerSecond ? Math.round(tokensPerSecond).toLocaleString() : '—', `${run.tokensIn.toLocaleString()} in, ${run.tokensOut.toLocaleString()} out`, sim),
    stat('Requests on the server', sim ? 'not measured' : (metrics?.requestsRunning ?? 'not reported').toLocaleString(), sim ? 'simulated run' : 'running now, from the model server'),
    stat('KV cache peak', sim ? 'not measured' : percent(metrics?.kvCachePeak), sim ? 'simulated run' : 'highest sample during the run'),
    stat('Prefix-cache hits', sim ? 'not measured' : percent(metrics?.prefixCacheHitRate), sim ? 'simulated run' : (metrics?.stale ? 'last sample before the end' : 'shared instructions reused')),
    stat('Quotes verified', `${run.counts.verified} / ${run.counts.finished}`, 'quote found in its report'),
    stat('Answers correct', `${run.counts.correct} / ${run.counts.finished}`, 'checked against the generator'),
  );
}

/** The states in words and the check's counts, so nothing is told by colour alone. */
function renderCheck(run) {
  const done = run.agents.filter(agent => agent.state === 'done');
  const checked = done.filter(agent => agent.verified).length;
  const leftOut = done.length - checked;
  const working = run.agents.filter(agent => agent.state === 'running').length;
  const queued = run.agents.filter(agent => agent.state === 'queued').length;
  $('tally').textContent = `${checked} checked, ${working} working, ${queued} queued, ${leftOut} left out, ${run.counts.failed} failed.`;
  const count = (label, value) => el('div', {}, el('dt', { text: label }), el('dd', { text: String(value) }));
  $('check-counts').replaceChildren(
    count('Quote found', checked), count('Left out', leftOut), count('Failed', run.counts.failed), count('Facts match the truth', run.counts.correct));
  $('runs-on').textContent = runsOn({ simulated: run.simulated, models: run.models, concurrency: run.concurrency });
}

function row(label, value, extra = {}) {
  return el('div', { class: 'answer-row' }, el('span', { class: 'label', text: label }), el('span', { class: 'value', text: value, ...extra }));
}

function renderAnswer(run) {
  if (!run.answer) {
    $('answer').replaceChildren(el('p', { class: 'hint', text: run.state === 'failed' ? (run.error ?? 'The run failed.') : 'Waiting for every agent…' }));
    return;
  }
  const { question, fromAgents, truth } = run.answer;
  // A match needs answers behind it: zero answers never "match" an empty truth.
  const match = fromAgents.answersUsed > 0 && fromAgents.incidents === truth.incidents
    && fromAgents.totalDowntimeMinutes === truth.totalDowntimeMinutes && fromAgents.services.join() === truth.services.join();
  $('answer').replaceChildren(el('div', { class: 'answer-rows' },
    el('p', { text: question }),
    row('Services (from verified answers)', fromAgents.services.join(', ') || 'none'),
    row('Total downtime', `${fromAgents.totalDowntimeMinutes} minutes over ${fromAgents.incidents} incidents`),
    row('Answers used', `${fromAgents.answersUsed} of ${run.counts.total} (unverified answers are left out)`),
    row('Truth from the generator', `${truth.totalDowntimeMinutes} minutes over ${truth.incidents} incidents: ${truth.services.join(', ') || 'none'}`),
    row('Combined answer matches the truth', match ? 'Yes' : 'No', { class: 'value match', 'data-match': String(match) }),
  ));
}

/** The report with the agent's quote marked, built from text nodes. */
function markedReport(report, quote) {
  const box = el('p', { class: 'report' });
  const at = quote ? report.indexOf(quote.trim()) : -1;
  if (at < 0) box.append(document.createTextNode(report));
  else box.append(document.createTextNode(report.slice(0, at)), el('mark', { text: quote.trim() }),
    document.createTextNode(report.slice(at + quote.trim().length)));
  return box;
}

function renderDetail(run) {
  const agent = run.agents.find(item => item.id === selected);
  if (!agent) {
    $('detail').replaceChildren(el('p', { class: 'hint', text: 'Pick an agent.' }));
    return;
  }
  const answer = agent.answer;
  const facts = answer ? [['Service', answer.service], ['Cause', answer.cause], ['Downtime', `${answer.downtimeMinutes ?? '—'} minutes`]] : [];
  $('detail').replaceChildren(
    el('h3', { text: `Agent ${agent.id}` }),
    el('p', { class: 'detail-meta' },
      el('span', { text: `Model: ${agent.model ?? '—'}` }), el('span', { text: `State: ${agent.state}` }),
      el('span', { text: `Time: ${seconds(agent.ms)}${run.simulated ? ' (simulated)' : ''}` }),
      el('span', { text: `Tokens: ${agent.tokensIn ?? '—'} in, ${agent.tokensOut ?? '—'} out${run.simulated ? ' (simulated)' : ''}` })),
    markedReport(agent.report, answer?.quote ?? ''),
    answer ? el('dl', { class: 'facts' }, ...facts.flatMap(([label, value]) => [el('dt', { text: label }), el('dd', { text: value })]),
      el('dt', { text: 'Quote' }), el('dd', { class: 'flag', 'data-ok': String(agent.verified), text: agent.verified ? 'Found in the report' : 'Not found in the report' }),
      el('dt', { text: 'Facts' }), el('dd', { class: 'flag', 'data-ok': String(agent.correct), text: agent.correct ? 'Match the truth' : 'Do not match the truth' }))
      : el('p', { class: 'hint', text: agent.error ?? (agent.state === 'done' ? 'The reply held no answer.' : 'No answer yet.') }),
  );
}

function render(run) {
  if (!run) return;
  $('mode-badge').textContent = run.simulated ? 'Simulated' : `Live: ${run.models.join(', ')}`;
  $('mode-badge').dataset.mode = run.simulated ? 'simulated' : 'live';
  document.body.dataset.runState = run.state;
  renderLegend(run);
  renderGrid(run);
  renderStats(run);
  renderCheck(run);
  renderAnswer(run);
  renderDetail(run);
}

const maxPollFailures = 20;

function doneMessage(run) {
  const failed = run.counts.failed ? `, ${run.counts.failed} failed` : '';
  return `Done: ${run.counts.total} agents in ${seconds(run.elapsedMs)}${run.simulated ? ' (simulated)' : ''}${failed}.`;
}

async function poll(id, failures = 0) {
  try {
    const { run } = await api(`/api/swarm/runs/${id}`);
    current = run;
    render(run);
    if (run.phase === 'baseline') setStatus('Timing one agent alone first, for an honest speed-up…');
    else if (run.state === 'running') setStatus(`Running ${run.counts.total} agents…`);
    if (run.state === 'done' || run.state === 'failed') {
      $('run').disabled = false;
      setStatus(run.state === 'done' ? doneMessage(run) : (run.error ?? 'The run failed.'));
      return;
    }
    failures = 0;
  } catch (error) {
    // A run the server no longer keeps, or a server that stopped answering: stop and let the person run again.
    if (error.status === 404 || failures + 1 >= maxPollFailures) {
      $('run').disabled = false;
      setStatus(error.status === 404 ? 'This run is no longer kept by the ledger. Run again.' : `Lost contact with the ledger: ${error.message}`);
      return;
    }
    failures += 1;
    setStatus(error.message);
  }
  timer = setTimeout(() => poll(id, failures), pollMs);
}

$('run-form').addEventListener('submit', async event => {
  event.preventDefault();
  clearTimeout(timer);
  const agents = Number($('agents').value);
  const mode = document.querySelector('input[name="mode"]:checked')?.value ?? 'simulated';
  $('run').disabled = true;
  selected = null;
  tiles.clear();
  setStatus(`Starting ${agents} agents…`);
  try {
    const { run } = await api('/api/swarm/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agents, mode }) });
    poll(run.id);
  } catch (error) {
    $('run').disabled = false;
    setStatus(error.message);
  }
});

loadConfig();
loadTask();
$('agents').addEventListener('change', renderDataset);

// Card U7: /swarm/#run=<id> opens a run started elsewhere (the console's swarm room).
const linked = /^#run=([a-f0-9]{64})$/u.exec(location.hash);
if (linked) {
  $('run').disabled = true;
  setStatus('Opening the run from the console…');
  poll(linked[1]);
}
