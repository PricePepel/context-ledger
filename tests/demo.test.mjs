import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { gradeHandoff, makeParties, parties } from '../demo/fixtures.mjs';
import { leoReference } from '../demo/reference-graphs.mjs';

const right = {
  port: 4317, deadline: 'Saturday at 19:00', recordingSlot: 'Saturday 17:00', leoPairsOn: 'the MCP adapter',
  questionForAli: 'Who owns the GPU box?', network: 'on the local laptop, not stage Wi-Fi',
};

test('the grader accepts correct answers in prose, with annotations and among other braces', () => {
  assert.equal(gradeHandoff(JSON.stringify(right)).score, 6);
  const annotated = { ...right, port: '4317 (was 4400)', recordingSlot: 'Saturday 17:00 (moved from Sunday)' };
  assert.equal(gradeHandoff(`Here you go {see below}:\n${JSON.stringify(annotated, null, 2)}\nDone {ok}.`).score, 6);
});

test('the grader rejects the superseded answers and missing or negated ones', () => {
  const stale = { ...right, port: 4400, recordingSlot: 'Sunday morning' };
  const graded = gradeHandoff(JSON.stringify(stale));
  assert.equal(graded.score, 4);
  assert.deepEqual([graded.results.port, graded.results.recordingSlot], [false, false]);
  assert.equal(gradeHandoff(JSON.stringify({ ...right, network: 'not local, use stage Wi-Fi' })).results.network, false);
  assert.equal(gradeHandoff(JSON.stringify({ ...right, questionForAli: 'GPU' })).results.questionForAli, false);
  assert.equal(gradeHandoff('I could not find it.').score, 0);
  assert.equal(gradeHandoff('{"port": 4317').score, 0);
});

test('the committed demo files match the fixtures, and chatter only appends', async () => {
  for (const { source, transcript } of Object.values(parties)) {
    assert.equal(await readFile(new URL(`../demo/${source}`, import.meta.url), 'utf8'), transcript + '\n');
  }
  const long = makeParties(50).leo.transcript.split('\n');
  const short = parties.leo.transcript.split('\n');
  assert.equal(long.length, short.length + 100);
  assert.deepEqual(long.slice(0, short.length), short);
  // Every reference citation is a line that exists in the short transcript.
  const lines = leoReference('a'.repeat(64)).nodes.flatMap(node => node.evidenceLines);
  assert.ok(Math.max(...lines) <= short.length);
});
