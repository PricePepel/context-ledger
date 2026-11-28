// Card U9: the terminal welcome. A terminal gets the pixel mark and coloured steps; a
// pipe gets exactly the plain lines.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setupAgents } from '../src/install.mjs';
import { isSqliteNotice, sqliteNotice } from '../src/quiet.mjs';
import { MARK, colourDepth, fancyTerminal, installedCommand, markLines, printWelcome, startLines, welcomeFrames } from '../src/welcome.mjs';

const ESC = String.fromCodePoint(27);
// Colour codes (SGR) are the only escape sequences the welcome may write.
const withoutColour = text => text.replaceAll(new RegExp(`${ESC}\\[[0-9;]*m`, 'gu'), '');
const terminal = (depth, extra = {}) => ({ isTTY: true, getColorDepth: () => depth, written: [], write(text) { this.written.push(text); }, ...extra });
const lines = [
  { text: 'Database opened', terminalOnly: true },
  { text: 'Context Ledger listening at http://127.0.0.1:4317' },
  { text: 'Sign in to the browser app (one use, within 60 seconds): http://127.0.0.1:4317/login?code=abc', state: 'note' },
];
const piped = lines.filter(line => !line.terminalOnly).map(line => `${line.text}\n`);

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
    // The caller's lines are there word for word, in order, each behind its mark.
    const shown = plain.filter(text => lines.some(line => text.endsWith(line.text)));
    assert.deepEqual(shown, ['  ok Database opened', `  ok ${lines[1].text}`, `     ${lines[2].text}`]);
    assert.ok(plain.some(text => text.includes('Context Ledger  local, on this machine')));
    assert.ok(frames.reduce((total, frame) => total + frame.waitMs, 0) < 1500, 'the welcome is short');
  }
});

test('a result is told in letters as well as colour, and a detail line has no mark', () => {
  const frames = welcomeFrames({ title: 't', lines: [
    { text: 'Claude Code', state: 'ok' }, { text: '  MCP server: added', state: 'detail' },
    { text: 'Codex', state: 'failed' }, { text: 'x', state: 'constructor' },
  ] }).map(frame => withoutColour(frame.text));
  assert.ok(frames.includes('  ok Claude Code'));
  assert.ok(frames.includes('       MCP server: added'));
  assert.ok(frames.includes('  !! Codex'));
  assert.ok(frames.includes('     x'), 'an unknown state still prints its line');
});

test('review: a line with invisible or control characters is escaped in both modes', async () => {
  const sneaky = `path${String.fromCodePoint(0x200d)}a${String.fromCodePoint(0x202e)}b${ESC}[2Jc${String.fromCodePoint(0x200c)}d\te`;
  const expected = 'path\\u200da\\u202eb\\u001b[2Jc\\u200cd\\u0009e';
  const pipe = { isTTY: false, written: [], write(text) { this.written.push(text); } };
  await printWelcome({ title: 't', lines: [{ text: sneaky, state: 'detail' }] }, { stream: pipe, env: {} });
  assert.deepEqual(pipe.written, [`${expected}\n`]);
  const screen = terminal(24);
  await printWelcome({ title: 't', lines: [{ text: sneaky, state: 'failed' }] }, { stream: screen, env: {}, wait: async () => {} });
  const shown = screen.written.map(withoutColour);
  assert.ok(shown.includes(`  !! ${expected}\n`));
  for (const text of shown) assert.doesNotMatch(text.replace(/\n$/u, ''), /[\p{Cc}\p{Cf}]/u);
});

test('a pipe gets exactly the lines, at once; a terminal gets the frames with their waits', async () => {
  const pipe = { isTTY: false, written: [], write(text) { this.written.push(text); } };
  const waits = [];
  const wait = async ms => { waits.push(ms); };
  assert.equal(await printWelcome({ title: 't', lines, footer: 'f' }, { stream: pipe, env: {}, wait }), false);
  assert.deepEqual(pipe.written, piped, 'a terminal-only line is left out');
  assert.deepEqual(waits, []);

  const quiet = terminal(24);
  assert.equal(await printWelcome({ title: 't', lines, footer: 'f' }, { stream: quiet, env: { NO_COLOR: '1' }, wait }), false);
  assert.deepEqual(quiet.written, piped);

  const screen = terminal(24);
  assert.equal(await printWelcome({ title: 't', lines, footer: 'f' }, { stream: screen, env: {}, wait }), true);
  assert.ok(screen.written.length > lines.length);
  assert.ok(waits.length > 0);
  assert.ok(screen.written.every(text => text.endsWith('\n')));
  assert.ok(screen.written.some(text => text.includes(ESC)));
});

test('the installer reports each agent on its own, so the welcome can mark it', async t => {
  const home = await mkdtemp(join(tmpdir(), 'ctm-u9-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  // A dry run in an empty home, with both agent CLIs reported as not installed: nothing is
  // run and nothing is written.
  const env = { HOME: home, USERPROFILE: home, PATH: home, Path: home };
  const { ok, lines, sections } = setupAgents({ mode: 'install', agents: ['claude', 'codex'], dryRun: true, env, run: () => ({ missing: true }) });
  assert.equal(sections.length, 2);
  assert.deepEqual(sections.flatMap(section => section.lines), lines);
  assert.equal(sections.every(section => section.ok), ok);
  assert.match(sections[0].lines[0], /^Claude Code/u);
  assert.match(sections[1].lines[0], /^Codex/u);
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

test('review: only Node\'s own node:sqlite notice is hidden; other warnings still print', () => {
  assert.equal(isSqliteNotice(sqliteNotice, 'ExperimentalWarning'), true);
  assert.equal(isSqliteNotice(new Error(sqliteNotice), 'ExperimentalWarning'), true);
  assert.equal(isSqliteNotice(sqliteNotice, 'DeprecationWarning'), false);
  assert.equal(isSqliteNotice('SQLite sessions are experimental', 'ExperimentalWarning'), false);
  assert.equal(isSqliteNotice(`${sqliteNotice}!`, 'ExperimentalWarning'), false);
  // In a real process: the notice is dropped, a different SQLite warning and another type are kept.
  const quiet = pathToFileURL(fileURLToPath(new URL('../src/quiet.mjs', import.meta.url))).href;
  const script = [
    `import { hideSqliteNotice, sqliteNotice } from ${JSON.stringify(quiet)};`,
    'hideSqliteNotice();',
    "process.emitWarning(sqliteNotice, 'ExperimentalWarning');",
    "process.emitWarning('SQLite sessions are an experimental feature', 'ExperimentalWarning');",
    "process.emitWarning('something old is deprecated', 'DeprecationWarning');",
  ].join('\n');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.doesNotMatch(child.stderr, /SQLite is an experimental feature and might change/u);
  assert.match(child.stderr, /ExperimentalWarning: SQLite sessions are an experimental feature/u);
  assert.match(child.stderr, /DeprecationWarning: something old is deprecated/u);
});

test('the installed command does not show the node:sqlite notice', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ctm-u9-bin-'));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/context-ledger.mjs', import.meta.url)), 'start'], {
    env: { ...process.env, PORT: '0', CONTEXT_LEDGER_DB: join(dir, 'ledger.sqlite') }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    child.kill();
    await new Promise(resolve => { child.once('exit', resolve); if (child.exitCode !== null) resolve(); });
    await rm(dir, { recursive: true, force: true });
  });
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  let output = '';
  const timer = setTimeout(() => child.kill(), 15_000);
  for await (const chunk of child.stdout) {
    output += chunk;
    if (output.split('\n').length > 2) break;
  }
  clearTimeout(timer);
  assert.match(output, /^Context Ledger listening at http:\/\/127\.0\.0\.1:\d+\r?\n/u);
  assert.doesNotMatch(errors, /ExperimentalWarning: SQLite/u);
});

test('review: a reader that stops after the first line does not stop the server', async t => {
  // On Linux and macOS a write to the closed pipe is EPIPE; the server must keep running.
  const dir = await mkdtemp(join(tmpdir(), 'ctm-u9-pipe-'));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/server.mjs', import.meta.url))], {
    env: { ...process.env, PORT: '0', CONTEXT_LEDGER_DB: join(dir, 'ledger.sqlite') }, stdio: ['ignore', 'pipe', 'ignore'],
  });
  t.after(async () => {
    child.kill();
    await new Promise(resolve => { child.once('exit', resolve); if (child.exitCode !== null) resolve(); });
    await rm(dir, { recursive: true, force: true });
  });
  let output = '';
  let origin;
  const timer = setTimeout(() => child.kill(), 15_000);
  for await (const chunk of child.stdout) {
    output += chunk;
    origin = /listening at (http:\/\/127\.0\.0\.1:\d+)/u.exec(output)?.[1];
    // Leaving the loop closes this end of the pipe, as the other tests' readers do.
    if (origin) break;
  }
  clearTimeout(timer);
  assert.ok(origin, output);
  await new Promise(resolve => { setTimeout(resolve, 400); });
  assert.equal(child.exitCode, null, 'the server is still running');
  assert.equal((await fetch(origin + '/')).status, 200);
});

// Card U11: the start command's lines. A synthetic code; the server mints the real one.
const code = 'C0de-Synthetic_0123456789abcdefghijklmnopqrs';

test('U11: piped, start prints exactly the two plain lines it printed before', async () => {
  const pipe = { isTTY: false, written: [], write(text) { this.written.push(text); } };
  const lines = startLines({ port: 4317, code, seconds: 60, installed: true });
  assert.equal(await printWelcome({ title: 'local', lines, footer: 'Keep this window open.' }, { stream: pipe, env: {} }), false);
  assert.deepEqual(pipe.written, [
    'Context Ledger listening at http://127.0.0.1:4317\n',
    `Sign in to the browser app (one use, within 60 seconds): http://127.0.0.1:4317/login?code=${code}\n`,
  ]);
});

test('U11: at a terminal, start shows how to sign in, with the link on a line of its own', async () => {
  for (const [installed, login] of [[true, 'context-ledger login'], [false, 'npm run ledger -- login']]) {
    const tty = terminal(24);
    const lines = startLines({ port: 4317, code, seconds: 60, installed });
    assert.equal(await printWelcome({ title: 'local', lines }, { stream: tty, env: {}, wait: async () => {} }), true);
    const shown = tty.written.map(text => withoutColour(text).replace(/\n$/u, ''));
    const link = `http://127.0.0.1:4317/login?code=${code}`;
    assert.ok(shown.some(line => line.endsWith('Sign in: open this link in your browser within 60 seconds')), 'the step');
    assert.ok(shown.includes(`  ${link}`), 'the link alone on its line, two spaces in');
    assert.ok(shown.some(line => line.trim() === 'Ctrl+click it (Cmd+click on a Mac), or copy it into the address bar.'));
    assert.ok(shown.some(line => line.trim() === 'The console is at http://127.0.0.1:4317/console/'));
    assert.ok(shown.some(line => line.trim() === `The link works once. For a new one, run: ${login}`), login);
    // The plain sign-in sentence is for pipes only; a terminal does not get it as well.
    assert.ok(!shown.some(line => line.includes('Sign in to the browser app')));
    // Only colour codes, and nothing invisible once they are taken out.
    for (const text of tty.written) assert.doesNotMatch(withoutColour(text).replace(/\n$/u, ''), /\p{Cc}|\p{Cf}/u, text);
  }
});

test('U11: the sign-in link fits in 80 columns for every port', () => {
  for (const port of [1, 80, 4317, 54788, 65535]) {
    const lines = startLines({ port, code, seconds: 60, installed: true });
    const frame = welcomeFrames({ title: 'local', lines, depth: 24 }).map(({ text }) => withoutColour(text));
    const linkLine = frame.find(text => text.includes('/login?code='));
    assert.ok(linkLine.length <= 80, `port ${port}: ${linkLine.length} columns`);
  }
});

test('U11: a plainOnly line is left out at a terminal and a terminalOnly line in a pipe', async () => {
  const lines = [{ text: 'both' }, { text: 'pipe only', plainOnly: true }, { text: 'terminal only', terminalOnly: true }, { text: 'a link', state: 'link' }];
  const pipe = { isTTY: false, written: [], write(text) { this.written.push(text); } };
  await printWelcome({ title: 't', lines }, { stream: pipe, env: {} });
  assert.deepEqual(pipe.written, ['both\n', 'pipe only\n', 'a link\n']);
  const frames = welcomeFrames({ title: 't', lines, depth: 8 }).map(({ text }) => withoutColour(text));
  assert.ok(frames.some(text => text.endsWith('terminal only')));
  assert.ok(!frames.some(text => text.includes('pipe only')));
  assert.ok(frames.includes('  a link'), 'a link line has a two-space indent');
});

test('U11: the installed command is told apart from a checkout by the script node runs', () => {
  const windows = String.raw`C:\Users\leo\AppData\Roaming\npm\node_modules\@pricepepel\context-ledger\bin\context-ledger.mjs`;
  // U11 review: npx on Linux and macOS can start the bin through npm's .bin link.
  for (const script of [windows, '/usr/lib/node_modules/@pricepepel/context-ledger/bin/context-ledger.mjs', '/usr/local/bin/context-ledger',
    '/home/leo/.npm/_npx/4e59c1e0bc7fa72b/node_modules/.bin/context-ledger', String.raw`C:\Users\leo\proj\node_modules\.bin\context-ledger.cmd`]) {
    assert.equal(installedCommand(script), true, script);
  }
  for (const script of ['/home/leo/context-ledger/src/server.mjs', String.raw`C:\repo\src\server.mjs`, '/x/bin/context-ledger-other.mjs', undefined, '']) {
    assert.equal(installedCommand(script), false, String(script));
  }
});
