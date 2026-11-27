// Card H9: scripts/check.mjs, the repo-wide invariant checks.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { checkFile, formatFinding } from '../scripts/check.mjs';

const run = promisify(execFile);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(repo, 'scripts', 'check.mjs');
const utf8 = text => Buffer.from(text, 'utf8');
const rules = findings => findings.map(finding => finding.rule);
const char = code => String.fromCodePoint(code);

test('raw control, format and separator characters are findings, named by code point', () => {
  for (const code of [0x07, 0x1b, 0x7f, 0x85, 0x200b, 0x202e, 0x2066, 0xfeff, 0x2028, 0x2029, 0xe0001]) {
    const findings = checkFile('src/a.mjs', utf8(`const a = 1;\nconst b = '${char(code)}';\n`));
    assert.equal(findings.length, 1, `U+${code.toString(16)}`);
    const [finding] = findings;
    assert.equal(finding.rule, 'raw-character');
    assert.equal(finding.line, 2);
    assert.equal(finding.column, 12);
    assert.match(finding.message, new RegExp(`U\\+${code.toString(16).toUpperCase().padStart(4, '0')}`, 'u'));
    assert.ok(!/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(formatFinding(finding)), 'the printed line has no raw character');
  }
});

test('tab, line feed and carriage return are allowed, in every kind of text file', () => {
  for (const path of ['src/a.mjs', 'docs/a.md', 'runtime/a.py', 'schemas/a.json']) {
    assert.deepEqual(checkFile(path, utf8('a\tb\r\nc\n')), [], path);
  }
  assert.deepEqual(rules(checkFile('docs/a.md', utf8(`shown as ${char(0x202e)}`))), ['raw-character']);
  assert.deepEqual(rules(checkFile('runtime/tests/test_a.py', utf8(`x = "${char(0x2028)}"`))), ['raw-character'], 'tests are not exempt from this rule');
});

test('a file that is not UTF-8 is a finding; known binary types are skipped', () => {
  assert.deepEqual(rules(checkFile('src/a.mjs', Buffer.from([0x61, 0xff, 0x62]))), ['utf8']);
  assert.deepEqual(checkFile('public/a.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x1b])), []);
  assert.deepEqual(checkFile('public/a.WOFF2', Buffer.from([0x00, 0xff])), []);
});

test('HTML sinks in browser or server code are findings', () => {
  const sinks = [
    'node.innerHTML = text;',
    'node.innerHTML += text;',
    'node.outerHTML = text;',
    "node.insertAdjacentHTML('beforeend', text);",
    'document.write(text);',
    'document.writeln(text);',
    'range.createContextualFragment(text);',
    "new DOMParser().parseFromString(text, 'text/html');",
    'frame.srcdoc = text;',
  ];
  for (const line of sinks) {
    for (const path of ['public/console/a.mjs', 'src/a.mjs', 'public/a.js', 'demo/a.cjs']) {
      assert.deepEqual(rules(checkFile(path, utf8(`${line}\n`))), ['html-sink'], `${path}: ${line}`);
    }
  }
  assert.deepEqual(rules(checkFile('public/a.html', utf8('<iframe srcdoc="<b>x</b>"></iframe>'))), ['html-sink']);
  const message = checkFile('public/a.mjs', utf8('node.innerHTML = text;'))[0].message;
  assert.match(message, /createElement/u);
  assert.match(message, /textContent/u);
});

test('safe DOM code, comparisons, reads, tests and docs pass the HTML rule', () => {
  const safe = [
    'node.textContent = text;',
    'const old = node.innerHTML;',
    "if (node.innerHTML === '') clear();",
    "const item = document.createElement('li');",
  ];
  for (const line of safe) assert.deepEqual(checkFile('public/a.mjs', utf8(line)), [], line);
  assert.deepEqual(checkFile('tests/e2e/a.test.mjs', utf8('assert.ok(!html.includes("innerHTML ="));\nnode.innerHTML = x;')), []);
  assert.deepEqual(checkFile('docs/a.md', utf8('Never use `node.innerHTML = text`.')), []);
});

test('listen must name the loopback host', () => {
  const pass = [
    "server.listen({ port, host: '127.0.0.1' }, () => {});",
    'server.listen(0, "127.0.0.1");',
    "server.listen({ port: 0, host: '127.0.0.1' }, ready);",
    "server.listen(\n  0,\n  '127.0.0.1',\n  () => console.log('up (ready)'),\n);",
  ];
  for (const line of pass) assert.deepEqual(checkFile('src/a.mjs', utf8(line)), [], line);
  const fail = [
    'server.listen(port);',
    "server.listen(port, '0.0.0.0');",
    "server.listen(port, '::');",
    "server.listen(port, 'localhost');",
    'server.listen(port, host);',
    "server.listen({ port, host: '0.0.0.0' });",
    "server.listen(port, () => log('127.0.0.1'));",
  ];
  for (const line of fail) {
    const findings = checkFile('scripts/a.mjs', utf8(line));
    assert.deepEqual(rules(findings), ['loopback-only'], line);
    assert.match(findings[0].message, /127\.0\.0\.1/u);
  }
  assert.deepEqual(checkFile('tests/a.test.mjs', utf8('server.listen(0);')), [], 'tests may listen on any port');
});

test('a printed path escapes control and bidi characters', () => {
  const path = `src/a${char(0x202e)}b${char(0x1b)}.mjs`;
  const line = formatFinding({ path, line: 3, column: 4, rule: 'raw-character', message: 'x' });
  assert.ok(!/[\p{Cc}\p{Cf}]/u.test(line));
  assert.match(line, /^src\/a\\u202eb\\u001b\.mjs:3:4 {2}raw-character {2}x$/u);
});

async function gitFolder(files) {
  const folder = await mkdtemp(join(tmpdir(), 'ledger-check-'));
  await run('git', ['init', '-q'], { cwd: folder });
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(folder, path)), { recursive: true });
    await writeFile(join(folder, path), text);
  }
  await run('git', ['add', '-A'], { cwd: folder });
  return folder;
}

test('the command prints one line per finding and exits 1, or exits 0 when clean', async () => {
  const bad = await gitFolder({ 'src/a.mjs': `const x = '${char(0x202e)}';\n`, 'public/b.mjs': 'node.innerHTML = x;\n', 'README.md': 'fine\n' });
  const clean = await gitFolder({ 'src/a.mjs': "server.listen(0, '127.0.0.1');\n" });
  try {
    const failure = await run(process.execPath, [script, bad]).then(() => null, error => error);
    assert.ok(failure, 'a finding fails the command');
    assert.equal(failure.code, 1);
    const lines = failure.stdout.trim().split(/\r?\n/u);
    assert.deepEqual(lines.slice(0, -1).sort(), [
      'public/b.mjs:1:5  html-sink  assigning HTML parses text as HTML; build nodes with createElement and set textContent instead; in a comment or string, reword it (AGENTS.md section 6)',
      'src/a.mjs:1:12  raw-character  raw U+202E; write it as an escape (\\u{...} in JavaScript, \\u.... in Python, the escape as text in Markdown) or String.fromCodePoint (AGENTS.md section 6)',
    ]);
    assert.equal(lines.at(-1), 'check: 3 files, 2 findings');
    const { stdout } = await run(process.execPath, [script, clean]);
    assert.equal(stdout.trim(), 'check: 1 file, no findings');
  } finally {
    await rm(bad, { recursive: true, force: true });
    await rm(clean, { recursive: true, force: true });
  }
});

// Codex review, round 1 (H9): one regression test per finding.
test('round 1 high: only a top-level host that is not overridden counts as loopback', () => {
  const fail = [
    "server.listen({ port: 0, metadata: { host: '127.0.0.1' } });",
    "server.listen({ port: 0, host: '127.0.0.1', host: '0.0.0.0' });",
    "server.listen({ host: '127.0.0.1', ...options });",
    'server.listen({ port: 0, host });',
    // Since round 6 a spread anywhere counts as not loopback: it may carry fd or path.
    "server.listen({ ...options, host: '127.0.0.1' });",
  ];
  for (const line of fail) assert.deepEqual(rules(checkFile('src/a.mjs', utf8(line))), ['loopback-only'], line);
  const pass = ["server.listen({ 'host': '127.0.0.1', port });"];
  for (const line of pass) assert.deepEqual(checkFile('src/a.mjs', utf8(line)), [], line);
});

test('round 1 medium: computed listen and a comment before the arguments are still checked', () => {
  for (const line of ["server['listen'](0);", 'server.listen /* start */ (0);', 'server\n  .listen(0);']) {
    assert.deepEqual(rules(checkFile('src/a.mjs', utf8(line))), ['loopback-only'], line);
  }
});

test('round 1 medium: computed keys, logical assignment and any-case srcdoc are HTML sinks', () => {
  const sinks = ["el['innerHTML'] = value;", 'el.innerHTML ??= value;', 'el.outerHTML ||= value;', 'el.innerHTML &&= value;', "frame.setAttribute('srcdoc', value);", "document['write'](value);"];
  for (const line of sinks) assert.deepEqual(rules(checkFile('public/a.mjs', utf8(line))), ['html-sink'], line);
  assert.deepEqual(rules(checkFile('public/a.html', utf8('<iframe SRCDOC="x"></iframe>'))), ['html-sink']);
});

test('round 1 medium: a comment inside listen arguments does not hide a loopback host', () => {
  for (const line of ["server.listen(0, /* local only */ '127.0.0.1');", "server.listen(\n  0, // any port\n  '127.0.0.1',\n);"]) {
    assert.deepEqual(checkFile('src/a.mjs', utf8(line)), [], line);
  }
  assert.deepEqual(rules(checkFile('src/a.mjs', utf8("server.listen(0, /* '127.0.0.1' */ '0.0.0.0');"))), ['loopback-only']);
});

// Round 2 showed that masking comments across a file can hide code (a regex, a template
// or an HTML attribute that looks like a comment). The code rules now read the text as
// it is, so a sink spelt in a comment or string is reported too; the message says to reword it.
test('round 2 medium: comments and strings are read as they are, so nothing can hide a sink', () => {
  const hidden = [
    'if (ok) /[//]/.test(text); el.innerHTML = value;',
    'const ratio = { valueOf: () => 6 } / 2; el.innerHTML = value;',
    'const s = `outer ${`https://example.test`}`; el.innerHTML = value;',
  ];
  for (const line of hidden) assert.deepEqual(rules(checkFile('public/a.mjs', utf8(line))), ['html-sink'], line);
  for (const html of ['<iframe title="<!--" srcdoc="hello"></iframe>', "<script>const start = '<!--'; el.innerHTML = value;</script>"]) {
    assert.deepEqual(rules(checkFile('public/a.html', utf8(html))), ['html-sink'], html);
  }
  const [comment] = checkFile('src/a.mjs', utf8('// Avoid document.write(text) here.'));
  assert.equal(comment.rule, 'html-sink');
  assert.match(comment.message, /in a comment or string, reword it/u);
});

test('round 2 high: a computed host key or an options object with a second argument is checked as Node reads it', () => {
  const fail = [
    "server.listen({ port: 0, host: '127.0.0.1', ['host']: '0.0.0.0' });",
    "server.listen({ port: 0, host: '127.0.0.1', [key]: value });",
    "server.listen({ port: 0, host: '0.0.0.0' }, '127.0.0.1');",
    "server.listen({ port: 0, host: '127.0.0.1', get host() { return '0.0.0.0'; } });",
  ];
  for (const line of fail) assert.deepEqual(rules(checkFile('src/a.mjs', utf8(line))), ['loopback-only'], line);
  assert.deepEqual(checkFile('src/a.mjs', utf8("server.listen({ ['host']: '127.0.0.1', port: 0 });")), []);
});

test('round 2 medium: an optional call is checked', () => {
  for (const line of ['server.listen?.(0);', 'server?.listen(0);', "server['listen']?.(0);"]) {
    assert.deepEqual(rules(checkFile('src/a.mjs', utf8(line))), ['loopback-only'], line);
  }
  assert.deepEqual(checkFile('src/a.mjs', utf8("server.listen?.(0, '127.0.0.1');")), []);
});

// Codex review, round 3 (H9).
// Round 5 tightened this: any variable may hold options, so only a literal port counts.
test('rounds 3 to 5: the (port, host) form counts only with a literal port number', () => {
  for (const line of ["server.listen(options, '127.0.0.1');", "server.listen(makeOptions(), '127.0.0.1');", "server.listen(handle, '127.0.0.1');", "server.listen(port, '127.0.0.1');", "server.listen(config.port, '127.0.0.1');"]) {
    assert.deepEqual(rules(checkFile('src/a.mjs', utf8(line))), ['loopback-only'], line);
  }
  for (const line of ["server.listen(0, '127.0.0.1');", "server.listen(4317, '127.0.0.1');", "server.listen({ port, host: '127.0.0.1' });"]) {
    assert.deepEqual(checkFile('src/a.mjs', utf8(line)), [], line);
  }
});

test('round 5: optional chaining before write, and a loop target, are HTML sinks', () => {
  for (const line of ['iframe.contentWindow.document?.write(transcript.text);', "frame.document?.['write'](text);", 'for (preview.innerHTML of messages) capture();', "for (preview['outerHTML'] in table) capture();"]) {
    assert.deepEqual(rules(checkFile('public/a.mjs', utf8(line))), ['html-sink'], line);
  }
});

test('round 6: an options key that may bind elsewhere makes listen count as not loopback', () => {
  for (const line of ["server.listen({ port: 4317, host: '127.0.0.1', fd: inheritedSocket });", "server.listen({ host: '127.0.0.1', path: socketPath });", "server.listen({ host: '127.0.0.1', handle });", "server.listen({ host: '127.0.0.1', [key]: value });", "server.listen({ host: '127.0.0.1', ...rest });"]) {
    assert.deepEqual(rules(checkFile('src/a.mjs', utf8(line))), ['loopback-only'], line);
  }
  assert.deepEqual(checkFile('src/a.mjs', utf8("server.listen({ port, host: '127.0.0.1', backlog: 64, exclusive: true, signal });")), []);
});

test('round 6: write on a variable that holds a document is an HTML sink', () => {
  for (const line of ['const doc = iframe.contentDocument; doc.write(transcript.text);', 'frame.contentDocument.writeln(text);', 'frameDoc?.write(text);']) {
    assert.deepEqual(rules(checkFile('public/a.mjs', utf8(line))), ['html-sink'], line);
  }
  assert.deepEqual(checkFile('src/a.mjs', utf8('stream.write(chunk);')), [], 'a stream in server code');
});

test('round 7: in browser code any write() call is a sink; setHTMLUnsafe and friends are sinks', () => {
  const browser = ['const preview = iframe.contentDocument; preview.write(transcript.text);', 'target.writeln(text);', "preview['write'](text);", 'preview.setHTMLUnsafe(transcript.text);', 'preview.setHTML(text);', 'Document.parseHTMLUnsafe(text);'];
  for (const line of browser) assert.deepEqual(rules(checkFile('public/console/a.mjs', utf8(line))), ['html-sink'], line);
  assert.deepEqual(checkFile('src/a.mjs', utf8('response.write(chunk); stream.write(line);')), [], 'server code writes streams');
});

test('round 7: a tracked file replaced by a folder before staging is skipped, not a crash', async () => {
  const folder = await gitFolder({ 'src/preview.mjs': 'export const a = 1;\n', 'src/b.mjs': `const x = '${char(0x202e)}';\n` });
  try {
    await rm(join(folder, 'src', 'preview.mjs'));
    await mkdir(join(folder, 'src', 'preview.mjs', 'parts'), { recursive: true });
    const failure = await run(process.execPath, [script, folder]).then(() => null, error => error);
    assert.equal(failure?.code, 1);
    assert.match(failure.stdout, /^src\/b\.mjs:1:12 {2}raw-character/mu);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('round 8: write() in an HTML page outside public/ is a sink too', () => {
  const page = '<script>const preview = iframe.contentDocument; preview.write(transcript.text);</script>';
  assert.deepEqual(rules(checkFile('demo/preview.html', utf8(page))), ['html-sink']);
});

test('round 8: a parent folder replaced by a file before staging is skipped, not a crash', async () => {
  const folder = await gitFolder({ 'src/preview/index.mjs': 'export const a = 1;\n', 'src/b.mjs': `const x = '${char(0x202e)}';\n` });
  try {
    await rm(join(folder, 'src', 'preview'), { recursive: true, force: true });
    await writeFile(join(folder, 'src', 'preview'), 'now a file\n');
    const failure = await run(process.execPath, [script, folder]).then(() => null, error => error);
    assert.equal(failure?.code, 1);
    assert.match(failure.stdout, /^src\/b\.mjs:1:12 {2}raw-character/mu);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('round 9: a module an HTML page loads, and what it imports, is browser code wherever it lives', async () => {
  const folder = await gitFolder({
    'demo/preview.html': '<script type="module" src="./preview.mjs"></script>\n',
    'demo/preview.mjs': "import { show } from './show.mjs';\nshow();\n",
    'demo/show.mjs': 'export function show() { const preview = iframe.contentDocument; preview.write(transcript.text); }\n',
    'demo/server.mjs': 'process.stdout.write(line);\n',
  });
  try {
    const failure = await run(process.execPath, [script, folder]).then(() => null, error => error);
    assert.equal(failure?.code, 1);
    assert.match(failure.stdout, /^demo\/show\.mjs:1:\d+ {2}html-sink {2}write\(\) in browser code/mu);
    assert.doesNotMatch(failure.stdout, /demo\/server\.mjs/u, 'a Node script beside it still writes streams');
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("round 9: execCommand('insertHTML') is an HTML sink", () => {
  assert.deepEqual(rules(checkFile('public/app.js', utf8("editor.focus(); document.execCommand('insertHTML', false, transcript.text);"))), ['html-sink']);
});

test('round 10: an HTML property name as a string in browser code, and listen passed along, are findings', () => {
  assert.deepEqual(rules(checkFile('public/swarm/a.mjs', utf8("const key = rich ? 'innerHTML' : 'textContent'; el('div', { [key]: text });"))), ['html-sink']);
  assert.deepEqual(checkFile('src/a.mjs', utf8("const key = 'innerHTML';")), [], 'server code may name it, for example in a check');
  for (const line of ['const listen = promisify(server.listen.bind(server)); await listen(port);', 'start(server.listen);']) {
    assert.deepEqual(rules(checkFile('src/a.mjs', utf8(line))), ['loopback-only'], line);
  }
});

test('round 5: the ledger server itself listens through a written-out options object', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(join(repo, 'src', 'server.mjs'), 'utf8');
  assert.match(source, /server\.listen\(\{ port, host: '127\.0\.0\.1' \}/u);
});

test('round 3 high: a regular expression in the arguments is not taken for a comment', () => {
  const line = "server.listen({\n  host: '127.0.0.1',\n  port: /x\\//.test(input) ? 3000 : 3001, ...config\n});";
  assert.deepEqual(rules(checkFile('src/a.mjs', utf8(line))), ['loopback-only']);
});

test('round 3 medium: a block comment between tokens does not hide a sink or a listen call', () => {
  assert.deepEqual(rules(checkFile('public/a.mjs', utf8('element.innerHTML /* replace preview */ = transcript;'))), ['html-sink']);
  assert.deepEqual(rules(checkFile('src/a.mjs', utf8('server. /* HTTP */ listen(3000);'))), ['loopback-only']);
});

test('round 3 medium: Object.assign and destructuring into an HTML property are sinks', () => {
  for (const line of ['Object.assign(element, { innerHTML: transcript });', "Object.assign(element, { 'outerHTML': transcript });", 'Object.assign(element, { innerHTML });', '({ html: element.innerHTML } = preview);', '[element.innerHTML] = parts;']) {
    assert.deepEqual(rules(checkFile('public/a.mjs', utf8(line))).slice(0, 1), ['html-sink'], line);
  }
  assert.deepEqual(checkFile('public/a.mjs', utf8('const old = element.innerHTML;\nconst size = old.length;')), []);
});

test('round 3 low: a file with very many findings is reported, not a crash', async () => {
  const folder = await gitFolder({ 'sample.log': '\0'.repeat(200000) });
  try {
    const failure = await run(process.execPath, [script, folder], { maxBuffer: 256 * 1024 * 1024 }).then(() => null, error => error);
    assert.equal(failure?.code, 1);
    assert.match(failure.stdout, /check: 1 file, 200000 findings/u);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

// Codex review, round 4 (H9).
test('round 4 medium: a name that only ends in "port" may hold options, so it does not count', () => {
  for (const line of ["server.listen(listenPort, '127.0.0.1');", "server.listen(defaultPort, '127.0.0.1');", "server.listen(report, '127.0.0.1');"]) {
    assert.deepEqual(rules(checkFile('src/a.mjs', utf8(line))), ['loopback-only'], line);
  }
});

test('round 4 medium: quoted computed keys are HTML writes too', () => {
  for (const line of ["Object.assign(preview, { ['innerHTML']: transcript.text });", "({ html: preview['innerHTML'] } = result);"]) {
    assert.deepEqual(rules(checkFile('public/a.mjs', utf8(line))).slice(0, 1), ['html-sink'], line);
  }
});

test('round 4 low: line and block comments between any two tokens do not hide a sink', () => {
  for (const text of ['document /* Render the transcript */ .write(transcript.text);', 'preview.innerHTML // Render the transcript preview\n  = transcript.text;']) {
    assert.deepEqual(rules(checkFile('public/a.mjs', utf8(text))), ['html-sink'], text);
  }
});

test('round 2 low: a file name that starts with U+FEFF is valid UTF-8', async () => {
  const folder = await gitFolder({ [`${char(0xfeff)}a.mjs`]: 'const x = 1;\n' });
  try {
    const failure = await run(process.execPath, [script, folder]).then(() => null, error => error);
    assert.ok(failure, 'the name itself holds a raw format character');
    assert.doesNotMatch(failure.stdout, /file name is not UTF-8/u);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('round 1 low: vendored files and test files beside the code are exempt from the code rules', () => {
  assert.deepEqual(checkFile('node_modules/pkg/a.js', utf8('document.write(text);')), []);
  assert.deepEqual(checkFile('src/feature.test.mjs', utf8('server.listen(0);')), []);
  assert.deepEqual(checkFile('public/a.spec.js', utf8('node.innerHTML = x;')), []);
  assert.deepEqual(rules(checkFile('src/contest.mjs', utf8('server.listen(0);'))), ['loopback-only'], 'a name that only contains "test" is not a test');
});

test('round 1 low: a lone carriage return ends a line in the reported position', () => {
  const [finding] = checkFile('src/a.mjs', utf8(`// first\r${char(0x07)}`));
  assert.equal(finding.line, 2);
  assert.equal(finding.column, 1);
});

test('round 1 low: a tracked submodule is skipped instead of stopping the scan', async () => {
  const folder = await gitFolder({ 'src/a.mjs': `const x = '${char(0x202e)}';\n` });
  try {
    await mkdir(join(folder, 'vendor', 'example'), { recursive: true });
    await run('git', ['update-index', '--add', '--cacheinfo', `160000,${'a'.repeat(40)},vendor/example`], { cwd: folder });
    const failure = await run(process.execPath, [script, folder]).then(() => null, error => error);
    assert.equal(failure?.code, 1);
    assert.match(failure.stdout, /^src\/a\.mjs:1:12 {2}raw-character/mu);
    assert.match(failure.stdout, /check: 1 file, 1 finding/u);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('round 1 medium: a file name that is not UTF-8 is still read, and reported', { skip: process.platform === 'win32' || process.platform === 'darwin' ? 'needs a file system that keeps raw name bytes' : false }, async () => {
  const folder = await gitFolder({});
  try {
    const name = Buffer.from([0x61, 0xff, 0x2e, 0x6d, 0x6a, 0x73]);
    await writeFile(Buffer.concat([Buffer.from(folder + '/'), name]), `const x = '${char(0x202e)}';\n`);
    await run('git', ['add', '-A'], { cwd: folder });
    const failure = await run(process.execPath, [script, folder]).then(() => null, error => error);
    assert.equal(failure?.code, 1);
    assert.match(failure.stdout, /utf8 {2}file name is not UTF-8/u);
    assert.match(failure.stdout, /raw-character {2}raw U\+202E/u);
    assert.ok(!/[\p{Cc}\p{Cf}]/u.test(failure.stdout.replace(/[\n\r]/gu, '')));
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('the repository itself has no findings', async () => {
  const { stdout } = await run(process.execPath, [script, repo]);
  assert.match(stdout.trim(), /^check: \d+ files, no findings$/u);
});

// Card H10: label lengths count code points.
test('card H10: a label length compared with a limit is a finding unless it counts code points', () => {
  const fail = [
    'if (label.length > 500) refuse();',
    'const ok = node.label.length <= maxLabel;',
    'if (maxLabel < editLabel.length) refuse();',
    'return finding?.label?.length >= 64;',
  ];
  for (const line of fail) {
    const findings = checkFile('src/a.mjs', utf8(line));
    assert.deepEqual(rules(findings), ['label-length'], line);
    assert.match(findings[0].message, /\[\.\.\.label\]\.length/u);
  }
  const pass = [
    'if ([...label].length > 500) refuse();',
    'if (Array.from(label).length > maxLabel) refuse();',
    'if (label.length < 1) refuse();',
    'if (label.length > 0) show();',
    'const width = labels.length * 8;',
    'if (labels.length > 3) more();',
    'if (node.edgeLabels.length >= 10) page();',
    'if (text.length > 500) cut();',
  ];
  for (const line of pass) assert.deepEqual(checkFile('src/a.mjs', utf8(line)), [], line);
  assert.deepEqual(checkFile('tests/a.test.mjs', utf8('assert.ok(label.length > 500);')), [], 'tests may count units');
});

test('card H10 review: any comparison spelling is caught; only exact emptiness tests pass', () => {
  const fail = [
    'if (label.length <= (500)) keep();',
    "if (node['label'].length <= 500) keep();",
    'if (getMaxLabel() >= label.length) keep();',
    'if (label.length <= 1) one();',
    'if (1 < label.length) many();',
    'if (labelText.length > limit) cut();',
  ];
  for (const line of fail) assert.deepEqual(rules(checkFile('src/a.mjs', utf8(line))), ['label-length'], line);
  const pass = [
    'if (label.length < 1) refuse();',
    'if (label.length > 0) show();',
    'if (label.length >= 1) show();',
    'if (0 < label.length) show();',
    'if (1 > label.length) refuse();',
    'if (1 <= label.length) show();',
    'const sizes = items.map(label => label.length);',
    "const labelParts = ['a', 'b', 'c', 'd']; if (labelParts.length > 3) trimParts();",
    'const width = label.length * 8;',
  ];
  for (const line of pass) assert.deepEqual(checkFile('src/a.mjs', utf8(line)), [], line);
});

test('card H10 review 2: a member chain, parentheses and a lone 0 or 1', () => {
  const fail = [
    'if (500 < node.label.length) reject();',
    'if ((label.length) > 500) reject();',
    'if (label.length < 1 + MAX_LABEL_LENGTH) keep();',
    'if (MAX + 1 > label.length) keep();',
    "if (graph.nodes[0]['label'].length > 500) cut();",
  ];
  for (const line of fail) assert.deepEqual(rules(checkFile('src/a.mjs', utf8(line))), ['label-length'], line);
  for (const line of ['if (!(label.length > 0)) refuse();', 'const empty = label.length < 1;', 'return (label.length >= 1) && ok;']) {
    assert.deepEqual(checkFile('src/a.mjs', utf8(line)), [], line);
  }
});

test('card H10 review 3: indexed and call receivers, and a parenthesized 0', () => {
  for (const line of ['if (500 < graph.nodes[0].label.length) reject();', 'if (500 < getNode().label.length) reject();', 'if (label.length < (1 + MAX)) keep();']) {
    assert.deepEqual(rules(checkFile('src/a.mjs', utf8(line))), ['label-length'], line);
  }
  assert.deepEqual(checkFile('src/a.mjs', utf8('if (label.length > (0)) show();')), []);
});

test('card H10 review 4: nested receivers, a parenthesized 1 in a sum, and a keyword before 0', () => {
  for (const line of ['if (label.length < (1) + MAX_LABEL_LENGTH) keep();', 'if (500 < getNode(getId()).label.length) reject();', "if (500 < getNode()['label'].length) reject();"]) {
    assert.deepEqual(rules(checkFile('src/a.mjs', utf8(line))), ['label-length'], line);
  }
  for (const line of ['return 0 < label.length;', 'if (label.length < 1) refuse();', 'const ok = (label.length > 0) ? a : b;']) {
    assert.deepEqual(checkFile('src/a.mjs', utf8(line)), [], line);
  }
});

test('card H10 review 5: nested indexes, keys ending in label, and a 0 before more code', () => {
  for (const line of ['if (500 < graph.nodes[indexes[0]].label.length) reject();', "if (node['editLabel'].length > 500) reject();", 'if (label.length < (1) + MAX) keep();']) {
    assert.deepEqual(rules(checkFile('src/a.mjs', utf8(line))), ['label-length'], line);
  }
  for (const line of ['if (label.length > 0) ++count;', 'if ((label.length > (0))) show();', 'if (label.length < 1) refuse();']) {
    assert.deepEqual(checkFile('src/a.mjs', utf8(line)), [], line);
  }
});

test('card H10 review 6: optional indexing before the label', () => {
  for (const line of ['if (500 < nodes?.[index]?.label?.length) reject();', 'if (nodes?.[index]?.label.length > 500) cut();']) {
    assert.deepEqual(rules(checkFile('src/a.mjs', utf8(line))), ['label-length'], line);
  }
});

test('card H10 review 7: the whole member chain before the label, across lines and groups', () => {
  const fail = [
    'if (500 < getNode(\n  graph,\n  nodeId,\n).label.length) return false;',
    'if (500 < (node ?? fallback).label.length) return false;',
    'if (500 < store.graphs[id].nodes.find(n => n.id === key).label.length) cut();',
  ];
  for (const text of fail) assert.deepEqual(rules(checkFile('src/a.mjs', utf8(text))), ['label-length'], text);
  for (const text of ['return 0 < node.label.length;', 'const ok = items.every(item => item.label.length > 0);', 'if (typeof label === "string" && label.length > 0) show();']) {
    assert.deepEqual(checkFile('src/a.mjs', utf8(text)), [], text);
  }
});
