// The CTM band (card U6): a short strip at the bottom of the console with the letters C, T
// and M as 5 x 7 pixel blocks, the office's Claude and Codex crew with their role props,
// and the Mark bots of the other coding agents on the ground. Click or press Enter on a
// crew member to hear its name. CSP-safe: createElementNS, attributes and CSSOM only.
import { MARKS } from './agent-marks.mjs';
import { accessoryPixels, spriteMark, spritePixels } from './sprites.mjs';

const NS = 'http://www.w3.org/2000/svg';
const FONT = {
  C: ['.####', '#....', '#....', '#....', '#....', '#....', '.####'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  M: ['#...#', '##.##', '#.#.#', '#...#', '#...#', '#...#', '#...#'],
};
const CELL = 11;
const GAP = 14;
const BASE = 132;
export const BAND_W = 1100;
const LW = 5 * CELL;
const LH = 7 * CELL;
const START = (BAND_W - (3 * LW + 2 * GAP)) / 2;
const TOP = BASE - LH;
const letterX = i => START + i * (LW + GAP);
const BIG = 2.2;
const SMALL = 1.7;
const NARROW_BELOW = 520;
const BUBBLE_MS = 2400;

/** Where each crew member stands. Pure, so a node test can check the layout. */
export function bandCrew() {
  const crew = [
    { provider: 'codex', role: 'scout', x: START - 150, y: BASE, says: 'Codex · scout', idle: true },
    { provider: 'claude', role: 'builder', x: START - 44, y: BASE, says: 'Claude Code · builder' },
    { provider: 'codex', role: 'planner', x: letterX(1) + LW / 2, y: TOP, says: 'Codex · planner' },
    { provider: 'claude', role: 'reviewer', x: letterX(2) + LW / 2, y: TOP, says: 'Claude Code · reviewer', ask: true },
    { provider: 'codex', role: 'tester', x: letterX(2) + LW + 44, y: BASE, says: 'Codex · tester' },
    { provider: 'claude', role: 'writer', x: letterX(2) + LW + 150, y: BASE, says: 'Claude Code · writer', idle: true },
  ].map(member => ({ ...member, scale: BIG }));
  const bots = Object.entries(MARKS);
  const half = Math.ceil(bots.length / 2);
  const step = 34;
  bots.forEach(([provider, mark], i) => {
    const left = i < half;
    const k = left ? i : i - half;
    const x = left ? START - 196 - k * step : letterX(2) + LW + 196 + k * step;
    crew.push({ provider, role: '', x, y: BASE, says: mark.label, idle: true, scale: SMALL });
  });
  return crew;
}

function el(name, attributes = {}, parent) {
  const node = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  parent?.append(node);
  return node;
}

/** A pixel box: a fill with a 2-unit stepped outline. */
function pixelBox(parent, x, y, w, h, className) {
  const g = el('g', { class: className }, parent);
  el('rect', { class: 'band-box-edge', x: x + 2, y, width: w - 4, height: h }, g);
  el('rect', { class: 'band-box-edge', x, y: y + 2, width: w, height: h - 4 }, g);
  el('rect', { class: 'band-box', x: x + 2, y: y + 2, width: w - 4, height: h - 4 }, g);
  return g;
}

function inkFilter(svg) {
  const defs = el('defs', {}, svg);
  const f = el('filter', { id: 'band-ink', x: '-5%', y: '-8%', width: '110%', height: '116%' }, defs);
  el('feTurbulence', { type: 'fractalNoise', baseFrequency: '0.012 0.3', numOctaves: 2, seed: 4, result: 'streak' }, f);
  el('feColorMatrix', { in: 'streak', type: 'matrix', values: '0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -15 4.4', result: 'streakA' }, f);
  el('feTurbulence', { type: 'fractalNoise', baseFrequency: '0.8', numOctaves: 1, seed: 9, result: 'speck' }, f);
  el('feColorMatrix', { in: 'speck', type: 'matrix', values: '0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -30 5.2', result: 'speckA' }, f);
  el('feComposite', { in: 'streakA', in2: 'speckA', operator: 'arithmetic', k1: 0, k2: 1, k3: 1, k4: 0, result: 'holes' }, f);
  el('feComposite', { in: 'SourceGraphic', in2: 'holes', operator: 'out' }, f);
}

function drawSprite(parent, provider, role) {
  for (const [x, y, width, height, fill] of [...spritePixels(provider), ...accessoryPixels(provider, role)]) {
    el('rect', { x, y, width, height, fill }, parent);
  }
  const mark = spriteMark(provider);
  if (!mark) return;
  const face = el('g', { transform: `translate(${mark.x} ${mark.y}) scale(${mark.scale})`, 'shape-rendering': 'geometricPrecision' }, parent);
  for (const d of mark.paths) el('path', { d, fill: mark.fill }, face);
}

const DOODLES = [
  ['#FFD23F', ['..#..', '.###.', '#####', '.###.', '.#.#.']],
  ['#FF5C7A', ['.#.#.', '#####', '#####', '.###.', '..#..']],
  ['#B9F500', ['..#..', '..#..', '#####', '..#..', '..#..']],
  ['#C9B6FF', ['.###.', '#...#', '..##.', '.....', '..#..']],
];

function drift(holder) {
  for (let k = 0; k < 8; k++) {
    const [fill, rows] = DOODLES[k % DOODLES.length];
    const svg = el('svg', { viewBox: '0 0 5 5' }, holder);
    rows.forEach((row, y) => [...row].forEach((c, x) => { if (c === '#') el('rect', { x, y, width: 1, height: 1, fill }, svg); }));
    svg.style.setProperty('--x', `${3 + ((k * 41) % 94)}%`);
    svg.style.setProperty('--delay', `${-((k * 1.7) % 7)}s`);
    svg.style.setProperty('--t', `${6 + (k % 3) * 1.5}s`);
  }
}

export function createBand(section) {
  const svg = section.querySelector('svg#band');
  svg.replaceChildren();
  inkFilter(svg);
  const art = el('g', { 'shape-rendering': 'crispEdges' }, svg);
  for (let x = 40; x < BAND_W - 40; x += 4) el('rect', { class: 'band-ground', x, y: BASE + ((x / 4) % 9 === 0 ? -2 : 0), width: 4, height: 3 }, art);
  for (let k = 0; k < 16; k++) {
    const x = 70 + ((k * 151) % (BAND_W - 140));
    el('rect', { class: 'band-ground', x, y: BASE - 6, width: 2, height: 6 }, art);
    el('rect', { class: 'band-ground', x: x + 4, y: BASE - 9, width: 2, height: 9 }, art);
  }
  const letters = el('g', { filter: 'url(#band-ink)' }, art);
  'CTM'.split('').forEach((ch, i) => {
    const g = el('g', { class: 'band-letter' }, letters);
    g.style.setProperty('--d', `${i * 110}ms`);
    FONT[ch].forEach((row, r) => [...row].forEach((c, k) => {
      if (c === '#') el('rect', { class: 'band-cell', x: letterX(i) + k * CELL, y: TOP + r * CELL, width: CELL + 0.4, height: CELL + 0.4 }, g);
    }));
  });

  const crewLayer = el('g', {}, svg);
  const said = section.querySelector('#band-said');
  let bubble = null;
  let bubbleTimer = 0;
  const crew = bandCrew();
  crew.forEach((member, j) => {
    const g = el('g', {
      class: 'band-char', tabindex: 0, role: 'button', 'aria-label': member.says,
      'data-provider': member.provider, 'data-role': member.role || 'none',
      transform: `translate(${member.x - 8 * member.scale} ${member.y - 20 * member.scale}) scale(${member.scale})`,
      'shape-rendering': 'crispEdges',
    }, crewLayer);
    const arrive = el('g', { class: 'band-arrive' }, g);
    arrive.style.setProperty('--d', `${420 + j * 60}ms`);
    const hop = el('g', { class: 'band-hop' }, arrive);
    drawSprite(el('g', { class: member.idle ? 'band-idle' : '' }, hop), member.provider, member.role);
    if (member.ask) {
      const at = el('g', { transform: `translate(${member.x + 12} ${member.y - 20 * member.scale - 22})` }, crewLayer);
      const ask = pixelBox(at, 0, 0, 20, 20, 'band-ask');
      el('text', { x: 10, y: 15, 'text-anchor': 'middle' }, ask).textContent = '?';
    }
    const talk = () => {
      g.classList.remove('is-hop');
      g.getBoundingClientRect();
      g.classList.add('is-hop');
      bubble?.remove();
      clearTimeout(bubbleTimer);
      const text = member.says.toUpperCase();
      const w = Array.from(text).length * 8.2 + 18;
      const box = svg.viewBox.baseVal;
      const x = Math.min(box.x + box.width - w - 4, Math.max(box.x + 4, member.x - w / 2));
      const y = Math.max(box.y + 2, member.y - 20 * member.scale - 30);
      bubble = el('g', { class: 'band-bubble', 'shape-rendering': 'crispEdges', 'aria-hidden': 'true' }, svg);
      if (said) said.textContent = member.says;
      pixelBox(bubble, x, y, w, 22, '');
      el('text', { x: x + w / 2, y: y + 15, 'text-anchor': 'middle' }, bubble).textContent = text;
      const shown = bubble;
      bubbleTimer = setTimeout(() => shown.remove(), BUBBLE_MS);
    };
    g.addEventListener('click', talk);
    g.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); talk(); }
    });
  });

  // Wide sheets show the whole strip; narrow ones crop to the word and its nearest crew.
  const fit = width => {
    const narrow = width > 0 && width < NARROW_BELOW;
    svg.setAttribute('viewBox', narrow ? `${START - 190} -14 ${3 * LW + 2 * GAP + 380} 162` : `0 -14 ${BAND_W} 162`);
  };
  fit(svg.getBoundingClientRect().width);
  if (typeof ResizeObserver === 'function') new ResizeObserver(entries => fit(entries[0].contentRect.width)).observe(svg);

  drift(section.querySelector('.drift'));
  const play = () => { section.classList.remove('play'); section.getBoundingClientRect(); section.classList.add('play'); };
  section.querySelector('#band-replay')?.addEventListener('click', play);
  if (typeof IntersectionObserver === 'function') {
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { play(); observer.disconnect(); }
    }, { threshold: 0.6 });
    observer.observe(section);
  }
  return { crew };
}
