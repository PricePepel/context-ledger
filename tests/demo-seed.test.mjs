import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { promisify } from 'node:util';

// B3: the demo seed must show the product's real saving, not a toy-sized negative one.
const run = promisify(execFile);
const driver = new URL('../.claude/skills/run-context-ledger/driver.mjs', import.meta.url).pathname;
const runDirs = () => readdirSync(tmpdir()).filter(name => name.startsWith('ledger-run-')).sort();

async function check(...flags) {
  try {
    const { stdout } = await run(process.execPath, [driver, 'check', ...flags]);
    return { code: 0, report: JSON.parse(stdout) };
  } catch (error) {
    return { code: error.code, report: JSON.parse(error.stdout) };
  }
}

test('the default demo seed saves more than 85% for both parties and cleans up', async () => {
  const before = runDirs();
  const { code, report } = await check();
  assert.equal(code, 0);
  assert.equal(report.ok, true);
  assert.equal(report.turns, 200);
  assert.ok(report.proposals > 3, 'a demo-scale room has more than the toy three proposals');
  for (const party of ['mara', 'teo']) {
    assert.ok(report.savedShare[party] > 0.85, `${party} saved ${report.savedShare[party]}`);
    assert.match(report.meter[party].method, /^estimate/u);
  }
  assert.deepEqual(runDirs(), before, 'the temp database directory is removed');
});

test('the toy two-turn scenario stays available and fails the saving check', async () => {
  const { code, report } = await check('--turns', '2');
  assert.equal(code, 1);
  assert.equal(report.ok, false);
  assert.equal(report.proposals, 3);
  assert.ok(report.savedShare.mara < 0, 'two turns are too small to save anything');
});

test('the seed is deterministic for a seed value', async () => {
  const first = (await check('--turns', '50', '--min-saved', '0')).report;
  const second = (await check('--turns', '50', '--min-saved', '0')).report;
  assert.deepEqual(first, second);
});
