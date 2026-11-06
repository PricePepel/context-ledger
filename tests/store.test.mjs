import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openStore } from '../src/store.mjs';

const codexUser = (...texts) => JSON.stringify({
  type: 'response_item',
  payload: { type: 'message', role: 'user', content: texts.map(text => ({ type: 'input_text', text })) },
});

test('older Codex rollouts drop user_instructions and turn_aborted envelopes but keep real text', () => {
  const store = openStore(':memory:');
  const transcript = [
    codexUser('<user_instructions>\nAlways use tabs.\n</user_instructions>', 'Rename the Lyra build script.'),
    codexUser('<turn_aborted>\nInterrupted by user.\n</turn_aborted>'),
    codexUser('Please mention <user_instructions> in the docs.'),
  ].join('\n');
  const summary = store.importTranscript({ provider: 'codex', source: 'lyra.jsonl', transcript });
  const { messages } = store.get(summary.id);

  assert.equal(summary.title, 'Rename the Lyra build script.');
  assert.deepEqual(messages.map(({ line, text }) => [line, text]), [
    [1, 'Rename the Lyra build script.'],
    [3, 'Please mention <user_instructions> in the docs.'],
  ]);
  assert.equal(store.list('always use tabs', 'codex').length, 0);
  assert.equal(store.list('interrupted by user', 'codex').length, 0);
});

test('a long title is cut on a code point boundary', () => {
  const store = openStore(':memory:');
  const emoji = String.fromCodePoint(0x1f600);
  const text = 'a'.repeat(119) + emoji + 'tail';
  const transcript = JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
  const { title } = store.importTranscript({ provider: 'claude', source: 'emoji.jsonl', transcript });

  assert.equal(title, 'a'.repeat(119) + emoji);
  assert.equal(title.isWellFormed(), true);
});
