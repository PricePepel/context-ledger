import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Cycle 9 follow-up F3: the runtime's quote enum folds exactly the whitespace the
// ledger folds. src/latent.mjs folds /\s+/gu; runtime/latent_pool/pool.py lists the
// code points in JS_SPACE_CODE_POINTS. This pins the list to what JavaScript matches.
function runtimeSpaceCodePoints() {
  const source = readFileSync(new URL('../runtime/latent_pool/pool.py', import.meta.url), 'utf8');
  const head = 'JS_SPACE_CODE_POINTS = (';
  const from = source.indexOf(head);
  assert.ok(from >= 0, 'JS_SPACE_CODE_POINTS is defined in pool.py');
  let depth = 1;
  let to = from + head.length;
  for (; depth > 0; to += 1) depth += source[to] === '(' ? 1 : source[to] === ')' ? -1 : 0;
  const match = [null, source.slice(from + head.length, to - 1)];
  const codes = [];
  for (const part of match[1].split(/,(?![^(]*\))/u).map(item => item.trim()).filter(Boolean)) {
    const range = part.match(/^\*range\((0x[0-9A-Fa-f]+), (0x[0-9A-Fa-f]+)\)$/u);
    if (range) for (let code = Number(range[1]); code < Number(range[2]); code += 1) codes.push(code);
    else codes.push(Number(part));
  }
  assert.ok(codes.every(Number.isInteger), 'every entry is a code point');
  return codes;
}

test('cycle 9 follow-up: the runtime folds the same whitespace as the ledger', () => {
  const javascript = [];
  for (let code = 0; code <= 0xffff; code += 1) if (/\s/u.test(String.fromCharCode(code))) javascript.push(code);
  assert.deepEqual(runtimeSpaceCodePoints().sort((a, b) => a - b), javascript);
  // The characters Python's str.split() treats differently are covered on both sides.
  for (const code of [0x1c, 0x1d, 0x1e, 0x1f, 0x85]) assert.ok(!javascript.includes(code), code.toString(16));
  assert.ok(javascript.includes(0xfeff));
});
