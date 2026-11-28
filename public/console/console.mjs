// CTM Console: wires the office, the ledger graph, the evidence panel, the activity
// feed with its counters and the CTM band to one source of published graphs. It only reads; see source.mjs.
import { createBrain } from './brain.mjs';
import { createBand } from './ctm-band.mjs';
import { createEvidence } from './evidence.mjs';
import { createModel } from './model.mjs';
import { createOffice, providerNames } from './office.mjs';
import { createPanels } from './panels.mjs';
import { demoSource, liveSource } from './source.mjs';
import { createSwarmRoom } from './swarm-room.mjs';

const params = new URLSearchParams(location.search);
const demo = params.has('demo');
const speed = Math.min(8, Math.max(0.25, Number(params.get('speed')) || 1));
const autoplay = params.get('autoplay') !== '0';
const workingMs = demo ? 6000 : 60_000;
const flashMs = 2400;

const $ = selector => document.querySelector(selector);
const status = $('#status');
const activity = $('#activity');
const replay = $('#replay');
const flashLayer = $('#flash-layer');
const svgNs = 'http://www.w3.org/2000/svg';
const numberFormat = new Intl.NumberFormat('en');

let model;
let source;
let evidence;
const office = createOffice($('#office'));
const brain = createBrain($('#brain'), { onSelect: select });
createBand($('.band'));
const panels = createPanels(document);
// Card U7: the local swarm in its own room; it asks the server nothing until Run but its mode.
// The demo is a recorded replay that makes no requests, so there the room is hidden.
if (demo) $('#swarm').hidden = true;
else createSwarmRoom($('#swarm'));

// Card P3: the reviewer prototype runs in demo mode only, on the synthetic recording.
// startDemo loads it, so live mode never fetches or runs the review code.
let reviewPanel = null;
let attachReviews = view => view;

/** The graph to draw, with each node's review attached in demo mode. */
const graphView = () => attachReviews(model.graph());

async function startReviews() {
  const { createReviewPanel, createReviews, withReviews } = await import('./review.mjs');
  let storage = null;
  try { storage = window.localStorage; } catch { /* blocked: reviews last for this session */ }
  const reviews = createReviews(storage);
  attachReviews = view => withReviews(view, reviews);
  reviewPanel = createReviewPanel($('#review'), { reviews, onChange: () => brain.render(graphView()) });
}

function partyName(key) {
  return model.graph().columns.find(column => column.key === key)?.label ?? key;
}

function center(element) {
  const box = element.getBoundingClientRect();
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
}

/** A short line from the agent's room to a node: solid for a write, dashed for a read. */
function flash(from, element, kind) {
  if (!element) return;
  const to = center(element);
  const line = document.createElementNS(svgNs, 'line');
  line.setAttribute('x1', String(from.x));
  line.setAttribute('y1', String(from.y));
  line.setAttribute('x2', String(to.x));
  line.setAttribute('y2', String(to.y));
  line.setAttribute('class', `flash-line flash-${kind}`);
  const dot = document.createElementNS(svgNs, 'circle');
  dot.setAttribute('cx', String(to.x));
  dot.setAttribute('cy', String(to.y));
  dot.setAttribute('r', '5');
  dot.setAttribute('class', `flash-dot flash-${kind}`);
  flashLayer.append(line, dot);
  setTimeout(() => { line.remove(); dot.remove(); }, flashMs);
}

// Newest first by publish time, so graphs read on first load slot in where they belong.
function logActivity(text, at = Date.now()) {
  const when = new Date(at);
  const item = document.createElement('li');
  item.dataset.at = String(at);
  const time = document.createElement('time');
  time.dateTime = when.toISOString();
  const clock = when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  time.textContent = when.toDateString() === new Date().toDateString()
    ? clock
    : `${when.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${clock}`;
  const body = document.createElement('span');
  body.textContent = text;
  item.append(time, body);
  const later = [...activity.children].find(other => Number(other.dataset.at) <= at);
  activity.insertBefore(item, later ?? null);
  while (activity.children.length > 30) activity.lastElementChild.remove();
}

function renderNumbers() {
  const numbers = model.numbers(Date.now());
  $('#n-handoffs').textContent = numberFormat.format(numbers.handoffs);
  $('#n-tokens').textContent = `≈ ${numberFormat.format(numbers.tokensSaved)}`;
  $('#n-tokens-note').textContent = numbers.metered
    ? `transcript vs graph briefing, characters ÷ 4, over ${numbers.metered} current ${numbers.metered === 1 ? 'graph' : 'graphs'}`
    : 'transcript vs graph briefing, characters ÷ 4';
  $('#n-superseded').textContent = numberFormat.format(numbers.superseded);
}

function renderOffice() {
  // Live, the office holds the parties that published today; the demo is all today.
  office.update(model.agents(Date.now(), { todayOnly: !demo }));
}

function onGraph(event, { initial }) {
  const moved = model.apply(event);
  const pop = initial ? new Set() : new Set(moved.added);
  const changed = initial ? new Set() : new Set(moved.changed);
  brain.render(graphView(), { pop, changed });
  renderOffice();
  renderNumbers();
  reconcileSelection(new Set(moved.changed));

  const name = partyName(moved.party);
  const where = providerNames[event.provider] ?? event.provider;
  const at = Number.isFinite(event.at) ? event.at : Date.now();
  const parts = [];
  if (moved.added.length) parts.push(`${moved.added.length} new`);
  if (moved.changed.length) parts.push(`${moved.changed.length} changed`);
  logActivity(`${name} (${where}) published${parts.length ? `: ${parts.join(', ')}` : ''}`, at);
  if (moved.read.length) {
    const readParties = [...new Set(moved.read.map(key => partyName(key.slice(0, key.lastIndexOf('/')))))];
    logActivity(`${name} linked to ${moved.read.length} ${moved.read.length === 1 ? 'node' : 'nodes'} of ${readParties.join(', ')}`, at);
  }
  if (initial) return;
  office.pulse(moved.party);
  // Wait one frame so the new buttons have their place before a line points at them.
  requestAnimationFrame(() => {
    const from = office.anchor(event.provider, moved.party);
    for (const key of [...moved.added, ...moved.changed]) flash(from, brain.element(key), 'write');
    for (const key of moved.read) flash(from, brain.element(key), 'read');
  });
}

let selectedKey = null;
let selectedSession = null;

async function select(key) {
  const found = model.node(key);
  if (!found) return;
  panels.show('evidence');
  selectedKey = key;
  selectedSession = found.entry.sessionId;
  brain.select(key);
  if (matchMedia('(max-width: 900px)').matches) $('#evidence').scrollIntoView({ block: 'start' });
  reviewPanel?.show(found);
  await evidence.show(found);
}

/** Keep the open proof in step with the graph: reread it if its node changed. */
function reconcileSelection(changed) {
  if (!selectedKey) return;
  const found = model.node(selectedKey);
  if (!found) {
    selectedKey = null;
    reviewPanel?.clear();
    evidence.clear('That node is no longer in the current graph of its agent.');
  } else {
    // A republish is a new snapshot, even with the node unchanged: the review follows it.
    reviewPanel?.show(found);
    if (changed.has(selectedKey) || found.entry.sessionId !== selectedSession) {
      // The node changed, or its agent now publishes from another transcript.
      selectedSession = found.entry.sessionId;
      brain.select(selectedKey);
      evidence.show(found);
    }
  }
}

/** Redraw after something other than a publish (a meter or a linked graph arrived). */
function refresh() {
  brain.render(graphView());
  renderOffice();
  renderNumbers();
}

function resetView() {
  model = createModel({ workingMs: workingMs / (demo ? speed : 1) });
  brain.render(graphView());
  reviewPanel?.clear();
  activity.replaceChildren();
  selectedKey = null;
  evidence?.clear();
  renderOffice();
  renderNumbers();
}

async function startDemo() {
  $('#mode').textContent = 'Demo';
  document.body.classList.add('is-demo');
  status.textContent = 'Loading the demo…';
  await startReviews();
  const recording = await (await fetch('/console/demo-recording.json')).json();
  let clock;
  const play = () => {
    source?.stop();
    clearInterval(clock);
    resetView();
    replay.textContent = 'Replay demo';
    document.body.dataset.demo = 'playing';
    source = demoSource(recording, {
      speed,
      onGraph,
      onDone() {
        clearInterval(clock);
        document.body.dataset.demo = 'finished';
        status.textContent = 'Demo finished. Click a node to see its proof, or replay.';
        renderOffice();
      },
    });
    evidence = createEvidence($('#evidence'), { loadSession: id => source.session(id) });
    source.start();
    const total = Math.round(recording.durationMs / 1000);
    clock = setInterval(() => {
      status.textContent = `Demo: two agents, synthetic transcripts · ${Math.round(source.elapsed() / 1000)} s of ${total} s`;
      renderOffice();
    }, 500);
  };
  replay.hidden = false;
  replay.addEventListener('click', play);
  if (autoplay) play();
  else {
    resetView();
    evidence = createEvidence($('#evidence'), { loadSession: id => source?.session(id) });
    document.body.dataset.demo = 'ready';
    replay.textContent = 'Play demo';
    status.textContent = 'Demo ready: two agents, synthetic transcripts.';
  }
}

function startLive() {
  resetView();
  source = liveSource({
    model,
    onGraph,
    onNote(row, at) { model.noteSummary(row, at); renderNumbers(); },
    onMeter: renderNumbers,
    onLinked: refresh,
    onStatus(result) {
      status.textContent = result.ok
        ? `Live: watching the ledger, read ${new Date(result.at).toLocaleTimeString()}`
        : `Live: could not read the ledger (${result.message}). Retrying.`;
    },
  });
  evidence = createEvidence($('#evidence'), { loadSession: id => source.session(id) });
  source.start();
  // States age and the day can turn over with no new publish.
  setInterval(() => { renderOffice(); renderNumbers(); }, 1000);
}

if (demo) startDemo().catch(error => { status.textContent = `The demo could not load: ${error.message}`; });
else startLive();
