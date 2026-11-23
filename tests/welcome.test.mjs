// Card U9: the terminal welcome. A terminal gets the pixel mark and coloured steps; a
// pipe gets exactly the plain lines.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { MARK, colourDepth, fancyTerminal, markLines, printWelcome, welcomeFrames } from '../src/welcome.mjs';

const ESC = String.fromCodePoint(27);
// Colour codes (SGR) are the only escape sequences the welcome may write.
const withoutColour = text => text.replaceAll(new RegExp(`${ESC}\\[[0-9;]*m`, 'gu'), '');
const terminal = (depth, extra = {}) => ({ isTTY: true, getColorDepth: () => depth, written: [], write(text) { this.written.push(text); }, ...extra });
const lines = [
  { text: 'Context Ledger listening at http://127.0.0.1:4317' },
  { text: 'Sign in to the browser app (one use, within 60 seconds): http://127.0.0.1:4317/login?code=abc', state: 'note' },
];

test('the mark is five rows of sixteen pixels, each violet or empty', () => {
  assert.equal(MARK.length, 5);
  for (const row of MARK) assert.match(row, /^[V.]{16}$/u);
  assert.equal(MARK[0], '.VVV.VVVVV.V...V');
  for (const depth of [24, 8, 4]) {
    const rows = markLines(depth);
    assert.equal(rows.length, 6, 'five rows and the lime bar');
    for (const row of rows) assert.match(withoutColour(row), /^ +$/u, 'pixels are spaces on a coloured background');
  }
});

test('colour is only for a terminal that wants it', () => {
  assert.equal(fancyTerminal(terminal(24), {}), true);
  assert.equal(fancyTerminal(terminal(8), {}), true);
  assert.equal(fancyTerminal(terminal(4), {}), true);
  assert.equal(fancyTerminal(terminal(1), {}), false, 'a terminal with no colour');
  assert.equal(fancyTerminal({ isTTY: false, getColorDepth: () => 24 }, {}), false, 'a pipe');
  assert.equal(fancyTerminal(undefined, {}), false);
  assert.equal(fancyTerminal(terminal(24), { NO_COLOR: '1' }), false);
  assert.equal(fancyTerminal(terminal(24), { NO_COLOR: '' }), true, 'an empty NO_COLOR does not count');
  assert.equal(fancyTerminal(terminal(24), { TERM: 'dumb' }), false);
  assert.equal(fancyTerminal(terminal(24), { CONTEXT_LEDGER_NO_BANNER: '1' }), false);
  assert.equal(colourDepth(terminal(24)), 24);
  assert.equal(colourDepth(terminal(16)), 8);
  assert.equal(colourDepth({ isTTY: true }), 1, 'no colour depth reported');
});

test('the welcome writes colour codes and nothing else: no cursor movement, no control characters', () => {
  for (const depth of [24, 8, 4]) {
    const frames = welcomeFrames({ title: 'local, on this machine', lines, footer: 'Keep this window open.', depth });
    const plain = frames.map(frame => withoutColour(frame.text));
    for (const text of plain) assert.doesNotMatch(text, /[\p{Cc}\p{Cf}]/u, `depth ${depth}`);
    // The caller's lines are there word for word, in order, each behind one pixel.
    const shown = plain.filter(text => lines.some(line => text.endsWith(line.text)));
    assert.deepEqual(shown.map(text => text.trim()), lines.map(line => line.text));
    assert.ok(plain.some(text => text.includes('Context Ledger  local, on this machine')));
    assert.ok(frames.reduce((total, frame) => total + frame.waitMs, 0) < 1500, 'the welcome is short');
  }
  // An unknown state still draws a pixel, and a line is never changed.
  const odd = welcomeFrames({ title: 't', lines: [{ text: 'x', state: 'constructor' }] });
  assert.ok(odd.some(frame => withoutColour(frame.text) === '     x'));
});

test('a pipe gets exactly the lines, at once; a terminal gets the frames with their waits', async () => {
  const pipe = { isTTY: false, written: [], write(text) { this.written.push(text); } };
  const waits = [];
  const wait = async ms => { waits.push(ms); };
  assert.equal(await printWelcome({ title: 't', lines, footer: 'f' }, { stream: pipe, env: {}, wait }), false);
  assert.deepEqual(pipe.written, lines.map(line => `${line.text}\n`));
  assert.deepEqual(waits, []);

  const quiet = terminal(24);
  assert.equal(await printWelcome({ title: 't', lines, footer: 'f' }, { stream: quiet, env: { NO_COLOR: '1' }, wait }), false);
  assert.deepEqual(quiet.written, lines.map(line => `${line.text}\n`));

  const screen = terminal(24);
  assert.equal(await printWelcome({ title: 't', lines, footer: 'f' }, { stream: screen, env: {}, wait }), true);
  assert.ok(screen.written.length > lines.length);
  assert.ok(waits.length > 0);
  assert.ok(screen.written.every(text => text.endsWith('\n')));
  assert.ok(screen.written.some(text => text.includes(ESC)));
});

test('start with piped output prints its two plain lines and no escape codes', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ctm-u9-'));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/server.mjs', import.meta.url))], {
    env: { ...process.env, PORT: '0', CONTEXT_LEDGER_DB: join(dir, 'ledger.sqlite'), FORCE_COLOR: '3' }, stdio: ['ignore', 'pipe', 'ignore'],
  });
  t.after(async () => {
    child.kill();
    await new Promise(resolve => { child.once('exit', resolve); if (child.exitCode !== null) resolve(); });
    await rm(dir, { recursive: true, force: true });
  });
  let output = '';
  const timer = setTimeout(() => child.kill(), 15_000);
  for await (const chunk of child.stdout) {
    output += chunk;
    if (output.split('\n').length > 2) break;
  }
  clearTimeout(timer);
  assert.match(output, /^Context Ledger listening at http:\/\/127\.0\.0\.1:\d+\r?\nSign in to the browser app \(one use, within 60 seconds\): http:\/\/127\.0\.0\.1:\d+\/login\?code=[\w-]+\r?\n$/u);
  assert.ok(!output.includes(ESC));
});
