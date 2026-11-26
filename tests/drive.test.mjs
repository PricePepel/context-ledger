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
import { loadFeatures, repo, startLedger } from '../scripts/drive.mjs';

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
