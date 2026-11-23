import assert from 'node:assert/strict';
import test from 'node:test';
import { findSecrets, redactText } from '../src/secrets.mjs';

// Card P4c: line-tail redaction of free-text secrets, measured against the budget in
// docs/evals.md on a labelled synthetic corpus. Every secret is assembled here at run time;
// none of them is a real credential.
const backslash = String.fromCodePoint(92);
const quote = String.fromCodePoint(39);
const repeat = (unit, count) => unit.repeat(count);

// [line, the secret inside it]. The secret must be fully hidden after redaction.
const secretLines = [
  ['password=hunter2', 'hunter2'],
  ['password: hunter2', 'hunter2'],
  ['DB_PASSWORD="synthetic-pw-9x"', 'synthetic-pw-9x'],
  [`api_key = ${quote}Zt4Wq8Lm2Np6Rv0X${quote}`, 'Zt4Wq8Lm2Np6Rv0X'],
  ['{"client_secret": "a b c 9 spaced value"}', 'a b c 9 spaced value'],
  ['password = " [x] secret 9" ok', ' [x] secret 9'],
  [`password=ab${backslash}c1234 ok`, `ab${backslash}c1234`],
  [`"password": ab${backslash}c1234`, `ab${backslash}c1234`],
  [`"password": abcd1234${backslash}u002cTAIL987`, `abcd1234${backslash}u002cTAIL987`],
  ['password=abc12345678(note)', 'abc12345678'],
  ['password="river_stone_orchid"', 'river_stone_orchid'],
  ['password="<|R7x9_secret|>"', '<|R7x9_secret|>'],
  [`password = "abc9defg${backslash}`, `abc9defg${backslash}`],
  [`secret = env-9f8a7b6c5d4e`, 'env-9f8a7b6c5d4e'],
  [`token: ${repeat('Zk3m', 300)} trailing`, repeat('Zk3m', 300)],
  ['Authorization: Bearer abcdefgh12345', 'abcdefgh12345'],
  ['Authorization: Bearer short1', 'short1'],
  ['{"Authorization":"Bearer abcdefgh12345"}', 'abcdefgh12345'],
  [`{"Authorization":"Bearer abc${backslash}/def12345${backslash}u002Fxyz"}`, `abc${backslash}/def12345${backslash}u002Fxyz`],
  [`curl -H "Authorization: Bearer abc${backslash}/def12345xyz" https://example.test`, `abc${backslash}/def12345xyz`],
  [`curl -H ${quote}Authorization: Bearer abc${backslash}/def12345xyz${quote}`, `abc${backslash}/def12345xyz`],
  [`{"Authorization":"Bearer abcdefgh123${backslash}nnext"}`, `abcdefgh123${backslash}nnext`],
  ['Authorization: Bearer abc12345678(note)', 'abc12345678'],
  [`export API_KEY=${repeat('Hk4t', 6)}; echo done`, repeat('Hk4t', 6)],
  [`  refresh_token: "${repeat('Qw9e', 5)}",`, repeat('Qw9e', 5)],
  [`env "token=${repeat('Rf5G', 5)}" end`, repeat('Rf5G', 5)],
  // Review round 1 (of 941e48d).
  ['password="changeme;"', 'changeme;'],
  ['password="}"', '}'],
  ['password=$Identifier}', '$Identifier}'],
  ['password=<synth-pw-X9>', '<synth-pw-X9>'],
  ['api key: synthetic9', 'synthetic9'],
  [`token${repeat('\t', 9)}= abc9def`, 'abc9def'],
  [`password = "esc${backslash}"aped9"`, `esc${backslash}"aped9`],
  [`password=pw1${String.fromCodePoint(0x2028)}after`, 'pw1'],
  // Review round 2 (of d6c39db).
  ['password="changeme"synthetic9', 'changeme"synthetic9'],
  [`password="changeme${backslash}"synthetic9"`, `changeme${backslash}"synthetic9`],
  ['password=<monkey9>', '<monkey9>'],
  ['password=<tokenizer>', '<tokenizer>'],
];

// Benign lines with a secret-like name and : or =. At most 10% may be flagged.
const benignKeyed = [
  'password = ${PASSWORD}',
  'api_key: <your-key-here>',
  'token: xxxxxxxxxxxx',
  'password: changeme',
  'secret = process.env.SECRET',
  'token = 4096',
  'token = 0b7e2a4c-9f1d-4e3b-8a5c-6d2f1e0a9b8c',
  'token = 3f2a9c1e7b4d5a6f8e9c0b1a2d3e4f5a6b7c8d9e',
  'password: [REDACTED assigned-secret]',
  'api_key=',
  'token: null',
  'password: ********',
  'secret: %SECRET%',
  'token = ${TOKEN},',
  'password: true',
  'API_KEY=$API_KEY',
  'client_secret: <client-secret>',
  'access_token: undefined',
  'token: "${GITHUB_TOKEN}"',
  'token = getToken()',
  'apiKey = config.apiKey',
  // Review round 2: a quoted placeholder followed by a delimiter is still a placeholder.
  '{"password": "changeme", "user": "demo"}',
  'secret: <your_secret_here>',
];

// The benign keyed lines expected to be flagged: code under a secret-like name.
const expectedFalseAlarms = ['token = getToken()', 'apiKey = config.apiKey'];

// Benign lines without such a name. None may be flagged.
const benignPlain = [
  'Please reset your password tomorrow.',
  'The password field is required.',
  'commit 3f2a9c1e7b4d5a6f8e9c0b1a2d3e4f5a6b7c8d9e',
  'session 0b7e2a4c-9f1d-4e3b-8a5c-6d2f1e0a9b8c',
  'max_tokens: 4096',
  'const tokens = tokenize(text);',
  'Use the risk-assessment-for-the-project-and-team page.',
  'The secret to good tests is synthetic data.',
  'Authorization is handled by the server.',
  'Set the Bearer scheme in the header docs.',
  // Review round 1: a lead at the end of a line never reaches the next one.
  'password=\nordinary prose',
  'password=\r\nordinary prose',
  'password=\rordinary prose',
];

function hidden(line, secret) {
  const start = line.indexOf(secret);
  assert.ok(start >= 0, `fixture: ${line}`);
  const covered = new Uint8Array(line.length);
  for (const finding of findSecrets(line)) covered.fill(1, finding.start, finding.end);
  for (let at = start; at < start + secret.length; at += 1) if (!covered[at]) return false;
  return true;
}

test('P4c budget: no character of any secret in the corpus is left visible', () => {
  const missed = secretLines.filter(([line, secret]) => !hidden(line, secret)).map(([line]) => line);
  assert.deepEqual(missed, []);
  // And the rendered text is exactly the line with each covered span replaced by its
  // marker: nothing of a covered span, however short, is left visible.
  for (const [line] of secretLines) assert.equal(redactText(line), rendered(line), line);
});

// The expected rendering, built from the scanner's spans independently of redactText.
function rendered(line) {
  const spans = findSecrets(line).map(({ kind, start, end }) => ({ kind, start, end })).sort((a, b) => a.start - b.start);
  const merged = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  let out = '';
  let at = 0;
  for (const span of merged) {
    out += `${line.slice(at, span.start)}[REDACTED `;
    out += `${span.kind}]`;
    at = span.end;
  }
  return out + line.slice(at);
}

test('P4c budget: at most 10% of benign keyed lines, and no plain line, are flagged', () => {
  const flagged = benignKeyed.filter(line => findSecrets(line).length);
  assert.deepEqual(flagged, expectedFalseAlarms, 'the measured false alarms are exactly the expected ones');
  assert.ok(flagged.length / benignKeyed.length <= 0.1, `flagged: ${JSON.stringify(flagged)}`);
  assert.deepEqual(benignPlain.filter(line => findSecrets(line).length), []);
});

test('P4c: line breaks survive and other lines are unchanged byte for byte', () => {
  const lines = ['first line', 'password=hunter2 and more', 'third line stays', 'Authorization: Bearer abcdefgh123', 'last'];
  for (const newline of ['\n', '\r\n']) {
    const text = lines.join(newline);
    const out = redactText(text).split(newline);
    assert.equal(out.length, lines.length);
    assert.deepEqual([out[0], out[2], out[4]], [lines[0], lines[2], lines[4]]);
    assert.equal(out[1], 'password=[REDACTED assigned-secret]');
    assert.equal(out[3], 'Authorization: Bearer [REDACTED bearer-token]');
  }
  // Review round 2: every documented line separator, with an empty lead before it.
  for (const separator of ['\n', '\r\n', '\r', String.fromCodePoint(0x2028), String.fromCodePoint(0x2029)]) {
    const text = ['password=pw1', 'prose one', 'password=', 'prose two', 'Authorization: Bearer ', 'prose three'].join(separator);
    const expected = ['password=[REDACTED assigned-secret]', 'prose one', 'password=', 'prose two', 'Authorization: Bearer ', 'prose three'].join(separator);
    assert.equal(redactText(text), expected, JSON.stringify(separator));
  }
});

test('P4c: a 1 MiB transcript and 40,000 nested names scan in under a second each', () => {
  const chunk = `Normal text. password=hunter2 then Authorization: Bearer abcdefgh123\nmore text\n`;
  const big = chunk.repeat(Math.ceil((1024 * 1024) / chunk.length));
  const names = `token=${'token='.repeat(40000)}Zt4Wq8Lm2Np6`;
  const spaces = `password=a${' '.repeat(64000)}b`;
  // Review round 2: rejected quoted leads, and long padding before a non-Bearer value.
  const rejected = 'token="" '.repeat(8000);
  const padded = `Authorization:${' '.repeat(64000)}Basic synthetic9`;
  for (const text of [big, names, spaces, rejected, padded]) {
    const started = performance.now();
    findSecrets(text);
    assert.ok(performance.now() - started < 1000, `${text.length} characters took too long`);
  }
  assert.deepEqual(findSecrets(names).map(({ start, end }) => [start, end]), [[6, names.length]]);
});
