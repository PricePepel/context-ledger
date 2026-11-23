// Card U9: the terminal welcome. A person at a terminal sees the CTM pixel mark in the
// brand colours and the command's lines appearing one after another. A script sees
// exactly the plain lines: when output is piped, NO_COLOR is set, TERM is dumb or
// CONTEXT_LEDGER_NO_BANNER=1, nothing here adds a byte.
//
// The welcome prints only fixed text and the lines its caller already prints. It uses
// colour codes (SGR) and nothing else: no cursor movement, so a long line that wraps
// cannot be damaged. The escape character is built from its code point, so this file
// holds no raw control character.
const ESC = String.fromCodePoint(27);
const reset = `${ESC}[0m`;

// The CTM pixel letters, five rows of sixteen: V is a violet pixel, '.' is empty.
const letters = {
  C: ['.VVV', 'V...', 'V...', 'V...', '.VVV'],
  T: ['VVVVV', '..V..', '..V..', '..V..', '..V..'],
  M: ['V...V', 'VV.VV', 'V.V.V', 'V...V', 'V...V'],
};
export const MARK = [0, 1, 2, 3, 4].map(row => [letters.C[row], letters.T[row], letters.M[row]].join('.'));

// Brand colours (docs/brand/tokens.css) for 24-bit terminals, with the nearest colour
// of the 256 and the 16 colour sets for older ones.
const paint = {
  violet: { 24: '48;2;114;59;250', 8: '48;5;99', 4: '45' },
  lime: { 24: '48;2;185;245;0', 8: '48;5;190', 4: '102' },
  grey: { 24: '48;2;92;91;88', 8: '48;5;240', 4: '100' },
  red: { 24: '48;2;214;51;47', 8: '48;5;160', 4: '41' },
};
const ink = { violet: { 24: '38;2;158;123;255', 8: '38;5;141', 4: '95' }, dim: { 24: '2', 8: '2', 4: '2' }, bold: { 24: '1', 8: '1', 4: '1' } };

/** True when the stream is a terminal a person is looking at and colour is welcome. */
export function fancyTerminal(stream = process.stdout, env = process.env) {
  if (!stream?.isTTY) return false;
  if (typeof env.NO_COLOR === 'string' && env.NO_COLOR !== '') return false;
  if (env.TERM === 'dumb' || env.CONTEXT_LEDGER_NO_BANNER === '1') return false;
  return colourDepth(stream, env) >= 4;
}

/** 24, 8 or 4 bits of colour; 1 means none. */
export function colourDepth(stream = process.stdout, env = process.env) {
  const depth = typeof stream?.getColorDepth === 'function' ? stream.getColorDepth(env) : 1;
  return depth >= 24 ? 24 : depth >= 8 ? 8 : depth >= 4 ? 4 : 1;
}

const block = (colour, depth, text = '  ') => `${ESC}[${paint[colour][depth]}m${text}${reset}`;
const styled = (style, depth, text) => `${ESC}[${ink[style][depth]}m${text}${reset}`;

/** The mark as terminal lines: each pixel is two spaces on a coloured background. */
export function markLines(depth) {
  const rows = MARK.map(row => '  ' + [...row].map(pixel => (pixel === 'V' ? block('violet', depth) : '  ')).join(''));
  return [...rows, '  ' + block('lime', depth, ' '.repeat(32))];
}

/**
 * Every write of the welcome, in order, as { text, waitMs }: the mark row by row, a
 * title, then each of the caller's lines behind a coloured pixel. Pure, so a test can
 * check that only colour codes are used. state is 'ok', 'failed' or 'note'.
 */
export function welcomeFrames({ title, lines, depth = 24, footer }) {
  const frames = [{ text: '', waitMs: 0 }];
  for (const row of markLines(depth)) frames.push({ text: row, waitMs: 35 });
  frames.push({ text: '', waitMs: 0 });
  frames.push({ text: `  ${styled('bold', depth, 'Context Ledger')}  ${styled('dim', depth, title)}`, waitMs: 120 });
  frames.push({ text: '', waitMs: 0 });
  const colours = { ok: 'lime', failed: 'red', note: 'violet' };
  for (const { text, state = 'ok' } of lines) frames.push({ text: `  ${block(Object.hasOwn(colours, state) ? colours[state] : 'grey', depth)} ${text}`, waitMs: 160 });
  if (footer) frames.push({ text: '', waitMs: 0 }, { text: `  ${styled('dim', depth, footer)}`, waitMs: 60 });
  frames.push({ text: '', waitMs: 0 });
  return frames;
}

const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms); });

/**
 * Print a command's lines. At a terminal: the welcome, a line at a time. Anywhere else:
 * the same lines, plainly and at once, exactly as before this card.
 */
export async function printWelcome({ title, lines, footer }, { stream = process.stdout, env = process.env, wait = sleep } = {}) {
  if (!fancyTerminal(stream, env)) {
    for (const { text } of lines) stream.write(`${text}\n`);
    return false;
  }
  for (const { text, waitMs } of welcomeFrames({ title, lines, footer, depth: colourDepth(stream, env) })) {
    if (waitMs) await wait(waitMs);
    stream.write(`${text}\n`);
  }
  return true;
}
