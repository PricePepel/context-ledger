import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const cp = (...points) => String.fromCodePoint(...points);

test('handoff Markdown escapes bidi and tag characters but keeps emoji joiners', async t => {
  const id = 'e'.repeat(64);
  const rlo = cp(0x202e);
  const hiddenTags = cp(0xe0049, 0xe0067, 0xe006e);
  const family = cp(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
  const session = {
    id, provider: 'claude', source: 'notes' + rlo + 'txt.exe.jsonl',
    messages: [
      { role: 'user', line: 3, text: 'Open invoice' + rlo + 'fdp.exe now' + hiddenTags },
      { role: 'assistant', line: 4, text: 'Thanks ' + family + cp(0x1b) + '[31m\tdone' },
    ],
  };
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ session }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));

  const { stdout } = await execute(process.execPath, ['src/cli.mjs', 'handoff', id], {
    env: { ...process.env, PORT: String(server.address().port) },
  });
  const raw = [...stdout].map(character => character.codePointAt(0));
  for (const point of [0x202e, 0xe0049, 0xe0067, 0xe006e, 0x1b]) {
    assert.ok(!raw.includes(point), 'raw U+' + point.toString(16) + ' reached the terminal');
  }
  assert.ok(stdout.includes('\\u202e'), 'bidi override is shown as an escape');
  assert.ok(stdout.includes('\\udb40\\udc49'), 'tag characters are escaped as surrogate pairs');
  assert.ok(stdout.includes(family), 'emoji ZWJ sequence is preserved');
  assert.ok(stdout.includes('\tdone'), 'tabs are preserved');
  assert.match(stdout, /## user · line 3/);
});
