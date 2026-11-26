// CTM Console office furniture (card U4b): one furnished top-down room per agent source.
// Room-local units: the room is ROOM_W x ROOM_H with a HEADER-unit name strip on top. The
// work area holds six desks; on the right are the kitchen (top) and the lounge (bottom).
// CSP-safe: nodes from createElementNS, colours from classes in office.css.

const NS = 'http://www.w3.org/2000/svg';

export const ROOM_W = 470;
export const ROOM_H = 304;
export const HEADER = 26;
export const DESKS = 6;

const DESK_X = [52, 140, 228];
const DESK_Y = [100, 206];
const LOUNGE_X = [334, 384, 434];
const LOUNGE_Y = [216, 274];

/** The work area and the lounge, as [left, top, right, bottom], for tests and layout checks. */
export const WORK_AREA = [6, HEADER + 31, 296, ROOM_H - 6];
export const LOUNGE = [302, 144, ROOM_W - 6, ROOM_H - 6];

export function el(tag, attrs, parent, text) {
  const node = document.createElementNS(NS, tag);
  for (const name in attrs) node.setAttribute(name, attrs[name]);
  if (text !== undefined) node.textContent = text;
  if (parent) parent.appendChild(node);
  return node;
}

const deskAt = i => ({ x: DESK_X[i % 3], y: DESK_Y[Math.floor(i / 3) % 2] });

/** Feet position of a working agent, seated behind desk i. */
export function seatAt(i) {
  const d = deskAt(i);
  return [d.x, d.y + 14];
}

/** Feet position of a waiting agent, standing to the right of desk i. */
export function besideDesk(i) {
  const d = deskAt(i);
  return [d.x + 46, d.y + 25];
}

/** Feet position of the j-th idle agent in the lounge. */
export function loungeSpot(j) {
  return [LOUNGE_X[j % 3], LOUNGE_Y[Math.floor(j / 3) % 2]];
}

const rect = (parent, cls, x, y, width, height, extra = {}) => el('rect', { class: cls, x, y, width, height, ...extra }, parent);

function planks(g, x, y, w, h) {
  let d = '';
  for (let px = x + 16; px < x + w; px += 16) d += `M${px} ${y}v${h}`;
  for (let col = 0, px = x; px < x + w; px += 16, col += 1) {
    for (let py = y + (col % 3) * 18 + 10; py < y + h; py += 54) d += `M${px} ${py}h16`;
  }
  el('path', { class: 'of-line of-plank', d }, g);
}

function grid(g, x, y, w, h, size) {
  let d = '';
  for (let px = x + size; px < x + w; px += size) d += `M${px} ${y}v${h}`;
  for (let py = y + size; py < y + h; py += size) d += `M${x} ${py}h${w}`;
  el('path', { class: 'of-line of-tile-line', d }, g);
}

function checker(g, x, y, w, h, size) {
  rect(g, 'of-check-light', x, y, w, h);
  let d = '';
  for (let row = 0; row * size < h; row += 1) {
    for (let col = row % 2; (col + 1) * size <= w; col += 2) d += `M${x + col * size} ${y + row * size}h${size}v${size}h-${size}z`;
  }
  el('path', { class: 'of-check', d }, g);
}

const BOOKS = ['b1', 'b2', 'b3', 'b4', 'b5'];

function bookshelf(g, x, y) {
  rect(g, 'of-shelf', x, y, 52, 30);
  for (let row = 0; row < 2; row += 1) {
    rect(g, 'of-shelf-in', x + 3, y + 3 + row * 13, 46, 11);
    for (let k = 0, bx = x + 4; bx < x + 46; k += 1) {
      const bw = (k + row) % 3 === 0 ? 4 : 3;
      const bh = (k * 7 + row * 3) % 4 === 0 ? 6 : 8;
      if ((k + row * 2) % 7 !== 6) rect(g, `of-${BOOKS[(k + row * 3) % BOOKS.length]}`, bx, y + 14 + row * 13 - bh, bw, bh);
      bx += bw + 1;
    }
  }
}

function plant(g, x, y) {
  rect(g, 'of-leaf-dark', x - 7, y - 16, 14, 8);
  rect(g, 'of-leaf', x - 9, y - 20, 6, 8);
  rect(g, 'of-leaf', x + 3, y - 20, 6, 8);
  rect(g, 'of-leaf', x - 3, y - 25, 6, 10);
  rect(g, 'of-leaf-dark', x - 1, y - 21, 2, 9);
  rect(g, 'of-pot', x - 6, y - 9, 12, 10);
  rect(g, 'of-pot-rim', x - 7, y - 10, 14, 3);
}

function windowPane(g, x, y, w) {
  rect(g, 'of-steel', x, y, w, 22);
  rect(g, 'of-sky', x + 2, y + 2, w - 4, 18);
  rect(g, 'of-trees', x + 2, y + 13, w - 4, 7);
  rect(g, 'of-steel', x + w / 2 - 1, y, 2, 22);
  rect(g, 'of-steel', x, y + 10, w, 2);
  rect(g, 'of-steel-dark', x - 2, y + 22, w + 4, 2);
}

const NOTES = ['n1', 'n2', 'n3', 'n4', 'n2', 'n1', 'n3', 'n4'];

function whiteboard(g, x, y) {
  rect(g, 'of-steel-dark', x, y, 54, 24);
  rect(g, 'of-white', x + 2, y + 2, 50, 18);
  NOTES.forEach((n, k) => rect(g, `of-${n}`, x + 5 + (k % 4) * 11 + (k > 3 ? 3 : 0), y + 4 + Math.floor(k / 4) * 8, 6, 5));
  rect(g, 'of-metal', x + 6, y + 21, 42, 2);
}

function poster(g, x, y) {
  rect(g, 'of-metal', x, y, 18, 24);
  rect(g, 'of-accent', x + 2, y + 3, 14, 10);
  rect(g, 'of-lime', x + 3, y + 16, 12, 2);
  rect(g, 'of-lime', x + 3, y + 20, 8, 1);
}

function chair(g, x, y) {
  rect(g, 'of-chair-back', x - 9, y - 9, 18, 7, { rx: 2 });
  rect(g, 'of-chair', x - 8, y - 3, 16, 12, { rx: 2 });
}

function desk(g, i) {
  const { x, y } = deskAt(i);
  const d = el('g', { class: 'of-desk', 'data-desk': i }, g);
  rect(d, 'of-desk-top', x - 28, y, 56, 18);
  rect(d, 'of-desk-edge', x - 28, y + 18, 56, 5);
  rect(d, 'of-desk-edge', x - 27, y + 23, 3, 3);
  rect(d, 'of-desk-edge', x + 24, y + 23, 3, 3);
  rect(d, 'of-glow', x - 29, y - 9, 22, 18, { rx: 4 });
  rect(d, 'of-metal', x - 20, y + 4, 4, 5);
  rect(d, 'of-metal', x - 26, y - 7, 16, 12);
  rect(d, 'of-screen', x - 24, y - 5, 12, 8);
  rect(d, 'of-white', x - 4, y + 9, 16, 4);
  rect(d, 'of-white', x + 18, y + 6, 4, 5);
  return d;
}

function kitchen(g) {
  checker(g, 302, 58, 162, 80, 9);
  rect(g, 'of-counter', 306, 48, 90, 20);
  rect(g, 'of-counter-top', 306, 48, 90, 6);
  rect(g, 'of-steel-dark', 318, 50, 16, 9);
  rect(g, 'of-metal', 352, 40, 12, 16);
  rect(g, 'of-screen-on', 355, 44, 6, 3);
  rect(g, 'of-white', 368, 50, 4, 5);
  rect(g, 'of-white', 438, 36, 22, 40);
  rect(g, 'of-steel', 438, 54, 22, 2);
  rect(g, 'of-water', 412, 34, 12, 12, { rx: 3 });
  rect(g, 'of-white', 410, 46, 16, 26);
  rect(g, 'of-blue', 416, 54, 4, 3);
  el('circle', { class: 'of-desk-top', cx: 372, cy: 108, r: 12 }, g);
  rect(g, 'of-chair', 348, 103, 9, 9, { rx: 2 });
  rect(g, 'of-chair', 387, 103, 9, 9, { rx: 2 });
  rect(g, 'of-white', 370, 104, 4, 5);
}

function lounge(g) {
  rect(g, 'of-carpet', 302, 144, 162, 154);
  rect(g, 'of-rug', 314, 180, 140, 112, { rx: 3 });
  rect(g, 'of-rug-line', 320, 186, 128, 100, { rx: 2 });
  rect(g, 'of-sofa-back', 318, 148, 92, 10, { rx: 2 });
  rect(g, 'of-sofa', 318, 156, 92, 14, { rx: 2 });
  rect(g, 'of-sofa', 314, 150, 8, 22, { rx: 2 });
  rect(g, 'of-sofa', 406, 150, 8, 22, { rx: 2 });
  rect(g, 'of-cushion', 330, 158, 14, 8, { rx: 2 });
  rect(g, 'of-cushion', 384, 158, 14, 8, { rx: 2 });
  rect(g, 'of-desk-top', 352, 176, 24, 10, { rx: 1 });
  plant(g, 446, 172);
}

function walls(g) {
  rect(g, 'of-wall-face', 6, HEADER + 6, ROOM_W - 12, 24);
  rect(g, 'of-skirting', 6, HEADER + 28, ROOM_W - 12, 3);
  rect(g, 'of-wall', 296, HEADER + 6, 6, 112);
  rect(g, 'of-wall', 296, 186, 6, ROOM_H - 192);
  rect(g, 'of-wall', 302, 138, 98, 6);
  bookshelf(g, 14, 36);
  windowPane(g, 76, 34, 46);
  whiteboard(g, 128, 34);
  windowPane(g, 190, 34, 46);
  poster(g, 246, 34);
  windowPane(g, 410, 32, 22);
  el('circle', { class: 'of-clock', cx: 390, cy: 41, r: 5 }, g);
  el('path', { class: 'of-clock-hand', d: 'M390 41v-3M390 41h2' }, g);
}

function workArea(g) {
  plant(g, 278, 66);
  plant(g, 18, 290);
  plant(g, 282, 290);
  rect(g, 'of-desk-edge', 136, ROOM_H - 6, 34, 6);
  rect(g, 'of-mat', 140, ROOM_H - 18, 26, 10, { rx: 1 });
  rect(g, 'of-white', 214, 270, 26, 16);
  rect(g, 'of-metal', 214, 270, 26, 5);
  rect(g, 'of-red', 10, 236, 6, 12, { rx: 2 });
  rect(g, 'of-metal', 11, 233, 4, 3);
  for (const x of [76, 190]) {
    el('polygon', { class: 'of-sun', points: `${x},${HEADER + 31} ${x + 46},${HEADER + 31} ${x + 86},${HEADER + 150} ${x + 40},${HEADER + 150}` }, g);
  }
  for (const [x, y] of [[96, 162], [184, 162]]) {
    el('ellipse', { class: 'of-lamp-glow', cx: x, cy: y, rx: 44, ry: 22 }, g);
    rect(g, 'of-lamp', x - 16, y - 2, 32, 4, { rx: 1 });
  }
  for (let i = 0; i < DESKS; i += 1) {
    const { x, y } = deskAt(i);
    chair(g, x, y - 6);
  }
}

/**
 * Draws one furnished room into parent and returns its layers, back to front:
 * back (floor, walls, furniture, chairs), seated (agents at desks), front (the desks),
 * standing (agents beside desks or in the lounge) and labels (names and states).
 */
export function drawRoom(parent, provider) {
  const back = el('g', { class: 'of-back', 'aria-hidden': 'true', 'shape-rendering': 'crispEdges' }, parent);
  rect(back, 'of-wall', 0, HEADER, ROOM_W, ROOM_H - HEADER);
  const [left, top, right, bottom] = [6, HEADER + 6, 296, ROOM_H - 6];
  const floor = rect(back, provider === 'claude' ? 'of-floor of-wood' : 'of-floor of-tile', left, top, right - left, bottom - top);
  if (provider === 'claude') planks(back, left, top, right - left, bottom - top);
  else grid(back, left, top, right - left, bottom - top, 18);
  kitchen(back);
  lounge(back);
  walls(back);
  workArea(back);
  const seated = el('g', { class: 'office-seated' }, parent);
  const front = el('g', { class: 'of-front', 'aria-hidden': 'true', 'shape-rendering': 'crispEdges' }, parent);
  const desks = Array.from({ length: DESKS }, (_, i) => desk(front, i));
  const standing = el('g', { class: 'office-standing' }, parent);
  const labels = el('g', { class: 'office-labels', 'aria-hidden': 'true' }, parent);
  return { floor, seated, desks, standing, labels };
}
