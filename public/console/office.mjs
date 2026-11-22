// CTM Console office: an SVG floor with one room per agent source and one small
// character per active agent party. CSP-safe: every node is built with
// createElementNS, text goes through textContent, and positions use SVG
// attributes or CSSOM (never a style attribute).
const NS = 'http://www.w3.org/2000/svg';

export const providers = ['claude', 'codex'];
export const providerNames = { claude: 'Claude Code', codex: 'Codex' };

const RANK = { waiting: 0, working: 1, idle: 2 };
const MAX = 6;
const LABEL_MAX = 16;
const ELLIPSIS = String.fromCodePoint(0x2026);
const NARROW_BELOW = 560;
const LAYOUT = {
  wide: { box: '0 0 870 224', at: [[10, 2], [440, 2]] },
  narrow: { box: '0 0 440 448', at: [[10, 2], [10, 226]] }
};

function el(tag, attrs, parent, text) {
  const node = document.createElementNS(NS, tag);
  for (const name in attrs) node.setAttribute(name, attrs[name]);
  if (text !== undefined) node.textContent = text;
  if (parent) parent.appendChild(node);
  return node;
}

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

// Feet positions inside a room (room-local units, floor spans y 44..204).
function slots(n) {
  if (n <= 3) return Array.from({ length: n }, (_, j) => [210 + (j - (n - 1) / 2) * 124, 150]);
  const step = Math.min(84, 360 / n);
  return Array.from({ length: n }, (_, j) => [210 + (j - (n - 1) / 2) * step, j % 2 ? 172 : 114]);
}

function buildRoom(parent, provider) {
  const name = providerNames[provider];
  const g = el('g', { class: `office-room office-room-${provider}`, 'data-provider': provider, role: 'group' }, parent);
  const deco = el('g', { 'aria-hidden': 'true' }, g);
  el('rect', { class: 'office-wall', x: 24, y: 0, width: 396, height: 44, rx: 3 }, deco);
  el('rect', { class: 'office-trim', x: 24, y: 40, width: 396, height: 4 }, deco);
  const floor = el('polygon', { class: 'office-floor', points: '24,44 420,44 396,204 0,204' }, deco);
  el('polygon', { class: 'office-edge', points: '0,204 396,204 396,211 0,211' }, deco);
  el('polygon', { class: 'office-edge-side', points: '396,204 420,44 420,51 396,211' }, deco);
  let grid = '';
  for (let t = 1; t < 4; t += 1) {
    const y = 44 + t * 40;
    const shift = (24 * (y - 44)) / 160;
    grid += `M${24 - shift} ${y}H${420 - shift}`;
  }
  for (let k = 1; k < 6; k += 1) grid += `M${24 + k * 66} 44l-24 160`;
  el('path', { class: 'office-grid', d: grid }, deco);
  el('circle', { class: 'office-dot', cx: 38, cy: 22, r: 4.5 }, deco);
  el('text', { class: 'office-room-name', x: 50, y: 27 }, deco, name);
  const count = el('text', { class: 'office-room-count', x: 406, y: 27, 'text-anchor': 'end' }, deco);
  el('text', { class: 'office-empty', x: 210, y: 128, 'text-anchor': 'middle' }, deco, 'no agent yet');
  const more = el('g', { class: 'office-more', transform: 'translate(384 100)' }, deco);
  el('rect', { x: -18, y: -10, width: 36, height: 19, rx: 9.5 }, more);
  const moreText = el('text', { y: 4, 'text-anchor': 'middle' }, more);
  const people = el('g', { class: 'office-people' }, g);
  return { provider, name, g, floor, count, more, moreText, people };
}

function buildAgent() {
  const g = el('g', { class: 'office-agent', role: 'img' });
  const size = el('g', { transform: 'scale(1.25)' }, g);
  el('circle', { class: 'oa-ring', cx: 0, cy: -22, r: 24 }, size);
  const body = el('g', { class: 'oa-body' }, size);
  el('ellipse', { class: 'oa-shadow', cx: 0, cy: 0, rx: 13, ry: 3.5 }, body);
  const fig = el('g', { class: 'oa-fig' }, body);
  el('path', { class: 'oa-leg', d: 'M-5.5 -6v5.5M5.5 -6v5.5' }, fig);
  el('rect', { class: 'oa-coat', x: -9.5, y: -25, width: 19, height: 21, rx: 7.5 }, fig);
  el('rect', { class: 'oa-page', x: -4, y: -20, width: 8, height: 10, rx: 1.2 }, fig);
  el('path', { class: 'oa-page-line', d: 'M-2 -17h4M-2 -14.5h4M-2 -12h2.5' }, fig);
  el('circle', { class: 'oa-head', cx: 0, cy: -32, r: 8 }, fig);
  el('path', { class: 'oa-eye', d: 'M-3 -32.5v1.5M3 -32.5v1.5' }, fig);
  el('ellipse', { class: 'oa-glow', cx: 0, cy: -29, rx: 9, ry: 6 }, fig);
  const desk = el('g', { class: 'oa-desk' }, body);
  el('rect', { class: 'oa-halo', x: -10, y: -23, width: 20, height: 15, rx: 4 }, desk);
  el('rect', { class: 'oa-laptop', x: -7.5, y: -20, width: 15, height: 10.5, rx: 1.5 }, desk);
  el('circle', { class: 'oa-logo', cx: 0, cy: -14.8, r: 1.5 }, desk);
  el('rect', { class: 'oa-desk-top', x: -17, y: -10, width: 34, height: 3.5, rx: 1 }, desk);
  el('path', { class: 'oa-desk-leg', d: 'M-14 -6.5V0M14 -6.5V0' }, desk);
  const bubble = el('g', { class: 'oa-bubble' }, body);
  el('rect', { x: 6, y: -60, width: 17, height: 15, rx: 6 }, bubble);
  el('path', { d: 'M9.5 -45.5l-3 5.5 7.5-5.5z' }, bubble);
  el('text', { class: 'oa-q', x: 14.5, y: -48.5, 'text-anchor': 'middle' }, bubble, '?');
  const name = el('text', { class: 'oa-name', y: 16, 'text-anchor': 'middle' }, g);
  const state = el('text', { class: 'oa-state', y: 28.5, 'text-anchor': 'middle' }, g);
  return { g, fig, name, state, timer: 0, enter: 0 };
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

export function createOffice(svg) {
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
    new ResizeObserver((entries) => layout(entries[0].contentRect.width)).observe(svg);
  }

  function paint(item, a, provider) {
    const label = clip(a.label, LABEL_MAX);
    for (const s in RANK) item.g.classList.toggle(`state-${s}`, s === a.state);
    item.g.setAttribute('data-key', a.key);
    item.g.setAttribute('data-state', a.state);
    item.g.setAttribute('aria-label', `${clip(a.label, 48)}, ${providerNames[provider]}, ${a.state}`);
    if (item.name.textContent !== label) item.name.textContent = label;
    if (item.state.textContent !== a.state) item.state.textContent = a.state;
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
    for (const p of providers) {
      const room = rooms[p];
      const all = byRoom[p];
      const shown = all.slice().sort((x, y) => RANK[x.state] - RANK[y.state] || x.i - y.i).slice(0, MAX);
      shown.sort((x, y) => x.i - y.i);
      for (const a of all) if (!shown.includes(a)) hidden.set(a.key, p);
      const spots = slots(shown.length);
      shown.forEach((a, j) => {
        let item = agents.get(a.key);
        if (item && item.provider !== p) {
          item.g.remove();
          agents.delete(a.key);
          item = undefined;
        }
        const [x, y] = spots[j];
        if (!item) {
          item = buildAgent();
          item.provider = p;
          item.g.classList.add('is-new');
          item.enter = setTimeout(() => item.g.classList.remove('is-new'), 700);
          item.g.style.setProperty('transform', `translate(${x}px, ${y}px)`);
          paint(item, a, p);
          room.people.appendChild(item.g);
          agents.set(a.key, item);
        } else {
          item.g.style.setProperty('transform', `translate(${x}px, ${y}px)`);
          paint(item, a, p);
        }
        keep.add(a.key);
      });
      const n = all.length;
      room.g.setAttribute('aria-label', `${room.name} room, ${plural(n)}`);
      room.g.classList.toggle('has-agents', n > 0);
      room.count.textContent = n ? plural(n) : '';
      const extra = n - shown.length;
      room.more.classList.toggle('is-shown', extra > 0);
      room.moreText.textContent = extra > 0 ? `+${extra}` : '';
    }
    for (const [key, item] of agents) {
      if (keep.has(key)) continue;
      clearTimeout(item.timer);
      clearTimeout(item.enter);
      item.g.remove();
      agents.delete(key);
    }
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
