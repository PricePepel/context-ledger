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

// Card H12: a rule the check enforces is named once, beside the check, not restated as a
// manual step that drifts from it.
// One bullet names the check, its four rules and where a new rule goes; no other bullet
// asks for a scan of raw characters, HTML sinks or listen calls.
export function sectionSixProblems(agents) {
  const section = agents.match(/^## 6\.[^\n]*\n([\s\S]*?)^## 7\./mu)?.[1];
  if (!section) return ['no section 6'];
  const bullets = section.split(/\r?\n/u).filter(line => line.startsWith('- '));
  const checker = bullets.filter(line => /node scripts\/check\.mjs/u.test(line));
  const problems = [];
  if (checker.length !== 1) problems.push(`${checker.length} bullets name the check`);
  const [line = ''] = checker;
  for (const [name, pattern] of [['loopback', /loopback/iu], ['HTML sinks', /innerHTML|HTML sink/u], ['raw characters', /raw control/iu], ['code points', /code points/iu], ['add to the check', /add to the check/iu]]) {
    if (!pattern.test(line)) problems.push(`the check bullet does not name ${name}`);
  }
  for (const other of bullets.filter(bullet => !checker.includes(bullet))) {
    if (/\b(?:scan|check that|make sure)\b[^.]*\b(?:raw|control|format|bidi|innerHTML|listen)\b/iu.test(other)) problems.push(`restated: ${other.slice(0, 60)}`);
  }
  return problems;
}

test('AGENTS.md section 6 points to the check instead of restating its rules', () => {
  assert.deepEqual(sectionSixProblems(read('AGENTS.md')), []);
});

test('the section 6 rule fails on a removed rule list, a second copy, or a manual scan', () => {
  const agents = read('AGENTS.md');
  const checkerLine = agents.split(/\r?\n/u).find(line => line.startsWith('- ') && line.includes('node scripts/check.mjs'));
  assert.notEqual(sectionSixProblems(agents.replace(checkerLine, '- Run `node scripts/check.mjs`.')).length, 0, 'rule list removed');
  assert.notEqual(sectionSixProblems(agents.replace(checkerLine, `${checkerLine}\n${checkerLine}`)).length, 0, 'duplicated');
  assert.notEqual(sectionSixProblems(agents.replace(checkerLine, `${checkerLine}\n- Scan the tests and source for raw control characters.`)).length, 0, 'manual scan');
});
