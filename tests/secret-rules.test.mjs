// Card W2: the ledger's secret scanner decides the shared cases exactly as the latent
// runtime's gateway does. rules/secret-rules.json holds the rule data both read, and
// rules/secret-conformance.json the cases this file and runtime/tests/test_secret_rules.py
// both run, so a rule changed in one language only fails one suite (the H4 pattern).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { canonicalRanges, findSecrets, redactText } from '../src/secrets.mjs';

const read = path => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
const { cases, valueCases } = read('rules/secret-conformance.json');
const canonicalCases = read('rules/canonical-cases.json').cases;
const rules = read('rules/secret-rules.json');

// A text is a list of parts, so no committed file holds a whole credential-shaped string.
function expand(parts) {
  return parts.map(part => typeof part === 'string' ? part
    : part.repeat !== undefined ? part.repeat.repeat(part.times) : String.fromCodePoint(part.char)).join('');
}

// Offsets in the shared cases count code points; JavaScript strings count UTF-16 units.
function codePoints(text, index) {
  return [...text.slice(0, index)].length;
}

test('W2: a second assignment on a line has its value listed, the span unchanged (review W2-11)', () => {
  const value = 'harbor'.concat('-slate-42');
  const text = `password="synthetic-first", api_key="${value}"`;
  const [finding] = findSecrets(text, { values: true });
  assert.ok(finding.values.includes(value), finding.values.join(' '));
  assert.deepEqual(findSecrets(text).map(({ start, end }) => [start, end]), [[finding.start, finding.end]]);
});

test('W2: a second bare assignment has its value listed, the first cut where it begins (review W2-12)', () => {
  const text = 'password=synthetic-first, api_key='.concat('synthetic-second');
  const [finding] = findSecrets(text, { values: true });
  assert.ok(finding.values.includes('synthetic-second'), finding.values.join(' | '));
  assert.ok(finding.values.includes('synthetic-first'), finding.values.join(' | '));
  assert.deepEqual(findSecrets(text).map(({ start, end }) => [start, end]), [[finding.start, finding.end]]);
});

test('W2: shell syntax ends a value\'s head (review W2-19, W2-20)', () => {
  for (const text of ['password=paper-harbor; export aws_secret_access_key='.concat('A'.repeat(40)),
    'password=paper-harbor && api_key='.concat('synthetic-second'), 'password=paper-harbor > result.txt',
    'password=paper-harbor & sleep 1', 'password=paper-harbor 2>> errors.log', 'password=paper-harbor>result.txt',
    'password=paper-harbor& sleep 1', 'password=paper-harbor<input.txt', '(password=paper-harbor)']) {
    const [finding] = findSecrets(text, { values: true });
    assert.ok(finding.values.includes('paper-harbor'), `${text}: ${finding.values.join(' | ')}`);
  }
});

test('W2: a structured assignment after a bare value cuts it (review W2-18)', () => {
  const [finding] = findSecrets('password=paper-harbor, aws_secret_access_key='.concat('A'.repeat(40)), { values: true });
  assert.ok(finding.values.includes('paper-harbor'), finding.values.join(' | '));
});

test('W2: what the quotes hold is a value when a full stop follows them (review W2-14)', () => {
  const [finding] = findSecrets('password="paper-harbor".', { values: true });
  assert.ok(finding.values.includes('paper-harbor'), finding.values.join(' | '));
});

test('W2: mixed leads on one line each have their value (review W2-13)', () => {
  for (const [text, first] of [['password=synthetic-first, Authorization: Bearer '.concat('synthetic-second'), 'synthetic-first'],
    ['Authorization: Bearer synthetic-first, api_key='.concat('synthetic-second'), 'synthetic-first']]) {
    const [finding] = findSecrets(text, { values: true });
    assert.ok(finding.values.includes(first), `${text}: ${finding.values.join(' | ')}`);
    assert.ok(finding.values.includes('synthetic-second'), `${text}: ${finding.values.join(' | ')}`);
  }
});

test('W2: many assignments on one long line stay linear (review W2-13)', () => {
  const line = Array.from({ length: 5000 }, (_, i) => `password=v${i}x, `).join('').concat(' '.repeat(100000));
  const started = Date.now();
  const [finding] = findSecrets(line, { values: true });
  assert.ok(finding.values.length > 4000);
  assert.ok(finding.values.reduce((sum, value) => sum + value.length, 0) < 3 * line.length);
  assert.ok(Date.now() - started < 5000, `${Date.now() - started} ms`);
});

test('W2: a finding lists the value it identified, only when asked (review W2-8)', () => {
  const value = 'harbor'.concat('-slate-42');
  const [finding] = findSecrets(`Authorization: Bearer ${value}`, { values: true });
  assert.deepEqual(finding.values, [value]);
  assert.equal(findSecrets(`Authorization: Bearer ${value}`)[0].values, undefined);
});

test('W2: canonical copies of a value are found in both forms, as the gateway finds them', () => {
  // The same forms as canon in runtime/latent_team/gateway.py: escapes decoded, blanks and
  // invisible characters read as one space, or invisible characters dropped.
  const value = 'harbor'.concat('-slate-42');
  const zwsp = String.fromCodePoint(0x200b);
  const escaped = 'harbor'.concat(String.fromCodePoint(92), 'u002d', 'slate-42');
  const text = `a ${escaped} b harbor${zwsp}-slate-42 c harbor  ${String.fromCodePoint(9)}slate 42 d`;
  const covered = canonicalRanges(text, [value, 'harbor slate 42']).map(([start, end]) => text.slice(start, end));
  for (const copy of [escaped, `harbor${zwsp}-slate-42`, `harbor  ${String.fromCodePoint(9)}slate 42`]) assert.ok(covered.includes(copy), copy);
  assert.deepEqual(canonicalRanges('nothing here', [value]), []);
});

test('W2: every shared canonical case is read as the gateway reads it (review W2-9)', () => {
  assert.ok(canonicalCases.length >= 8);
  for (const { name, text, values, covered } of canonicalCases) {
    const full = expand(text);
    const found = [...new Set(canonicalRanges(full, values.map(expand)).map(([start, end]) => full.slice(start, end)))].sort();
    assert.deepEqual(found, covered.map(expand).sort(), name);
  }
});

test('W2: every shared value case gives the values the gateway gives (review W2-22)', () => {
  assert.ok(valueCases.length >= 8);
  const digest = value => createHash('sha256').update(value, 'utf8').digest('hex');
  for (const { name, text, valueDigests } of valueCases) {
    const found = findSecrets(expand(text), { values: true }).map(f => f.values.map(digest).sort());
    assert.deepEqual(found, valueDigests, name);
  }
});

test('W2: every shared case is found as the gateway finds it', () => {
  assert.ok(cases.length >= 40);
  for (const { name, text, spans } of cases) {
    const full = expand(text);
    const found = findSecrets(full).map(f => ({ kind: f.kind, start: codePoints(full, f.start), end: codePoints(full, f.end), prefix: f.prefix }));
    assert.deepEqual(found, spans, name);
  }
});

test('W2: redaction hides every value the shared cases name', () => {
  for (const { name, text } of cases) {
    const full = expand(text);
    const redacted = redactText(full);
    for (const finding of findSecrets(full)) {
      const value = full.slice(finding.start, finding.end);
      if (value.length >= 8) assert.ok(!redacted.includes(value), name);
    }
  }
});

test('W2: the rule file is plain data both regex engines read', () => {
  for (const rule of rules.simple.rules) {
    assert.doesNotThrow(() => new RegExp(rule.start, 'u'), rule.kind);
    assert.match(rule.prefix, /^\^/u, `${rule.kind}: a prefix pattern is anchored`);
  }
  for (const { pattern } of rules.placeholders.patterns) assert.match(pattern, /^\^.*\$$/u);
  // No lookbehind, named group or Unicode property escape: Python's re reads those differently.
  const all = JSON.stringify(rules);
  assert.ok(!/\(\?<[=!]|\(\?<[A-Za-z]|\\\\p\{/u.test(all));
});
