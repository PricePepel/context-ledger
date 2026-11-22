// Card W2: the ledger's secret scanner decides the shared cases exactly as the latent
// runtime's gateway does. rules/secret-rules.json holds the rule data both read, and
// rules/secret-conformance.json the cases this file and runtime/tests/test_secret_rules.py
// both run, so a rule changed in one language only fails one suite (the H4 pattern).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { findSecrets, redactText } from '../src/secrets.mjs';

const read = path => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
const { cases } = read('rules/secret-conformance.json');
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
