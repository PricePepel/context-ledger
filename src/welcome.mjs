// Card U9: the terminal welcome. A person at a terminal sees the CTM pixel mark in the
// brand colours and the command's lines appearing one after another. A script sees
// exactly the plain lines: when output is piped, NO_COLOR is set, TERM is dumb or
// CONTEXT_LEDGER_NO_BANNER=1, nothing here adds a byte.
//
// The welcome prints fixed text and the lines its caller gives it. Every caller line goes
// through terminalLine first, in both modes, so no control or format character reaches
// the terminal. It uses colour codes (SGR) and nothing else: no cursor movement, so a
// long line that wraps cannot be damaged. The escape character is built from its code
// point, so this file holds no raw control character.
import { terminalLine } from './text.mjs';

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
// of the 256 and the 16 colour sets for older ones. text is the colour of a mark's
// two letters on that background.
const paint = {
  violet: { 24: '48;2;114;59;250', 8: '48;5;99', 4: '45', text: '97' },
  lime: { 24: '48;2;185;245;0', 8: '48;5;190', 4: '102', text: '30' },
  grey: { 24: '48;2;92;91;88', 8: '48;5;240', 4: '100', text: '97' },
  red: { 24: '48;2;214;51;47', 8: '48;5;160', 4: '41', text: '97' },
};
const ink = { dim: '2', bold: '1', underline: '4' };

// What stands before a line, by its state: a coloured pixel that also says it in two
// letters, so the state is never told by colour alone. A detail line has no pixel.
const marks = { ok: ['lime', 'ok'], failed: ['red', '!!'], note: ['violet', '  '] };

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

const block = (colour, depth, text = '  ') => `${ESC}[${paint[colour][depth]};${paint[colour].text}m${text}${reset}`;
const styled = (style, text) => `${ESC}[${ink[style]}m${text}${reset}`;

/** The mark as terminal lines: each pixel is two spaces on a coloured background. */
export function markLines(depth) {
  const rows = MARK.map(row => '  ' + [...row].map(pixel => (pixel === 'V' ? block('violet', depth) : '  ')).join(''));
  return [...rows, '  ' + block('lime', depth, ' '.repeat(32))];
}

/** One caller line for the terminal: its mark, then its text with nothing invisible in it. */
function lineFrame({ text, state = 'ok' }, depth) {
  const safe = terminalLine(String(text));
  if (state === 'detail') return `     ${safe}`;
  // Card U11: a link has a line of its own with a two-space indent, so a sign-in link fits
  // in 80 columns for any port and a terminal can open it with Ctrl+click.
  if (state === 'link') return `  ${styled('underline', safe)}`;
  const [colour, letters2] = Object.hasOwn(marks, state) ? marks[state] : ['grey', '  '];
  return `  ${block(colour, depth, letters2)} ${safe}`;
}

/**
 * Every write of the welcome, in order, as { text, waitMs }: the mark row by row, a
 * title, then each of the caller's lines. Pure, so a test can check that only colour
 * codes are used. A line's state is 'ok', 'failed', 'note', 'detail' or 'link'. A line
 * marked plainOnly is left out here (card U11): it is the plain form of other lines.
 */
export function welcomeFrames({ title, lines, depth = 24, footer }) {
  const frames = [{ text: '', waitMs: 0 }];
  for (const row of markLines(depth)) frames.push({ text: row, waitMs: 35 });
  frames.push({ text: '', waitMs: 0 });
  frames.push({ text: `  ${styled('bold', 'Context Ledger')}  ${styled('dim', title)}`, waitMs: 120 });
  frames.push({ text: '', waitMs: 0 });
  for (const line of lines.filter(line => !line.plainOnly)) {
    frames.push({ text: lineFrame(line, depth), waitMs: line.state === 'detail' || line.state === 'link' ? 40 : 160 });
  }
  if (footer) frames.push({ text: '', waitMs: 0 }, { text: `  ${styled('dim', footer)}`, waitMs: 60 });
  frames.push({ text: '', waitMs: 0 });
  return frames;
}

const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms); });

// The process's own output goes through console.log, as it did before this card.
// console.log ignores a closed pipe; a bare stream.write does not, and a script that stops
// reading after the first line would then stop the server with EPIPE (seen on Linux and
// macOS CI). Any other stream (tests) is written to directly.
const lineWriter = stream => (stream === process.stdout ? text => { console.log(text); } : text => { stream.write(`${text}\n`); });

/**
 * Print a command's lines. At a terminal: the welcome, a line at a time. Anywhere else:
 * the same lines, plainly and at once, as before this card; a line marked terminalOnly
 * is left out there, and a line marked plainOnly is printed only there.
 */
export async function printWelcome({ title, lines, footer }, { stream = process.stdout, env = process.env, wait = sleep } = {}) {
  const write = lineWriter(stream);
  if (!fancyTerminal(stream, env)) {
    for (const { text, terminalOnly } of lines) if (!terminalOnly) write(terminalLine(String(text)));
    return false;
  }
  for (const { text, waitMs } of welcomeFrames({ title, lines, footer, depth: colourDepth(stream, env) })) {
    if (waitMs) await wait(waitMs);
    write(text);
  }
  return true;
}

/** Card U11: true when node was started with the package's bin (a global install or npx), not a checkout's script. */
export const installedCommand = script => /[\\/]\.?bin[\\/]context-ledger(?:\.mjs|\.cmd)?$/u.test(String(script ?? ''));

/**
 * Card U11: what `start` prints once it listens. Piped, the same two plain lines as before
 * (scripts and tests read them); at a terminal, the steps to sign in, with the link on a
 * line of its own. The caller mints one code and passes it here.
 */
export function startLines({ port, code, seconds, installed }) {
  const origin = `http://127.0.0.1:${port}`;
  const link = `${origin}/login?code=${code}`;
  const login = installed ? 'context-ledger login' : 'npm run ledger -- login';
  return [
    // The store opened before the server could listen; a terminal is told so, a pipe is not.
    { text: 'Database opened', terminalOnly: true },
    { text: `Context Ledger listening at ${origin}` },
    { text: `Sign in to the browser app (one use, within ${seconds} seconds): ${link}`, plainOnly: true },
    { text: `Sign in: open this link in your browser within ${seconds} seconds`, state: 'note', terminalOnly: true },
    { text: link, state: 'link', terminalOnly: true },
    { text: 'Ctrl+click it (Cmd+click on a Mac), or copy it into the address bar.', state: 'detail', terminalOnly: true },
    { text: 'It signs this browser in and opens the library.', state: 'detail', terminalOnly: true },
    { text: `The console is at ${origin}/console/`, state: 'detail', terminalOnly: true },
    { text: `The link works once. For a new one, run: ${login}`, state: 'detail', terminalOnly: true },
  ];
}
