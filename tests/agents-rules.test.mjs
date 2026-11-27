// Card H13: the rule that a repeated review finding becomes a check stays written down.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('AGENTS.md section 4 turns a repeated finding into a check', () => {
  const section = read('AGENTS.md').split('## 4.')[1].split('## 5.')[0];
  assert.match(section, /a kind a review has reported before/u);
  assert.match(section, /adds a `scripts\/check\.mjs` rule, or changes the API so the mistake cannot be written/u);
  assert.match(section, /node scripts\/check\.mjs/u);
});

test('the PR template asks for the check and for the repeated-finding rule', () => {
  const template = read('.github/pull_request_template.md');
  assert.match(template, /`node scripts\/check\.mjs`, `npm run -s test:graph`/u);
  assert.match(template, /became a `scripts\/check\.mjs` rule \(or an API change\), or the PR says why not/u);
});
