// Card U7: the console's swarm room, its pure summary of a run snapshot.
import assert from 'node:assert/strict';
import test from 'node:test';
import { agentBucket, swarmSummary } from '../public/console/swarm-room.mjs';

const agent = (state, verified = false) => ({ id: 1, state, verified });

test('U7: each agent lands in one bucket, and done splits on whether its quote was found', () => {
  assert.equal(agentBucket(agent('queued')), 'queued');
  assert.equal(agentBucket(agent('running')), 'running');
  assert.equal(agentBucket(agent('failed')), 'failed');
  assert.equal(agentBucket(agent('done', true)), 'verified');
  assert.equal(agentBucket(agent('done', false)), 'dropped');
  assert.equal(agentBucket(agent('done', 'yes')), 'dropped', 'only true counts as verified');
  assert.equal(agentBucket(agent('constructor')), 'unknown');
  assert.equal(agentBucket(null), 'unknown');
});

test('U7: a simulated run shows no speed-up and marks its wall time simulated', () => {
  const summary = swarmSummary({
    simulated: true, state: 'done', elapsedMs: 1234, speedup: 50, models: ['simulated'],
    agents: [agent('done', true), agent('done', false), agent('failed')],
    counts: { total: 3, finished: 3, verified: 1, correct: 1 },
  });
  assert.equal(summary.mode, 'Simulated');
  assert.equal(summary.speedup, 'not measured');
  assert.equal(summary.wall, '1.23 s (simulated)');
  assert.deepEqual(summary.buckets, { queued: 0, running: 0, verified: 1, dropped: 1, failed: 1, unknown: 0 });
  assert.equal(summary.finished, '3 / 3');
  assert.equal(summary.verified, '1 / 3');
});

test('U7: a live run shows the server\'s speed-up, rounded, and never one of its own', () => {
  const live = swarmSummary({ simulated: false, state: 'done', elapsedMs: 4100, speedup: 25.6, models: ['Qwen/Qwen2.5-7B-Instruct-AWQ'], agents: [], counts: {} });
  assert.equal(live.mode, 'Live: Qwen/Qwen2.5-7B-Instruct-AWQ');
  assert.equal(live.speedup, 'about 26×');
  assert.equal(live.wall, '4.10 s');
  for (const speedup of [null, undefined, 0, -3, Number.NaN, '25']) {
    assert.equal(swarmSummary({ simulated: false, speedup, agents: [] }).speedup, 'not measured', String(speedup));
  }
});

test('U7: a missing or odd snapshot is treated as simulated and empty', () => {
  const summary = swarmSummary(undefined);
  assert.equal(summary.simulated, true);
  assert.equal(summary.total, 0);
  assert.equal(summary.wall, '— (simulated)');
  assert.equal(summary.state, 'unknown');
  assert.equal(swarmSummary({ simulated: false, models: [42, 'm'], agents: [] }).mode, 'Live: m');
});
