import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { maxMessageBytes, openStore } from '../src/store.mjs';
import { terminalLine } from '../src/text.mjs';
import { bearer, ledgerToken } from './ledger-auth.mjs';

// Card I1: import a transcript file by path, read as a stream. Synthetic transcripts only.
const claudeLine = (role, text) => JSON.stringify({ type: role, message: { role, content: text } });
const toolLine = output => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: output }] } });
const codexLine = (role, text) => JSON.stringify({
  type: 'response_item',
  payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] },
});

async function folder(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-i1-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

// The first read chunk is 64 KiB, so this puts a three-byte character across its end.
const chunkEdge = 64 * 1024;
const euro = String.fromCodePoint(0x20ac);
function acrossChunk() {
  const prefix = JSON.stringify({ type: 'user', message: { role: 'user', content: '' } }).length - 3;
  const filler = 'a'.repeat(chunkEdge - prefix - 1);
  return claudeLine('user', `${filler}${euro} split across the chunk`);
}

const fixtures = {
  'CRLF and blank lines': ['claude', Buffer.from([claudeLine('user', 'Plan Atlas.'), '', claudeLine('assistant', 'Use the canary.'), ''].join('\r\n'))],
  'byte-order mark': ['claude', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(claudeLine('user', 'BOM first line.'))])],
  'no final line break, unreadable lines': ['codex', Buffer.from([codexLine('user', 'Pin Orion.'), 'not json', codexLine('assistant', 'Pinned.'), '{"cut'].join('\n'))],
  'multi-byte character across a chunk': ['claude', Buffer.from([acrossChunk(), claudeLine('assistant', `Price ${euro}5.`)].join('\n'))],
  'invalid UTF-8 byte': ['claude', Buffer.concat([Buffer.from(claudeLine('user', 'Bad byte: X').slice(0, -3)), Buffer.from([0xff]), Buffer.from('"}}')])],
};

for (const [name, [provider, bytes]] of Object.entries(fixtures)) {
  test(`I1: a file import stores exactly what a browser import stores (${name})`, async t => {
    const directory = await folder(t);
    const path = join(directory, 'session.jsonl');
    await writeFile(path, bytes);
    const fromFile = openStore(':memory:');
    const fromText = openStore(':memory:');
    // File.text() in the browser decodes like TextDecoder: UTF-8, BOM dropped, bad bytes replaced.
    const transcript = new TextDecoder('utf-8').decode(bytes);
    const a = await fromFile.importTranscriptFile({ provider, path });
    const b = fromText.importTranscript({ provider, source: 'session.jsonl', transcript });
    assert.deepEqual(a, b);
    assert.deepEqual(fromFile.get(a.id), fromText.get(b.id));
    // Both ways into one store give one session.
    assert.deepEqual(fromFile.importTranscript({ provider, source: 'session.jsonl', transcript }), a);
    assert.equal(fromFile.list('', null).length, 1);
  });
}

test('I1 review: the Codex parity case really keeps lines 1 and 3 and skips 2 and 4', async t => {
  const directory = await folder(t);
  const path = join(directory, 'orion.jsonl');
  await writeFile(path, fixtures['no final line break, unreadable lines'][1]);
  const store = openStore(':memory:');
  const summary = await store.importTranscriptFile({ provider: 'codex', path });
  assert.deepEqual(summary.skipped, { count: 2, lines: [2, 4] });
  assert.deepEqual(store.get(summary.id).messages.map(message => message.line), [1, 3]);
});

test('I1 review: a line at the line limit is read and a longer one is skipped and counted, before it is joined', async t => {
  const directory = await folder(t);
  const path = join(directory, 'limit.jsonl');
  const fits = claudeLine('user', 'a'.repeat(100));
  const tooLong = toolLine('b'.repeat(500));
  await writeFile(path, [fits, tooLong, claudeLine('assistant', 'After the long line.')].join('\n'));
  const store = openStore(':memory:');
  const summary = await store.importTranscriptFile({ provider: 'claude', path }, { lineLimit: fits.length });
  assert.deepEqual(summary.skipped, { count: 1, lines: [2] });
  assert.deepEqual(store.get(summary.id).messages.map(message => message.line), [1, 3]);
  // One character less and the first line is too long as well.
  const other = openStore(':memory:');
  const tighter = await other.importTranscriptFile({ provider: 'claude', path }, { lineLimit: fits.length - 1 });
  assert.deepEqual(tighter.skipped, { count: 2, lines: [1, 2] });
});

test('I1 review: more messages than one session can hold are refused, counted in UTF-8 bytes', async t => {
  const directory = await folder(t);
  const message = 'This transcript has more than 64 MiB of messages, more than one session can hold.';
  // Round 2: CJK text is three bytes a character, so 24 Mi characters are about 72 MiB.
  const cjk = join(directory, 'cjk.jsonl');
  const third = String.fromCodePoint(0x6f22).repeat(Math.ceil(maxMessageBytes / 3 / 2) + 1);
  await writeFile(cjk, [claudeLine('user', third), claudeLine('assistant', third)].join('\n'));
  const store = openStore(':memory:');
  await assert.rejects(store.importTranscriptFile({ provider: 'claude', path: cjk }), { message });
  // Round 2: many small messages count their stored size too, not only their text.
  const small = join(directory, 'small.jsonl');
  const line = claudeLine('user', 'k');
  const count = Math.ceil(maxMessageBytes / JSON.stringify({ role: 'user', text: 'k', line: 9_999_999 }).length) + 1;
  await writeFile(small, (line + '\n').repeat(count));
  await assert.rejects(store.importTranscriptFile({ provider: 'claude', path: small }), { message });
  assert.deepEqual(store.list('', null), []);
});

test('I1 review: the line limit counts UTF-8 bytes', async t => {
  const directory = await folder(t);
  const path = join(directory, 'bytes.jsonl');
  const wide = claudeLine('user', String.fromCodePoint(0x6f22).repeat(20));
  await writeFile(path, [wide, claudeLine('assistant', 'After.')].join('\n'));
  const store = openStore(':memory:');
  // The line is under 100 characters but over 100 bytes.
  assert.ok(wide.length < 100 && Buffer.byteLength(wide) > 100);
  const summary = await store.importTranscriptFile({ provider: 'claude', path }, { lineLimit: 100 });
  assert.deepEqual(summary.skipped, { count: 1, lines: [1] });
});

test('I1 review: the CLI error line escapes line breaks and joiners too', () => {
  const zwj = String.fromCodePoint(0x200d);
  const line = terminalLine(`one${String.fromCodePoint(10)}two${zwj}`);
  assert.equal(line, 'one\\u000atwo\\u200d');
});

test('I1 review: the title is the same as before for long and odd first messages', () => {
  const old = text => Array.from(text.trim().replace(/\s+/gu, ' ')).slice(0, 120).join('');
  const emoji = String.fromCodePoint(0x1f600);
  const samples = [
    ' '.repeat(5000) + 'Leading space then text',
    'word '.repeat(200),
    `${'a'.repeat(119)} ${emoji}tail`,
    `${'a'.repeat(119)}${emoji}tail`,
    `${'b'.repeat(119)}\t\n  \u00a0next`.replace('\\u00a0', String.fromCodePoint(0xa0)),
    'x'.repeat(3 * 1024 * 1024),
    `tab\tand\r\nlines`,
  ];
  for (const text of samples) {
    const store = openStore(':memory:');
    const { title } = store.importTranscript({ provider: 'claude', source: 't.jsonl', transcript: claudeLine('user', text) });
    assert.equal(title, old(text));
  }
});

test('I1 review: a FIFO is refused without being opened', { skip: process.platform === 'win32' && 'no FIFOs on Windows' }, async t => {
  const directory = await folder(t);
  const path = join(directory, 'pipe.jsonl');
  execFileSync('mkfifo', [path]);
  const store = openStore(':memory:');
  const result = await Promise.race([
    store.importTranscriptFile({ provider: 'claude', path }).then(() => 'imported', error => error.message),
    new Promise(resolve => setTimeout(() => resolve('hung'), 3000)),
  ]);
  assert.equal(result, 'The transcript must be a regular file.');
});

test('I1: a Claude Code file over 20 MiB, mostly tool output, imports with its messages and line numbers', async t => {
  const directory = await folder(t);
  const path = join(directory, 'big.jsonl');
  const lines = [claudeLine('user', 'Profile the Vega build.')];
  for (let index = 0; index < 21; index += 1) lines.push(toolLine('x'.repeat(1024 * 1024)));
  lines.push(claudeLine('assistant', 'The link step is the slow one.'));
  await writeFile(path, lines.join('\n'));
  const store = openStore(':memory:');
  const summary = await store.importTranscriptFile({ provider: 'claude', path });
  assert.equal(summary.source, 'big.jsonl');
  assert.equal(summary.messageCount, 2);
  assert.deepEqual(store.get(summary.id).messages.map(message => message.line), [1, 23]);
});

test('I1: a line of several MiB, read in many chunks, is one line', async t => {
  const directory = await folder(t);
  const path = join(directory, 'long.jsonl');
  const text = 'y'.repeat(5 * 1024 * 1024);
  await writeFile(path, [claudeLine('user', 'Start.'), claudeLine('assistant', text), claudeLine('user', 'Thanks.')].join('\n'));
  const store = openStore(':memory:');
  const summary = await store.importTranscriptFile({ provider: 'claude', path });
  const messages = store.get(summary.id).messages;
  assert.deepEqual(messages.map(message => [message.line, message.text.length]), [[1, 6], [2, text.length], [3, 7]]);
});

test('I1: a missing file, a folder, a file with nothing readable or a wrong provider is refused, and nothing is stored', async t => {
  const directory = await folder(t);
  const store = openStore(':memory:');
  const notes = join(directory, 'notes.txt');
  await writeFile(notes, 'first note\nsecond note\n');
  await mkdir(join(directory, 'a-folder.jsonl'));
  const cases = [
    [{ provider: 'claude', path: join(directory, 'missing.jsonl') }, 'Cannot read the transcript file.'],
    [{ provider: 'claude', path: join(directory, 'a-folder.jsonl') }, 'The transcript must be a regular file.'],
    [{ provider: 'claude', path: notes }, 'Invalid JSONL at line 1.'],
    [{ provider: 'gemini', path: notes }, 'Choose Claude Code or Codex as the provider.'],
  ];
  for (const [input, message] of cases) await assert.rejects(store.importTranscriptFile(input), { message });
  assert.deepEqual(store.list('', null), []);
});

function cli(args, env) {
  const child = spawn(process.execPath, ['src/cli.mjs', ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  return new Promise(resolve => child.on('close', code => resolve({ code, stdout, stderr })));
}

test('I1: the CLI imports into the ledger database without a server, prints escaped JSON, and keeps paths out of errors', async t => {
  const directory = await folder(t);
  const database = join(directory, 'ledger.sqlite');
  const path = join(directory, 'cygnus.jsonl');
  await writeFile(path, [claudeLine('user', 'Where does the Cygnus log go?'), 'garbage', claudeLine('assistant', 'Into cygnus.log.')].join('\n'));

  const done = await cli(['import', '--provider', 'claude', path], { CONTEXT_LEDGER_DB: database, PORT: '1' });
  assert.equal(done.code, 0, done.stderr);
  const printed = JSON.parse(done.stdout);
  assert.equal(printed.session.source, 'cygnus.jsonl');
  assert.equal(printed.session.messageCount, 2);
  assert.deepEqual(printed.skipped, { count: 1, lines: [2] });
  const count = () => { const store = openStore(database); try { return store.list('', null).length; } finally { store.close(); } };
  assert.equal(count(), 1);

  const secret = join(directory, 'private-name-x.jsonl');
  const missing = await cli(['import', '--provider', 'claude', secret], { CONTEXT_LEDGER_DB: database });
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /Cannot read the transcript file\./u);
  assert.doesNotMatch(missing.stderr, /private-name-x/u);
  const wrong = await cli(['import', '--provider', 'gemini', path], { CONTEXT_LEDGER_DB: database });
  assert.equal(wrong.code, 1);
  assert.match(wrong.stderr, /Provider must be claude or codex\./u);
  assert.equal(count(), 1);

  // Review: a bad option with a bidi control and a database that cannot open never reach
  // the terminal raw.
  const rlo = String.fromCodePoint(0x202e);
  const odd = await cli(['import', '--provider', 'claude', `--x${rlo}y`, path], { CONTEXT_LEDGER_DB: database });
  assert.equal(odd.code, 1);
  assert.ok(!odd.stderr.includes(rlo), 'no raw bidi control on stderr');
  assert.match(odd.stderr, /Usage: npm run ledger/u);
  const blocked = join(directory, 'not-a-folder');
  await writeFile(blocked, 'a file where the database folder should be');
  const noDatabase = await cli(['import', '--provider', 'claude', path], { CONTEXT_LEDGER_DB: join(blocked, 'secret-db-name', 'ledger.sqlite') });
  assert.equal(noDatabase.code, 1);
  assert.match(noDatabase.stderr, /Cannot open the ledger database\./u);
  assert.doesNotMatch(noDatabase.stderr, /secret-db-name/u);
});

test('I1 review: the CLI and a running server import the same file at once into one session', async t => {
  // One cleanup, in order: stop the server, then remove its folder (Windows locks open files).
  const directory = await mkdtemp(join(tmpdir(), 'ledger-i1-'));
  let server;
  t.after(async () => {
    if (server && server.exitCode === null) { server.kill(); await once(server, 'exit'); }
    await rm(directory, { recursive: true, force: true });
  });
  const database = join(directory, 'ledger.sqlite');
  const path = join(directory, 'lyra.jsonl');
  const transcript = [claudeLine('user', 'Shared Lyra import.'), claudeLine('assistant', 'Both at once.')].join('\n');
  await writeFile(path, transcript);
  server = spawn(process.execPath, ['src/server.mjs'], { env: { ...process.env, PORT: '0', CONTEXT_LEDGER_DB: database }, stdio: ['ignore', 'pipe', 'inherit'] });
  let output = '';
  let origin;
  for await (const chunk of server.stdout) {
    output += chunk;
    origin = output.match(/listening at (http:\/\/127\.0\.0\.1:\d+)/u)?.[1];
    if (origin) break;
  }
  // P1e: the server's API needs the token it wrote next to its database.
  const auth = bearer(await ledgerToken(database, Number(new URL(origin).port)));
  const viaServer = () => fetch(`${origin}/api/import`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ provider: 'claude', source: 'lyra.jsonl', transcript }),
  }).then(response => response.json());
  const [a, b, c] = await Promise.all([viaServer(), cli(['import', '--provider', 'claude', path], { CONTEXT_LEDGER_DB: database }), viaServer()]);
  assert.equal(b.code, 0, b.stderr);
  const fromCli = JSON.parse(b.stdout).session;
  assert.equal(a.session.id, fromCli.id);
  assert.equal(c.session.id, fromCli.id);
  const sessions = await (await fetch(`${origin}/api/sessions`, { headers: auth })).json();
  assert.equal(sessions.sessions.filter(session => session.id === fromCli.id).length, 1);
  assert.equal(sessions.sessions.length, 1);
});
