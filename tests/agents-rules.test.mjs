// Card H13: the rule that a repeated review finding becomes a check stays written down.
// The checks look for the rule's parts, not its exact wording.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('AGENTS.md section 4 defines a repeat and turns it into a check', () => {
  const step = read('AGENTS.md').split('## 4.')[1].split('## 5.')[0].split(/\n5\. /u)[1].split(/\n6\. /u)[0];
  assert.match(step, /repeat/iu, 'names a repeated finding');
  assert.match(step, /same rule|same misuse/iu, 'says what makes it a repeat');
  assert.match(step, /cite/iu, 'asks for the earlier entry');
  assert.match(step, /scripts\/check\.mjs/u, 'the fix adds a check rule');
  assert.match(step, /changes the API|API change/u, 'or an API change');
  assert.match(step, /why[^.]*docs\/evals\.md|docs\/evals\.md[^.]*why/iu, 'and records the exception in docs/evals.md');
});

test('the PR template runs the check and asks about repeated findings', () => {
  const template = read('.github/pull_request_template.md');
  assert.match(template, /node scripts\/check\.mjs/u);
  const line = template.split('\n').find(text => /repeat/iu.test(text));
  assert.ok(line, 'a checklist line about repeated findings');
  assert.match(line, /scripts\/check\.mjs/u);
  assert.match(line, /docs\/evals\.md/u, 'the exception is recorded in docs/evals.md');
});
