import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';
import { deterministicPart, runBenchmark } from '../bench/m0.mjs';
import { generateParty } from '../bench/synth.mjs';

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
      assert.deepEqual(party.orderInvariance, { sameGraphId: true, identicalContext: true });
      assert.ok(party.cachePrefix.graph.share > party.cachePrefix.handoff.share);
      for (const latency of Object.values(result.latencyMs)) assert.ok(latency.p50 >= 0 && latency.p95 >= latency.p50);
    }
  }
  for (const name of ['mara', 'teo']) {
    const saved = results.map(result => result.parties[name].size.savedShare);
    assert.ok(saved.every((share, index) => index === 0 || share > saved[index - 1]), `${name} saved share grows: ${saved}`);
  }

  assert.match(first.markdown, /## Method and limits/u);
  assert.match(first.markdown, /node bench\/m0\.mjs --seed 7 --sizes 10,30,60 --reps 2 --append 3/u);
});
