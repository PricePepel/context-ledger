import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkInputs, costs, deterministicPart, handledSignals, maxSize, prefixStability, prices, runBenchmark } from '../bench/m0.mjs';
import { renderMarkdown } from '../bench/report.mjs';
import { deriveSeed, generateParty } from '../bench/synth.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

const options = { seed: 7, sizes: [10, 30, 60], reps: 2, append: 3 };

function serverStopped(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === 'ESRCH';
  }
}

test('synthetic transcripts are seeded and the base is a byte prefix of the appended one', () => {
  const first = generateParty('b', 20, 3, 4);
  assert.deepEqual(generateParty('b', 20, 3, 4), first);
  assert.notEqual(generateParty('b', 20, 4, 4).base, first.base);
  assert.ok(first.extended.startsWith(first.base + '\n'));
  // Source files stay free of raw control and format characters; generated text too.
  assert.doesNotMatch(first.extended, /[\p{Cf}\p{Zl}\p{Zp}]/u);
});

test('the M0 benchmark is deterministic, lossless on planted facts and cleans up', async () => {
  const first = await runBenchmark(options);
  const second = await runBenchmark(options);

  assert.deepEqual(deterministicPart(second.report), deterministicPart(first.report));
  for (const run of [first, second]) {
    assert.equal(existsSync(run.harness.tempDir), false, 'temp database directory removed');
    assert.equal(serverStopped(run.harness.serverPid), true, 'server stopped');
  }

  const { results } = first.report;
  assert.deepEqual(results.map(result => result.size), options.sizes);
  for (const result of results) {
    assert.deepEqual(result.proposalTypes, ['answers', 'conflicts', 'matches']);
    for (const party of Object.values(result.parties)) {
      assert.equal(party.recall.graph.recall, 1);
      assert.equal(party.recall.handoff.recall, 1);
      assert.equal(party.cachePrefix.revisedRecall.recall, 1);
      if (party.recall.links) assert.equal(party.recall.links.recall, 1);
      assert.deepEqual(party.orderInvariance, { inputReordered: true, sameGraphId: true, identicalContext: true });
      // The as-is handoff prefix is cut by the session ID line only; with IDs held
      // constant the handoff is append-only after it.
      const prefix = party.cachePrefix;
      assert.equal(prefix.handoffPrefixEndsInSessionLine, true);
      assert.ok(prefix.idsHeldConstant.handoff.share > prefix.handoff.share);
      assert.ok(prefix.idsHeldConstant.handoff.share > 0.5, `handoff share with IDs constant: ${prefix.idsHeldConstant.handoff.share}`);
      for (const latency of Object.values(result.latencyMs)) assert.ok(latency.p50 >= 0 && latency.p95 >= latency.p50);
    }
  }
  for (const name of ['mara', 'teo']) {
    const saved = results.map(result => result.parties[name].size.savedShare);
    assert.ok(saved.every((share, index) => index === 0 || share > saved[index - 1]), `${name} saved share grows: ${saved}`);
    const constant = results.map(result => result.parties[name].cachePrefix.idsHeldConstant.handoff.share);
    assert.ok(constant.every((share, index) => index === 0 || share > constant[index - 1]), `${name} handoff prefix share grows: ${constant}`);
  }
  assert.equal(typeof first.report.gitDirty, 'boolean');
  assert.doesNotMatch(first.markdown, /below the cache minimum at every size/u);

  assert.match(first.markdown, /## Method and limits/u);
  assert.match(first.markdown, /node bench\/m0\.mjs --seed 7 --sizes 10,30,60 --reps 2 --append 3/u);
});

test('the cache-prefix conclusion follows the data, not fixed text', async () => {
  const { report } = await runBenchmark({ seed: 7, sizes: [10], reps: 1, append: 3 });
  const eligible = { prefixChars: 8000, newChars: 9000, share: 0.889, prefixTokensEstimate: 2000, cacheEligible: true };
  for (const party of Object.values(report.results[0].parties)) party.cachePrefix.graph = { ...eligible, share: 0.99 };
  const markdown = renderMarkdown(report);
  assert.match(markdown, /graph context at 10 turns/u);
  assert.match(markdown, /At every size the graph context keeps a larger share/u);
  for (const party of Object.values(report.results[0].parties)) party.cachePrefix.graph = { ...eligible, share: 0.01, cacheEligible: false };
  const other = renderMarkdown(report);
  assert.match(other, /graph context at no size/u);
  assert.match(other, /not the more cache-stable format here/u);
});

test('an error inside a size measurement still stops the server and removes the temp database', async () => {
  let pid;
  await assert.rejects(runBenchmark({ seed: 7, sizes: [10], reps: 1, append: 3, beforeSize: () => {
    throw new Error('injected failure');
  } }), error => {
    assert.equal(error.message, 'injected failure');
    assert.equal(existsSync(error.harness.tempDir), false, 'temp database directory removed');
    pid = error.harness.serverPid;
    assert.ok(pid > 0);
    return true;
  });
  assert.equal(serverStopped(pid), true, 'server stopped');
});

test('inputs beyond the server and schema limits are rejected before any import', () => {
  assert.equal(maxSize, 9215);
  assert.doesNotThrow(() => checkInputs({ seed: 1, sizes: [2, 10], append: 1 }));
  assert.throws(() => checkInputs({ seed: 1, sizes: [maxSize + 1], append: 1 }), /9215 turns.*100 nodes/u);
  assert.throws(() => checkInputs({ seed: 1, sizes: [1], append: 1 }), /out of range/u);
  assert.throws(() => checkInputs({ seed: 2 ** 32, sizes: [10], append: 1 }), /--seed/u);
  assert.throws(() => checkInputs({ seed: -1, sizes: [10], append: 1 }), /--seed/u);
  assert.throws(() => checkInputs({ seed: 1, sizes: [10], append: 0 }), /--append/u);
});

test('every seed gives the two parties independent PRNG streams', () => {
  for (const seed of [0, 1, 42, 4_000_000, 2 ** 31, 2 ** 32 - 1]) {
    assert.notEqual(deriveSeed(seed, 1), deriveSeed(seed, 2), `seed ${seed}`);
    assert.notEqual(generateParty('a', 10, seed).facts.map(fact => fact.label).join(), generateParty('b', 10, seed).facts.map(fact => fact.label).join());
  }
  assert.notEqual(deriveSeed(0, 1), deriveSeed(2 ** 32 - 1, 1));
  assert.throws(() => deriveSeed(2 ** 32, 1), RangeError);
  assert.throws(() => deriveSeed(1e10, 1), RangeError);
});

// Signals cannot be delivered to a handler on Windows, where process.kill always terminates.
const signalTests = process.platform === 'win32' ? [] : handledSignals;
for (const signal of signalTests) {
  test(`${signal} to the benchmark process stops the server and removes the temp database`, async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'context-ledger-bench-signal-'));
    const temp = join(scratch, 'tmp');
    mkdirSync(temp);
    try {
      const child = spawn(process.execPath, ['bench/m0.mjs', '--sizes', '1000,1000,1000', '--reps', '500', '--markdown', join(scratch, 'out.md')], {
        cwd: root, env: { ...process.env, TMPDIR: temp, TEMP: temp, TMP: temp }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      const serverPid = await new Promise((resolve, reject) => {
        child.stderr.setEncoding('utf8').on('data', chunk => {
          stderr += chunk;
          const match = stderr.match(/server pid (\d+)/u);
          if (match) resolve(Number(match[1]));
        });
        child.once('exit', () => reject(new Error(`benchmark exited before the server started: ${stderr}`)));
      });
      const exited = new Promise(resolve => child.once('exit', (code, signalName) => resolve({ code, signalName })));
      child.kill(signal);
      const { code } = await exited;
      assert.equal(code, 128 + { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 }[signal]);
      assert.match(stderr, new RegExp(`interrupted by ${signal}`, 'u'));
      assert.deepEqual(readdirSync(temp), [], 'temp database directory removed');
      assert.equal(existsSync(join(scratch, 'out.md')), false, 'no report written');
      for (let wait = 0; wait < 50 && !serverStopped(serverPid); wait += 1) await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(serverStopped(serverPid), true, 'server stopped');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
}

test('a signal during server start-up still ends the run without a report', { skip: process.platform === 'win32' }, async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'context-ledger-bench-signal-'));
  const temp = join(scratch, 'tmp');
  mkdirSync(temp);
  try {
    const child = spawn(process.execPath, ['bench/m0.mjs', '--sizes', '200', '--reps', '50', '--markdown', join(scratch, 'out.md')], {
      cwd: root, env: { ...process.env, TMPDIR: temp, TEMP: temp, TMP: temp }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
    await new Promise(resolve => child.stderr.setEncoding('utf8').on('data', chunk => {
      stderr += chunk;
      if (stderr.includes('temp directory')) resolve();
    }));
    child.kill('SIGINT');
    assert.equal(await exited, 130);
    // Give an orphaned server, if any, time to recreate the directory.
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.deepEqual(readdirSync(temp), []);
    assert.equal(existsSync(join(scratch, 'out.md')), false);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

// Tenki review of PR #3, finding 1: the steady-state cost mixed bytes of the revised
// output with characters of the base output, so the uncached remainder went negative.
test('steady-state cost never prices a negative uncached remainder', () => {
  const [price] = prices;
  const [cost] = costs({
    handoffTokens: 1000, graphTokens: 1000, revisedHandoffTokens: 2000, revisedGraphTokens: 2000,
    graphPrefixTokens: 5000, handoffPrefixTokens: 5000,
  });
  const allCached = Math.round(2000 * price.cacheHit) / 1000;
  assert.equal(cost.handoffSteadyStateIdsConstant, allCached);
  assert.equal(cost.graphSteadyState, allCached);
});

test('in a real run the cached prefix never exceeds the revised output it prices', async () => {
  const { report } = await runBenchmark({ seed: 7, sizes: [10, 60], reps: 1, append: 3 });
  for (const result of report.results) {
    for (const party of Object.values(result.parties)) {
      const { graph, handoff, idsHeldConstant } = party.cachePrefix;
      for (const prefix of [graph, handoff, idsHeldConstant.graph, idsHeldConstant.handoff]) {
        assert.ok(prefix.prefixChars <= prefix.newChars);
      }
      for (const cost of party.costPerThousandHandoffsUsd) {
        const floor = price => Math.round(Math.ceil(idsHeldConstant.handoff.newChars / 4) * price) / 1000;
        const price = prices.find(entry => entry.model === cost.model);
        assert.ok(cost.handoffSteadyStateIdsConstant >= floor(price.cacheHit), `${cost.model} below the all-cached floor`);
      }
    }
  }
});

// Tenki review of PR #3, finding 3: replacing 64-character IDs with a 4-character
// placeholder shrank the denominator and inflated the IDs-constant share.
test('the IDs-constant share keeps the original text as its denominator', () => {
  const oldId = 'a'.repeat(64);
  const newId = 'b'.repeat(64);
  const before = `head\n${oldId}\nbody`;
  const after = `head\n${newId}\nbody and more`;
  const asIs = prefixStability(before, after);
  const constant = prefixStability(before, after, [oldId, newId]);
  assert.equal(asIs.prefixChars, 5);
  assert.equal(constant.newChars, after.length, 'same denominator as the as-is share');
  assert.equal(constant.prefixChars, `head\n${newId}\nbody`.length, 'the placeholder counts as the full ID');
  assert.equal(constant.share, Math.round((constant.prefixChars / after.length) * 1000) / 1000);
  // An ID-free text gives the same result either way.
  assert.deepEqual(prefixStability('same text', 'same text, longer', [oldId]), prefixStability('same text', 'same text, longer'));
});
