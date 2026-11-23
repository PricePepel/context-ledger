// Card U7: the console's swarm room, its pure summary of a run snapshot.
import assert from 'node:assert/strict';
import test from 'node:test';
import { agentBucket, isRunSnapshot, swarmSummary } from '../public/console/swarm-room.mjs';

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

test('U7 review: a slowdown keeps its decimal, and the tally names every bucket in words', () => {
  assert.equal(swarmSummary({ simulated: false, speedup: 0.4, agents: [] }).speedup, 'about 0.4×');
  assert.equal(swarmSummary({ simulated: false, speedup: 0.8, agents: [] }).speedup, 'about 0.8×');
  assert.equal(swarmSummary({ simulated: false, speedup: 9.96, agents: [] }).speedup, 'about 10.0×');
  const summary = swarmSummary({ agents: [agent('done', true), agent('running'), agent('odd')] });
  assert.equal(summary.tally, '1 checked, 1 working, 0 queued, 0 left out, 0 failed, 1 unknown');
});

test('U7 review: only an object with agents and a known state is a run the room draws', () => {
  assert.equal(isRunSnapshot({ state: 'running', agents: [] }), true);
  for (const bad of [undefined, null, {}, { state: 'running' }, { state: 'paused', agents: [] }, { state: 'done', agents: 'x' }, 'run']) {
    assert.equal(isRunSnapshot(bad), false, JSON.stringify(bad));
  }
});

// Card U8: the pixel robot the console's swarm room and the swarm page both draw.
test('U8: the robot is a fixed grid of whole pixels with three kinds of part', async () => {
  const { AGENT_GRID, swarmAgentPixels } = await import('../public/console/swarm-agent.mjs');
  const pixels = swarmAgentPixels();
  assert.deepEqual(pixels, swarmAgentPixels(), 'the same every time');
  for (const [x, y, width, height, part] of pixels) {
    for (const value of [x, y, width, height]) assert.ok(Number.isInteger(value) && value >= 0, String(value));
    assert.ok(width > 0 && height > 0);
    assert.ok(x + width <= AGENT_GRID.width && y + height <= AGENT_GRID.height, 'inside the grid');
    assert.ok(['body', 'screen', 'eye'].includes(part), part);
  }
  assert.equal(pixels.filter(pixel => pixel[4] === 'screen').length, 1);
  assert.equal(pixels.filter(pixel => pixel[4] === 'eye').length, 2);
});

test('U8: the robot is drawn with class names only, no fill, style or text from outside', async () => {
  const { swarmAgentSvg } = await import('../public/console/swarm-agent.mjs');
  const made = [];
  const doc = { createElementNS: (ns, name) => { const node = { ns, name, attrs: {}, children: [], setAttribute(key, value) { this.attrs[key] = value; }, append(child) { this.children.push(child); } }; made.push(node); return node; } };
  const svg = swarmAgentSvg(doc);
  assert.equal(svg.name, 'svg');
  assert.equal(svg.attrs['aria-hidden'], 'true');
  assert.equal(svg.children.length, 11);
  for (const node of made) {
    assert.equal(node.ns, 'http://www.w3.org/2000/svg');
    assert.ok(!('style' in node.attrs) && !('fill' in node.attrs), 'colours come from the stylesheet');
  }
  assert.ok(svg.children.every(rect => /^sa-(body|screen|eye)$/u.test(rect.attrs.class)));
});
