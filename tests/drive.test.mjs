// Card H11: the feature map and the drive command, without a browser (the browser
// journey for every feature is tests/e2e/features.spec.mjs).
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { loadFeatures, onOrigin, redact, repo, signInLink, startLedger, uploadPath } from '../scripts/drive.mjs';

const run = promisify(execFile);
const script = join(repo, 'scripts', 'drive.mjs');

test('the feature map loads, ids are unique, and every uploaded file exists', () => {
  const features = loadFeatures();
  assert.ok(features.length >= 9);
  assert.equal(new Set(features.map(feature => feature.id)).size, features.length);
  for (const feature of features) {
    for (const step of feature.steps) if (step.upload) assert.ok(existsSync(join(repo, step.upload[1])), `${feature.id}: ${step.upload[1]}`);
  }
  for (const id of ['library-import', 'library-search', 'reader', 'room', 'node-review', 'console-live', 'console-demo', 'swarm', 'swarm-run']) {
    assert.ok(features.some(feature => feature.id === id), id);
  }
});

test('a broken feature map is refused with the entry named', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'ledger-features-'));
  try {
    const cases = [
      [{ version: 2, features: [] }, /version 1/u],
      [{ version: 1, features: [{ id: 'Bad Id', name: 'x', what: 'x', path: '/', steps: [{ click: 'a' }] }] }, /lowercase words/u],
      [{ version: 1, features: [{ id: 'a', name: 'x', what: 'x', path: 'console', steps: [{ click: 'a' }] }] }, /start with/u],
      [{ version: 1, features: [{ id: 'a', name: 'x', what: 'x', path: '/', steps: [{ eval: 'x' }] }] }, /each step is one of/u],
      [{ version: 1, features: [{ id: 'a', name: 'x', what: 'x', path: '/', steps: [{ click: 'a' }] }, { id: 'a', name: 'x', what: 'x', path: '/', steps: [{ click: 'a' }] }] }, /used twice/u],
    ];
    for (const [map, message] of cases) {
      const path = join(folder, 'features.json');
      await writeFile(path, JSON.stringify(map));
      assert.throws(() => loadFeatures(path), message);
    }
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('the command lists features, and refuses an unknown one or a remote URL', async () => {
  const { stdout } = await run(process.execPath, [script, '--list']);
  assert.match(stdout, /^library-import +Library: import a transcript:/mu);
  assert.match(stdout, /^swarm-run +Swarm: a simulated run:/mu);
  const unknown = await run(process.execPath, [script, 'no-such']).then(() => null, error => error);
  assert.equal(unknown?.code, 1);
  assert.match(unknown.stderr, /No feature "no-such"; node scripts\/drive\.mjs --list names them\./u);
  const remote = await run(process.execPath, [script, 'swarm', '--url', 'https://example.com']).then(() => null, error => error);
  assert.equal(remote?.code, 1);
  assert.match(remote.stderr, /--url must be a loopback ledger/u);
});

test('the command starts its own ledger on loopback, signs in once, and cleans up', async () => {
  const ledger = await startLedger();
  try {
    assert.match(ledger.origin, /^http:\/\/127\.0\.0\.1:\d+$/u);
    assert.ok(ledger.link.startsWith(`${ledger.origin}/login?code=`));
    const page = await fetch(ledger.link, { redirect: 'manual' });
    assert.equal(page.status, 303, 'the one-time link signs in');
    const again = await fetch(ledger.link, { redirect: 'manual' });
    assert.notEqual(again.status, 303, 'and works only once');
  } finally {
    await ledger.stop();
  }
});

// H11 Codex review, round 1.
test('review: feature paths and sign-in links stay on the ledger origin', async () => {
  assert.equal(onOrigin('http://127.0.0.1:4317', '/console/'), 'http://127.0.0.1:4317/console/');
  for (const path of ['//example.com/x', 'https://example.com/', 'http://127.0.0.1:9999/']) {
    assert.throws(() => onOrigin('http://127.0.0.1:4317', path), /away from the ledger/u, path);
  }
  const folder = await mkdtemp(join(tmpdir(), 'ledger-features-'));
  try {
    const backslash = String.fromCharCode(92);
    for (const path of ['//example.com/', `/${backslash}example.com/`]) {
      const file = join(folder, 'features.json');
      await writeFile(file, JSON.stringify({ version: 1, features: [{ id: 'a', name: 'x', what: 'x', path, steps: [{ click: 'a' }] }] }));
      assert.throws(() => loadFeatures(file), /stay on the ledger/u, path);
    }
  } finally {
    await rm(folder, { recursive: true, force: true });
  }

  // A ledger that redirects the token request, or answers with a link elsewhere, is refused.
  for (const respond of [
    (request, response) => { response.writeHead(307, { Location: 'http://127.0.0.1:1/api/login' }); response.end(); },
    (request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ path: '//example.com/login?code=abc' })); },
  ]) {
    const server = createServer(respond);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      await assert.rejects(signInLink(`http://127.0.0.1:${server.address().port}`, 'token'), /refused|unexpected link/u);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  }
});

test('review: uploads come only from the repository fixtures', () => {
  assert.equal(uploadPath('demo/leo-orbit.jsonl'), join(repo, 'demo', 'leo-orbit.jsonl'));
  for (const file of ['../secret.jsonl', 'demo/../../x.jsonl', 'src/server.mjs', join(tmpdir(), 'x.jsonl')]) {
    assert.throws(() => uploadPath(file), /must be a fixture/u, file);
  }
});

test('review: sign-in codes are redacted, and --out may not be a network path', async () => {
  assert.equal(redact('goto http://127.0.0.1:1/login?code=AbC_12-x failed'), 'goto http://127.0.0.1:1/login?code=<redacted> failed');
  const backslash = String.fromCharCode(92);
  const unc = `${backslash}${backslash}server${backslash}share${backslash}proof.png`;
  const share = await run(process.execPath, [script, 'swarm', '--out', unc]).then(() => null, error => error);
  assert.equal(share?.code, 1);
  assert.match(share.stderr, /--out must be a local file/u);
});

// H11 Codex review, round 2.
test('review 2: a mixed-slash network --out is refused', async () => {
  const backslash = String.fromCharCode(92);
  const share = await run(process.execPath, [script, 'swarm', '--out', `${backslash}/server/share/proof.png`]).then(() => null, error => error);
  assert.equal(share?.code, 1);
  assert.match(share.stderr, /--out must be a local file/u);
});

test('review 2: a fixture that is a link to a file outside the repository is refused', async t => {
  const outside = await mkdtemp(join(tmpdir(), 'ledger-outside-'));
  const link = join(repo, 'demo', `h11-link-${process.pid}.jsonl`);
  try {
    await writeFile(join(outside, 'secret.jsonl'), '{}\n');
    try {
      const { symlink } = await import('node:fs/promises');
      await symlink(join(outside, 'secret.jsonl'), link, 'file');
    } catch (error) {
      t.skip(`cannot create a symbolic link here (${error.code})`);
      return;
    }
    assert.throws(() => uploadPath(`demo/h11-link-${process.pid}.jsonl`), /must be a fixture/u);
  } finally {
    await rm(link, { force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

// Round 3: the round 2 version never started a ledger. This one starts a real ledger whose
// database path is a folder, so the server itself exits before it is ready.
test('review 2 and 3: a ledger that stops before it is ready fails at once and leaves no folder', async () => {
  const { readdirSync } = await import('node:fs');
  const folders = () => readdirSync(tmpdir()).filter(name => name.startsWith('ledger-drive-')).sort();
  const before = folders();
  const notAFile = await mkdtemp(join(tmpdir(), 'ledger-not-a-file-'));
  let spawned = false;
  const started = Date.now();
  try {
    await assert.rejects(startLedger({ env: { CONTEXT_LEDGER_DB: notAFile }, onSpawn: () => { spawned = true; } }), /The ledger stopped/u);
    assert.ok(Date.now() - started < 20_000, `took ${Date.now() - started} ms`);
    assert.ok(spawned, 'onSpawn hands over stop() before the ledger is ready');
    assert.deepEqual(folders(), before);
  } finally {
    await rm(notAFile, { recursive: true, force: true });
  }
});

test('review 5: an option given where a value belongs is refused', async () => {
  for (const args of [['swarm', '--url', '--list'], ['swarm', '--out', '--list']]) {
    const failure = await run(process.execPath, [script, ...args]).then(() => null, error => error);
    assert.equal(failure?.code, 1);
    assert.match(failure.stderr, /needs a value/u, args.join(' '));
  }
});
