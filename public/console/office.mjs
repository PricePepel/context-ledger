// CTM Console office: one furnished top-down room per agent source (card U4b), and one
// pixel character per active agent party. Working agents sit at their desk with the
// monitor lit, waiting agents stand beside it with a "?" bubble, idle agents go to the
// lounge. CSP-safe: every node is built with createElementNS, text goes through
// textContent, and positions use SVG attributes or CSSOM (never a style attribute).
import { accessoryPixels, roleOf, spriteKey, spriteMark, spritePixels } from './sprites.mjs';
import { DESKS, ROOM_H, ROOM_W, besideDesk, drawRoom, el, loungeSpot, seatAt } from './office-furniture.mjs';

export const providers = ['claude', 'codex'];
export const providerNames = { claude: 'Claude Code', codex: 'Codex' };

const RANK = { waiting: 0, working: 1, idle: 2 };
const MAX = DESKS;
const LABEL_MAX = 12;
const ELLIPSIS = String.fromCodePoint(0x2026);
const NARROW_BELOW = 560;
const GAP = 10;
const LAYOUT = {
  wide: { box: `0 0 ${ROOM_W * 2 + GAP} ${ROOM_H}`, at: [[0, 0], [ROOM_W + GAP, 0]] },
  narrow: { box: `0 0 ${ROOM_W} ${ROOM_H * 2 + GAP}`, at: [[0, 0], [0, ROOM_H + GAP]] }
};

// Labels are untrusted: drop control and format characters (bidi included), then clip.
function clean(value) {
  return String(value ?? '').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').replace(/\s+/g, ' ').trim();
}

function clip(value, max) {
  const chars = Array.from(value);
  return chars.length > max ? chars.slice(0, max - 1).join('') + ELLIPSIS : value;
}

function plural(n) {
  return `${n} agent${n === 1 ? '' : 's'}`;
}

/** Where an agent stands: seated at its desk, beside it, or at its lounge spot. */
export function spotFor(state, desk, loungeIndex) {
  if (state === 'working') return seatAt(desk);
  if (state === 'waiting') return besideDesk(desk);
  return loungeSpot(loungeIndex);
}

function buildRoom(parent, provider) {
  const name = providerNames[provider];
  const g = el('g', { class: `office-room office-room-${provider}`, 'data-provider': provider, role: 'group' }, parent);
  const header = el('g', { 'aria-hidden': 'true' }, g);
  el('text', { class: 'office-room-name', x: 6, y: 18 }, header, name);
  const count = el('text', { class: 'office-room-count', x: ROOM_W - 6, y: 18, 'text-anchor': 'end' }, header);
  const more = el('g', { class: 'office-more', transform: `translate(${ROOM_W - 84} 13)` }, header);
  el('rect', { x: -16, y: -9, width: 32, height: 17, rx: 8.5 }, more);
  const moreText = el('text', { y: 4, 'text-anchor': 'middle' }, more);
  const layers = drawRoom(g, provider);
  el('text', { class: 'office-empty', x: 151, y: 152, 'text-anchor': 'middle', 'aria-hidden': 'true' }, layers.labels, 'no agent yet');
  return { provider, name, g, count, more, moreText, ...layers, deskOf: new Map() };
}

// One grid cell of a sprite in SVG units: the 16 x 20 grid stands 40 units tall.
const PX = 2;

function buildAgent(provider, role) {
  const g = el('g', { class: 'office-agent', role: 'img', 'data-sprite': spriteKey(provider), 'data-role': role || 'none' });
  el('circle', { class: 'oa-ring', cx: 0, cy: -20, r: 24 }, g);
  el('ellipse', { class: 'oa-shadow', cx: 0, cy: 0, rx: 11, ry: 3 }, g);
  const fig = el('g', { class: 'oa-fig' }, g);
  const sprite = el('g', { class: 'oa-sprite', transform: `translate(${-8 * PX} ${-19 * PX})`, 'shape-rendering': 'crispEdges' }, fig);
  for (const [x, y, width, height, fill] of [...spritePixels(provider), ...accessoryPixels(provider, role)]) {
    el('rect', { x: x * PX, y: y * PX, width: width * PX, height: height * PX, fill }, sprite);
  }
  const mark = spriteMark(provider);
  if (mark) {
    const face = el('g', { class: 'oa-mark', transform: `translate(${mark.x * PX} ${mark.y * PX}) scale(${mark.scale * PX})`, 'shape-rendering': 'geometricPrecision' }, sprite);
    for (const d of mark.paths) el('path', { d, fill: mark.fill }, face);
  }
  const bubble = el('g', { class: 'oa-bubble' }, g);
  el('rect', { x: 4, y: -58, width: 17, height: 15, rx: 6 }, bubble);
  el('path', { d: 'M7.5 -43.5l-3 5.5 7.5-5.5z' }, bubble);
  el('text', { class: 'oa-q', x: 12.5, y: -46.5, 'text-anchor': 'middle' }, bubble, '?');
  const tag = el('g', { class: 'oa-tag' });
  const name = el('text', { class: 'oa-name', y: 12, 'text-anchor': 'middle' }, tag);
  const state = el('text', { class: 'oa-state', y: 21, 'text-anchor': 'middle' }, tag);
  return { g, fig, tag, name, state, role, timer: 0, enter: 0 };
}

function centre(node) {
  const r = node.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

function restartClass(node, name, ms, holder) {
  clearTimeout(holder.timer);
  node.classList.remove(name);
  node.getBoundingClientRect();
  node.classList.add(name);
  holder.timer = setTimeout(() => node.classList.remove(name), ms);
}

// A newcomer appears at its spot; only later moves slide, so nobody flies in from the room's corner.
function moveTo(item, [x, y]) {
  const first = !item.placed;
  for (const node of [item.g, item.tag]) {
    if (first) node.style.setProperty('transition', 'none');
    node.style.setProperty('transform', `translate(${x}px, ${y}px)`);
  }
  if (!first) return;
  item.placed = true;
  item.g.getBoundingClientRect();
  for (const node of [item.g, item.tag]) node.style.removeProperty('transition');
}

// Keep each agent at the desk it already has; give newcomers the lowest free desk.
function assignDesks(room, shown) {
  const keys = new Set(shown.map(a => a.key));
  for (const key of room.deskOf.keys()) if (!keys.has(key)) room.deskOf.delete(key);
  const taken = new Set(room.deskOf.values());
  for (const a of shown) {
    if (room.deskOf.has(a.key)) continue;
    let desk = 0;
    while (taken.has(desk)) desk += 1;
    taken.add(desk);
    room.deskOf.set(a.key, desk);
  }
}

const observers = new WeakMap();

export function createOffice(svg) {
  observers.get(svg)?.disconnect();
  svg.replaceChildren();
  svg.classList.add('office-svg');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  const rooms = {};
  for (const p of providers) rooms[p] = buildRoom(svg, p);
  const agents = new Map();
  const hidden = new Map();
  const roomTimers = {};
  let mode = '';

  function layout(width) {
    const next = width > 0 && width < NARROW_BELOW ? 'narrow' : 'wide';
    if (next === mode) return;
    mode = next;
    svg.setAttribute('viewBox', LAYOUT[mode].box);
    svg.classList.toggle('is-narrow', mode === 'narrow');
    providers.forEach((p, i) => {
      const [x, y] = LAYOUT[mode].at[i];
      rooms[p].g.setAttribute('transform', `translate(${x} ${y})`);
    });
  }
  layout(svg.getBoundingClientRect().width);
  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver((entries) => layout(entries[0].contentRect.width));
    observer.observe(svg);
    observers.set(svg, observer);
  }

  function paint(item, a, provider) {
    const label = clip(a.label, LABEL_MAX);
    for (const s in RANK) {
      item.g.classList.toggle(`state-${s}`, s === a.state);
      item.tag.classList.toggle(`state-${s}`, s === a.state);
    }
    item.g.setAttribute('data-key', a.key);
    item.g.setAttribute('data-state', a.state);
    item.g.setAttribute('aria-label', `${clip(a.label, 48)}, ${providerNames[provider]}, ${a.state}`);
    if (item.name.textContent !== label) item.name.textContent = label;
    if (item.state.textContent !== a.state) item.state.textContent = a.state;
  }

  function remove(key, item) {
    clearTimeout(item.timer);
    clearTimeout(item.enter);
    item.g.remove();
    item.tag.remove();
    agents.delete(key);
  }

  function placeRoom(p, all) {
    const room = rooms[p];
    const shown = all.slice().sort((x, y) => RANK[x.state] - RANK[y.state] || x.i - y.i).slice(0, MAX);
    shown.sort((x, y) => x.i - y.i);
    for (const a of all) if (!shown.includes(a)) hidden.set(a.key, p);
    assignDesks(room, shown);
    const lit = new Set();
    let lounge = 0;
    for (const a of shown) {
      let item = agents.get(a.key);
      if (item && (item.provider !== p || item.role !== roleOf(a.label))) {
        remove(a.key, item);
        item = undefined;
      }
      const desk = room.deskOf.get(a.key);
      const spot = spotFor(a.state, desk, a.state === 'idle' ? lounge++ : 0);
      if (a.state === 'working') lit.add(desk);
      if (!item) {
        item = buildAgent(p, roleOf(a.label));
        item.provider = p;
        item.g.classList.add('is-new');
        const fresh = item;
        item.enter = setTimeout(() => fresh.g.classList.remove('is-new'), 700);
        agents.set(a.key, item);
      }
      // Change layer before moving, and let the browser see the old spot in the new layer,
      // so the walk between desk and lounge animates instead of jumping.
      const layer = a.state === 'working' ? room.seated : room.standing;
      if (item.g.parentNode !== layer) {
        layer.appendChild(item.g);
        item.g.getBoundingClientRect();
      }
      if (item.tag.parentNode !== room.labels) room.labels.appendChild(item.tag);
      moveTo(item, spot);
      paint(item, a, p);
    }
    room.desks.forEach((node, i) => node.classList.toggle('is-lit', lit.has(i)));
    const n = all.length;
    room.g.setAttribute('aria-label', `${room.name} room, ${plural(n)}`);
    room.g.classList.toggle('has-agents', n > 0);
    room.count.textContent = n ? plural(n) : '';
    const extra = n - shown.length;
    room.more.classList.toggle('is-shown', extra > 0);
    room.moreText.textContent = extra > 0 ? `+${extra}` : '';
    return shown;
  }

  function update(list) {
    const byRoom = { claude: [], codex: [] };
    const seen = new Set();
    (Array.isArray(list) ? list : []).forEach((a, i) => {
      if (!a || !Object.hasOwn(byRoom, a.provider)) return;
      const key = String(a.key ?? '');
      if (!key || seen.has(key)) return;
      seen.add(key);
      const state = Object.hasOwn(RANK, a.state) ? a.state : 'idle';
      byRoom[a.provider].push({ key, label: clean(a.label) || 'agent', state, i });
    });
    hidden.clear();
    const keep = new Set();
    for (const p of providers) for (const a of placeRoom(p, byRoom[p])) keep.add(a.key);
    for (const [key, item] of agents) if (!keep.has(key)) remove(key, item);
  }

  function anchor(provider, key) {
    const item = key !== undefined && key !== null ? agents.get(String(key)) : undefined;
    if (item) return centre(item.fig);
    const room = rooms[provider] || rooms[providers[0]];
    return centre(room.floor);
  }

  function pulse(key) {
    const item = agents.get(String(key));
    if (item) return restartClass(item.g, 'is-pulse', 1200, item);
    const p = hidden.get(String(key));
    if (!p) return;
    roomTimers[p] = roomTimers[p] || { timer: 0 };
    restartClass(rooms[p].more, 'is-pulse', 1200, roomTimers[p]);
  }

  update([]);
  return { update, anchor, pulse };
}
