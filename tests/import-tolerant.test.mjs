import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openStore } from '../src/store.mjs';

// Card I2: unreadable JSONL lines are skipped and counted instead of rejecting the file.
// Synthetic transcripts only.
const claudeLine = (role, text) => JSON.stringify({ type: role, message: { role, content: text } });
const codexLine = (role, text) => JSON.stringify({
  type: 'response_item',
  payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] },
});

test('I2: a Claude Code transcript with unreadable lines imports, keeps true line numbers, and reports what it skipped', () => {
  const store = openStore(':memory:');
  const transcript = [
    claudeLine('user', 'Where does the Vega cache live?'),
    'plain text that is not JSON',
    '{"type":"assistant","message":{"role":"assistant"',
    claudeLine('assistant', 'In the vega-cache folder.'),
    claudeLine('user', 'Thanks, now rename it.'),
    '{"type":"assistant","mess',
  ].join('\n');
  const summary = store.importTranscript({ provider: 'claude', source: 'vega.jsonl', transcript });

  assert.deepEqual(summary.skipped, { count: 3, lines: [2, 3, 6] });
  assert.equal(summary.messageCount, 3);
  assert.deepEqual(store.get(summary.id).messages.map(({ line, text }) => [line, text]), [
    [1, 'Where does the Vega cache live?'],
    [4, 'In the vega-cache folder.'],
    [5, 'Thanks, now rename it.'],
  ]);
  // The skip report is not stored with the session.
  assert.equal(store.get(summary.id).skipped, undefined);
  assert.equal(store.list('vega', 'claude')[0].skipped, undefined);
});

test('I2: a Codex transcript skips a bad line in the middle and a cut-off last line, and reads on past them', () => {
  const store = openStore(':memory:');
  const transcript = [
    codexLine('user', 'Pin the Orion build to Node 22.'),
    '{"type":"response_item","payload":{"type":"message"',
    codexLine('assistant', 'Pinned in .nvmrc.'),
    '{"type":"response_item","payload":{',
  ].join('\n');
  const summary = store.importTranscript({ provider: 'codex', source: 'orion.jsonl', transcript });
  assert.deepEqual(summary.skipped, { count: 2, lines: [2, 4] });
  assert.deepEqual(store.get(summary.id).messages.map(({ line, text }) => [line, text]), [
    [1, 'Pin the Orion build to Node 22.'],
    [3, 'Pinned in .nvmrc.'],
  ]);
});

test('I2: the count covers every skipped line while only the first ten line numbers are listed', () => {
  const store = openStore(':memory:');
  const lines = [claudeLine('user', 'Count the Lyra errors.')];
  for (let index = 0; index < 14; index += 1) lines.push(`broken ${index}`);
  const summary = store.importTranscript({ provider: 'claude', source: 'lyra.jsonl', transcript: lines.join('\n') });
  assert.equal(summary.skipped.count, 14);
  assert.deepEqual(summary.skipped.lines, [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
});

test('I2: a file with no readable line is still refused, naming its first line, and nothing is stored', () => {
  const store = openStore(':memory:');
  assert.throws(() => store.importTranscript({ provider: 'claude', source: 'notes.txt', transcript: '\nfirst note\nsecond note\n' }), { message: 'Invalid JSONL at line 2.' });
  assert.deepEqual(store.list('', null), []);
});

test('I2: readable lines with no messages are still refused', () => {
  const store = openStore(':memory:');
  const transcript = [JSON.stringify({ type: 'summary', summary: 'x' }), 'not json'].join('\n');
  assert.throws(() => store.importTranscript({ provider: 'claude', source: 'empty.jsonl', transcript }), /No supported conversation messages found/u);
  assert.deepEqual(store.list('', null), []);
});

test('I2: importing the same file again gives the same session and the same skip report', () => {
  const store = openStore(':memory:');
  const input = { provider: 'claude', source: 'vega.jsonl', transcript: [claudeLine('user', 'Vega again'), '{oops'].join('\n') };
  const first = store.importTranscript(input);
  const second = store.importTranscript(input);
  assert.deepEqual(second, first);
  assert.deepEqual(second.skipped, { count: 1, lines: [2] });
  assert.equal(store.list('vega', null).length, 1);
});

test('I2: a clean file returns the same summary as before, with no skip report', () => {
  const store = openStore(':memory:');
  const summary = store.importTranscript({ provider: 'claude', source: 'clean.jsonl', transcript: [claudeLine('user', 'Clean Atlas file'), ''].join('\n') });
  assert.deepEqual(Object.keys(summary).sort(), ['id', 'messageCount', 'project', 'provider', 'source', 'title']);
  assert.equal(Object.hasOwn(summary, 'skipped'), false);
});

test('I2: a graph can cite a kept line by its number in the file, and not a skipped one', () => {
  const store = openStore(':memory:');
  const transcript = [claudeLine('user', 'Plan the Deneb launch.'), 'garbage', '{"cut', claudeLine('assistant', 'Launch on Friday.')].join('\n');
  const { id: sessionId } = store.importTranscript({ provider: 'claude', source: 'deneb.jsonl', transcript });
  const graph = line => ({ version: 1, sessionId, nodes: [{ id: 'launch', kind: 'goal', label: 'Launch on Friday', evidenceLines: [line] }], edges: [] });
  assert.deepEqual(store.publishGraph(graph(4)).packet.nodes[0].evidenceLines, [4]);
  assert.throws(() => store.publishGraph(graph(3)), /line/iu);
});
