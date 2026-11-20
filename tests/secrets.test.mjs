import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { findSecrets, maskedPreview, redactSession, redactText } from '../src/secrets.mjs';
import { bearer, ledgerToken } from './ledger-auth.mjs';

// Card P4b. Every fake credential is put together here from fragments, so no committed
// file holds a whole string in a real credential format (secret-scanning push protection
// would flag one). None of them is a real credential.
const join2 = (...parts) => parts.join('');
const body = (unit, count) => unit.repeat(count);
const fake = {
  'aws-access-key-id': join2('AK', 'IA', 'Q3XZ7W2M9KD4PL6N'),
  'github-token': join2('gh', 'p_', body('Ab3D', 9)),
  'github-pat': join2('github', '_pat_', body('11AB', 6), '_', body('cD9e', 10)),
  'anthropic-key': join2('sk', '-ant-', 'api03-', body('Zq7W', 10)),
  'openai-key': join2('sk', '-proj-', body('Hk4t', 10)),
  'slack-token': join2('xo', 'xb-', '1234567890-', body('aB1c', 5)),
  'stripe-key': join2('sk', '_live_', body('Rf5G', 6)),
  jwt: join2('ey', 'JhbGciOiJIUzI1NiJ9', '.', 'ey', 'JzdWIiOiIxMjM0NTY3ODkwIn0', '.', 'SflKxwRJSMeKKF2QT4fwpM'),
  'aws-secret': body('wJal', 10),
  'bearer': body('Tq8z', 8),
};
const pemType = 'RSA ' + 'PRIVATE KEY';
const pem = `-----BEGIN ${pemType}-----\nMIIEowIBAAKCAQEA${body('q1W2', 16)}\n-----END ${pemType}-----`;

function kinds(text) {
  return findSecrets(text).map(finding => finding.kind);
}

test('P4b: every listed format is found, with its kind and exact span', () => {
  const cases = [
    [`key ${fake['aws-access-key-id']} here`, 'aws-access-key-id', fake['aws-access-key-id']],
    [`push with ${fake['github-token']}.`, 'github-token', fake['github-token']],
    [`pat ${fake['github-pat']}`, 'github-token', fake['github-pat']],
    [`ANTHROPIC_API_KEY ${fake['anthropic-key']}`, 'anthropic-key', fake['anthropic-key']],
    [`openai ${fake['openai-key']}`, 'openai-key', fake['openai-key']],
    [`slack ${fake['slack-token']}`, 'slack-token', fake['slack-token']],
    [`stripe ${fake['stripe-key']}`, 'stripe-key', fake['stripe-key']],
    [`cookie=${fake.jwt}`, 'jwt', fake.jwt],
    [`aws_secret_access_key = ${fake['aws-secret']}`, 'aws-secret-access-key', fake['aws-secret']],
    [`here is the key:\n${pem}\nthanks`, 'private-key', pem],
  ];
  for (const [text, kind, value] of cases) {
    const found = findSecrets(text);
    assert.equal(found.length, 1, `${kind}: ${JSON.stringify(found)}`);
    assert.equal(found[0].kind, kind);
    assert.equal(text.slice(found[0].start, found[0].end), value, kind);
  }
});

test('P4b: prose, hashes, UUIDs, placeholders and short or plain values are not flagged', () => {
  const quiet = [
    'Please reset your password tomorrow.',
    'The password field is required.',
    'commit 3f2a9c1e7b4d5a6f8e9c0b1a2d3e4f5a6b7c8d9e',
    'session 0b7e2a4c-9f1d-4e3b-8a5c-6d2f1e0a9b8c',
    'password = ${PASSWORD}',
    'api_key: <your-key-here>',
    'token: xxxxxxxxxxxx',
    'password: changeme',
    'secret = process.env.SECRET',
    'token = getToken()',
    'max_tokens: 4096',
    'password: hunter2',
    'Use the risk-assessment-for-the-project-and-team page.',
    'See sk-learn-documentation-for-everyone here.',
    'apiKey = config.apiKey',
  ];
  for (const text of quiet) assert.deepEqual(kinds(text), [], text);
});

test('P4b: overlapping matches are reported once, by the most specific kind', () => {
  // An Anthropic key also matches the OpenAI pattern, and an assigned token matches the
  // name rule: each span must appear once, under its specific kind.
  assert.deepEqual(kinds(`ANTHROPIC_KEY=${fake['anthropic-key']}`), ['anthropic-key']);
  assert.deepEqual(kinds(`GITHUB_TOKEN=${fake['github-token']}`), ['github-token']);
  assert.deepEqual(kinds(`token: ${fake.jwt}`), ['jwt']);
});

test('P4b: redaction replaces only the findings and leaves every other byte', () => {
  const emoji = String.fromCodePoint(0x1f600);
  const text = `a ${emoji}\r\n${fake['github-token']} b\tc ${fake['aws-access-key-id']}!`;
  const redacted = redactText(text);
  assert.equal(redacted, `a ${emoji}\r\n[REDACTED github-token] b\tc [REDACTED aws-access-key-id]!`);
  assert.equal(redactText('nothing here'), 'nothing here');
});

test('P4b: a redacted session keeps its lines and lists findings without any value', () => {
  const session = {
    id: 'a'.repeat(64), provider: 'codex', source: 'orion.jsonl',
    messages: [
      { role: 'user', line: 3, text: `deploy with ${fake['github-token']}` },
      { role: 'assistant', line: 7, text: 'Done, no keys needed.' },
      { role: 'user', line: 9, text: `also ${fake['stripe-key']} and ${fake['aws-access-key-id']}` },
    ],
  };
  const { session: redacted, findings } = redactSession(session);
  assert.deepEqual(redacted.messages.map(message => message.line), [3, 7, 9]);
  assert.equal(redacted.messages[1], session.messages[1], 'clean messages are untouched');
  assert.deepEqual(findings.map(({ line, kind }) => [line, kind]), [[3, 'github-token'], [9, 'stripe-key'], [9, 'aws-access-key-id']]);
  assert.deepEqual(findings.map(finding => finding.preview), ['ghp_…', 'sk_live_…', 'AKIA…']);
  const shown = JSON.stringify({ redacted, findings });
  for (const value of [fake['github-token'], fake['stripe-key'], fake['aws-access-key-id']]) {
    assert.ok(!shown.includes(value), 'no value is kept');
    assert.ok(!shown.includes(value.slice(-6)), 'no tail of a value is kept');
  }
  assert.equal(session.messages[0].text.includes(fake['github-token']), true, 'the input is not changed');
});

test('P4b: a masked preview shows only the known prefix', () => {
  for (const [kind, value] of Object.entries(fake)) {
    const text = kind === 'aws-secret' ? `aws_secret_access_key=${value}` : kind === 'bearer' ? `Authorization: Bearer ${value}` : value;
    for (const finding of findSecrets(text)) {
      const preview = maskedPreview(text, finding);
      assert.ok(preview.endsWith('…'));
      assert.ok(preview.length - 1 <= 11, `${kind}: ${preview}`);
      assert.ok(!preview.slice(0, -1) || value.startsWith(preview.slice(0, -1)), kind);
    }
  }
  assert.equal(maskedPreview(pem, findSecrets(pem)[0]), '…');
});

test('P4b: a 1 MiB transcript and a 1 MiB run of word characters scan in under a second each', () => {
  const chunk = `Normal text about the build. password: synthetic-pw-9x and ${fake['github-token']}\n`;
  const big = chunk.repeat(Math.ceil((1024 * 1024) / chunk.length));
  for (const text of [big, 'a'.repeat(1024 * 1024), `${'token'.repeat(200000)}=x`, `sk-${'-'.repeat(1024 * 1024)}`]) {
    const started = performance.now();
    findSecrets(text);
    assert.ok(performance.now() - started < 1000, `${text.length} characters took too long`);
  }
});

// P1e: each test ledger's database and token, by port, so the CLI and the tests can use them.
const ledgers = new Map();
const authFor = origin => ledgers.get(new URL(origin).port)?.auth ?? {};

async function startServer(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-p4b-'));
  const server = spawn(process.execPath, ['src/server.mjs'], { env: { ...process.env, PORT: '0', CONTEXT_LEDGER_DB: join(directory, 'ledger.sqlite') }, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(async () => {
    if (server.exitCode === null) {
      const ended = once(server, 'close');
      server.kill();
      await ended;
    }
    await rm(directory, { recursive: true, force: true });
  });
  let output = '';
  for await (const chunk of server.stdout) {
    output += chunk;
    const match = output.match(/listening at (http:\/\/127\.0\.0\.1:(\d+))/u);
    if (match) {
      const database = join(directory, 'ledger.sqlite');
      ledgers.set(match[2], { database, auth: bearer(await ledgerToken(database, Number(match[2]))) });
      return { origin: match[1], port: match[2] };
    }
  }
  throw new Error('The server did not start.');
}

function cli(args, port) {
  const database = ledgers.get(String(port))?.database;
  const env = { ...process.env, PORT: port, ...(database ? { CONTEXT_LEDGER_DB: database } : {}) };
  const child = spawn(process.execPath, ['src/cli.mjs', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  return new Promise(resolve => child.on('close', code => resolve({ code, stdout, stderr })));
}

test('P4b: ledger redact reports kinds, lines and masked previews, never a value, in every format', async t => {
  const { origin, port } = await startServer(t);
  const line = (role, text) => JSON.stringify({ type: role, message: { role, content: text } });
  const transcript = [
    line('user', `Deploy the Vega site with ${fake['github-token']} please.`),
    line('assistant', 'Deploying now.'),
    line('user', `And the DB_PASSWORD="synthetic-pw-9x" plus ${fake['aws-access-key-id']}.`),
  ].join('\n');
  const imported = await (await fetch(`${origin}/api/import`, {
    method: 'POST', headers: { ...authFor(origin), 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ provider: 'claude', source: 'vega.jsonl', transcript }),
  })).json();
  const id = imported.session.id;
  const values = [fake['github-token'], fake['aws-access-key-id']];

  const report = await cli(['redact', id], port);
  assert.equal(report.code, 0, report.stderr);
  assert.equal(report.stdout, [
    'line 1  github-token  40 characters  ghp_…',
    'line 3  aws-access-key-id  20 characters  AKIA…',
    '2 possible secrets in 2 lines. Values are not shown; use --text for the redacted hand-off.',
    'Only known key formats are checked (provider API keys, JWTs, private keys, AWS keys); passwords and other free-text values are not.',
    '',
  ].join('\n'));

  const json = await cli(['redact', id, '--json'], port);
  assert.equal(json.code, 0, json.stderr);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.count, 2);
  assert.equal(parsed.lines, 2);
  assert.deepEqual(parsed.findings.map(finding => finding.kind), ['github-token', 'aws-access-key-id']);

  const text = await cli(['redact', id, '--text'], port);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /## user · line 1/u);
  assert.match(text.stdout, /\[REDACTED github-token\]/u);

  for (const run of [report, json, text]) {
    for (const value of values) assert.ok(!run.stdout.includes(value) && !run.stderr.includes(value), 'no value is printed');
    assert.doesNotMatch(run.stdout, /[^\P{Cc}\n]|\p{Cf}/u, 'no raw control or format characters');
  }

  const clean = await cli(['redact', 'b'.repeat(64)], port);
  assert.equal(clean.code, 1);
  assert.match(clean.stderr, /Session not found\./u);
  const bad = await cli(['redact', id, '--html'], port);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /Usage: npm run ledger/u);
  const handoff = await cli(['handoff', id], port);
  assert.ok(handoff.stdout.includes(fake['github-token']), 'ledger handoff is unchanged by P4b');
});

// Review round 1 regressions.

test('P4b review: every GitHub, OpenAI and Stripe variant is found with its exact preview', () => {
  const variants = [
    [join2('gh', 'o_', body('Ab3D', 9)), 'github-token', 'gho_…'],
    [join2('gh', 'u_', body('Ab3D', 9)), 'github-token', 'ghu_…'],
    [join2('gh', 's_', body('Ab3D', 9)), 'github-token', 'ghs_…'],
    [join2('gh', 'r_', body('Ab3D', 9)), 'github-token', 'ghr_…'],
    [fake['github-pat'], 'github-token', 'github_pat_…'],
    [join2('sk', '-', body('Hk4t', 10)), 'openai-key', 'sk-…'],
    [fake['openai-key'], 'openai-key', 'sk-proj-…'],
    [join2('sk', '_test_', body('Rf5G', 6)), 'stripe-key', 'sk_test_…'],
    [join2('rk', '_live_', body('Rf5G', 6)), 'stripe-key', 'rk_live_…'],
    [fake['anthropic-key'], 'anthropic-key', 'sk-ant-…'],
    [join2('sk', '-ant-', body('abcd', 8)), 'anthropic-key', 'sk-ant-…'],
    [fake['slack-token'], 'slack-token', 'xoxb-…'],
    [fake['aws-access-key-id'], 'aws-access-key-id', 'AKIA…'],
    [fake.jwt, 'jwt', 'eyJ…'],
    [join2('ey', 'JhbGciOiJub25lIn0', '.', 'ey', 'JzdWIiOiIxMjM0In0', '.'), 'jwt', 'eyJ…'],
  ];
  for (const [value, kind, preview] of variants) {
    const text = `value ${value} end`;
    const found = findSecrets(text);
    assert.equal(found.length, 1, `${preview}: ${JSON.stringify(found)}`);
    assert.equal(found[0].kind, kind, preview);
    assert.equal(text.slice(found[0].start, found[0].end), value, preview);
    assert.equal(maskedPreview(text, found[0]), preview);
  }
});

test('P4b review: long values, long keys and quoted passwords are redacted whole', () => {
  const longToken = join2('gh', 'p_', body('Ab3D', 80));
  const longBearer = body('Tq8z', 1500);
  const bigPem = `-----BEGIN ${pemType}-----\n${(body('q1W2', 16) + '\n').repeat(400)}-----END ${pemType}-----`;
  const openPem = `-----BEGIN ${pemType}-----\n${body('q1W2', 16)}\n${body('e3R4', 16)}\n\nAfter the key.`;
  const quote = String.fromCodePoint(39);
  const cases = [
    [`a ${longToken} b`, 'a [REDACTED github-token] b'],
    [`x\n${bigPem}\ny`, 'x\n[REDACTED private-key]\ny'],
    [openPem, '[REDACTED private-key]\n\nAfter the key.'],
  ];
  for (const [text, expected] of cases) assert.equal(redactText(text), expected, expected);
  assert.ok(bigPem.length > 16384);
});

test('P4b review: placeholders by shape, and UUIDs and commit hashes under a name, are not flagged', () => {
  assert.deepEqual(kinds('token = 0b7e2a4c-9f1d-4e3b-8a5c-6d2f1e0a9b8c'), []);
  assert.deepEqual(kinds('token = 3f2a9c1e7b4d5a6f8e9c0b1a2d3e4f5a6b7c8d9e'), []);
  assert.deepEqual(kinds('Authorization: Bearer short1'), [], 'bearer values under eight characters are not flagged');
});

test('P4b review: dense matches and dense unfinished key headers stay fast', () => {
  const dense = `${fake['aws-access-key-id']} `.repeat(50000);
  const headers = `-----BEGIN ${pemType}-----\n`.repeat(30000);
  for (const text of [dense, headers]) {
    const started = performance.now();
    findSecrets(text);
    assert.ok(performance.now() - started < 1500, `${text.length} characters took too long`);
  }
});

test('P4b review: the redacted source name, strict escaping, and fixed errors in the CLI', async t => {
  const { origin, port } = await startServer(t);
  const zwj = String.fromCodePoint(0x200d);
  const rlo = String.fromCodePoint(0x202e);
  const bell = String.fromCodePoint(7);
  const separator = String.fromCodePoint(0x2028);
  const source = `${fake['github-token']}.jsonl`;
  const transcript = JSON.stringify({ type: 'user', message: { role: 'user', content: `odd${zwj}${rlo}${bell}${separator} text and ${fake['stripe-key']}` } });
  const imported = await (await fetch(`${origin}/api/import`, {
    method: 'POST', headers: { ...authFor(origin), 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ provider: 'claude', source, transcript }),
  })).json();
  const id = imported.session.id;

  const report = await cli(['redact', id], port);
  assert.equal(report.stdout, [
    'source name  github-token  40 characters  ghp_…',
    'line 1  stripe-key  32 characters  sk_live_…',
    '2 possible secrets in 2 lines. Values are not shown; use --text for the redacted hand-off.',
    'Only known key formats are checked (provider API keys, JWTs, private keys, AWS keys); passwords and other free-text values are not.',
    '',
  ].join('\n'));
  const text = await cli(['redact', id, '--text'], port);
  assert.equal(text.code, 0, text.stderr);
  // The hand-off renderer escapes Markdown in the source name, brackets included.
  assert.match(text.stdout, /^Source: \\\[REDACTED github-token\\\]\.jsonl$/mu);
  for (const run of [report, text]) {
    assert.ok(!run.stdout.includes(fake['github-token']) && !run.stdout.includes(fake['stripe-key']));
    assert.doesNotMatch(run.stdout, /[^\P{Cc}\n]|\p{Cf}|\p{Zl}|\p{Zp}/u, 'no raw control, format or separator characters');
  }
  assert.match(text.stdout, /\\u200d\\u202e\\u0007\\u2028/u);
  const odd = await cli(['redact', id, 'constructor'], port);
  assert.equal(odd.code, 1);
  assert.match(odd.stderr, /Usage: npm run ledger/u);
});

test('P4b review: an unreadable server response is a fixed sentence, never its bytes', async () => {
  const { createServer } = await import('node:http');
  const leak = `${fake['github-token']}${String.fromCodePoint(27)}[31m`;
  const bodies = [
    `{"session": "${leak}`,
    JSON.stringify({ session: { id: 'a'.repeat(64), source: 'x', provider: 'claude', messages: [{ line: '1', role: 'user', text: leak }] } }),
  ];
  for (const reply of bodies) {
    const server = createServer((request, response) => {
      response.setHeader('Content-Type', 'application/json');
      response.end(reply);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const run = await cli(['redact', 'a'.repeat(64)], String(server.address().port));
      assert.equal(run.code, 1);
      assert.match(run.stderr, /Context Ledger returned an unexpected session response\./u);
      assert.ok(!run.stderr.includes(fake['github-token']) && !run.stdout.includes(fake['github-token']));
      assert.doesNotMatch(run.stderr, /[^\P{Cc}\n]/u);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  }
});

// Review round 2 regressions.

test('P4b review 2: quoted values, long JWTs, encrypted keys and JSON headers are redacted whole', () => {
  const longJwt = join2('ey', 'JhbGciOiJIUzI1NiJ9', '.', 'ey', body('JzdWIi', 400), '.', body('Sf1K', 30));
  const dek = `-----BEGIN ${pemType}-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,0A1B2C3D\n\n${body('q1W2', 16)}\n${body('e3R4', 16)}`;
  const quote = String.fromCodePoint(39);
  const cases = [
    [`jwt ${longJwt} end`, 'jwt [REDACTED jwt] end'],
    [`${dek}\nThen prose.`, '[REDACTED private-key]\nThen prose.'],
  ];
  for (const [text, expected] of cases) assert.equal(redactText(text), expected, expected);
});

test('P4b review 2: an unfinished key never swallows prose or a later key', () => {
  const unfinished = `-----BEGIN ${pemType}-----\n${body('q1W2', 16)}`;
  const text = `${unfinished}\nSome prose in between.\n${pem}\nend`;
  assert.equal(redactText(text), '[REDACTED private-key]\nSome prose in between.\n[REDACTED private-key]\nend');
  const twoBegins = `${unfinished}\n${pem}`;
  assert.equal(findSecrets(twoBegins).length, 2);
});

test('P4b review 2: every remaining variant has one exact finding and preview', () => {
  const variants = [
    [`value ${join2('sk', '-svcacct-', body('Hk4t', 10))} end`, 'openai-key', 'sk-svcacct-…'],
    [`value ${join2('sk', '-admin-', body('Hk4t', 10))} end`, 'openai-key', 'sk-admin-…'],
    [`value ${join2('rk', '_test_', body('Rf5G', 6))} end`, 'stripe-key', 'rk_test_…'],
    [`aws_secret_access_key = ${fake['aws-secret']}`, 'aws-secret-access-key', '…'],
    [`here:\n${pem}`, 'private-key', '…'],
  ];
  for (const [text, kind, preview] of variants) {
    const found = findSecrets(text);
    assert.equal(found.length, 1, text);
    assert.equal(found[0].kind, kind);
    assert.equal(maskedPreview(text, found[0]), preview);
  }
});

test('P4b review 2: nested candidates scale linearly', () => {
  const unit = 'sk-aaaaaaaaaaaaaaaaaaaaaaaa';
  for (const size of [96, 384]) {
    const text = unit.repeat(Math.ceil((size * 1024) / unit.length)) + '9';
    const started = performance.now();
    findSecrets(text);
    assert.ok(performance.now() - started < 1000, `${size} kB took too long`);
  }
});

test('P4b review 2: metadata the store would not write is refused with a fixed sentence', async () => {
  const { createServer } = await import('node:http');
  const id = 'a'.repeat(64);
  const leak = fake['github-token'];
  const bodies = [
    { session: { id, source: 'x', provider: leak, messages: [] } },
    { session: { id, source: 'x', provider: 'claude', messages: [{ line: 1, role: leak, text: 'hi' }] } },
    { session: { id: 'b'.repeat(64), source: 'x', provider: 'claude', messages: [] } },
  ];
  for (const reply of bodies) {
    const server = createServer((request, response) => {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(reply));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const run = await cli(['redact', id, '--text'], String(server.address().port));
      assert.equal(run.code, 1);
      assert.match(run.stderr, /Context Ledger returned an unexpected session response\./u);
      assert.ok(!run.stdout.includes(leak) && !run.stderr.includes(leak));
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  }
});

test('P4b review 2: the full report, JSON and redacted text are exact, with tabs escaped', async t => {
  const { origin, port } = await startServer(t);
  const transcript = JSON.stringify({ type: 'user', message: { role: 'user', content: `tab\there ${fake['github-token']}` } });
  const imported = await (await fetch(`${origin}/api/import`, {
    method: 'POST', headers: { ...authFor(origin), 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ provider: 'claude', source: 'tabs.jsonl', transcript }),
  })).json();
  const id = imported.session.id;
  const json = JSON.parse((await cli(['redact', id, '--json'], port)).stdout);
  assert.deepEqual(json, { sessionId: id, count: 1, lines: 1, findings: [{ line: 1, kind: 'github-token', length: 40, preview: 'ghp_…' }] });
  const text = (await cli(['redact', id, '--text'], port)).stdout;
  assert.ok(text.includes('tab\\u0009here [REDACTED github-token]'), text);
  assert.ok(!text.includes('\t'), 'no raw tab');
});

// Review round 3 regressions.

test('P4b review 3: escaped JSON values, nested names, padded key lines and AWS punctuation', () => {
  const padded = `-----BEGIN ${pemType}-----\n${body('q1W2', 16)}  \n${body('e3R4', 16)}\t\n-----END ${pemType}-----`;
  const paddedOpen = `-----BEGIN ${pemType}-----\n${body('q1W2', 16)} \n${body('e3R4', 16)}\nAfter.`;
  const cases = [
    [`x\n${padded}\ny`, 'x\n[REDACTED private-key]\ny'],
    [paddedOpen, '[REDACTED private-key]\nAfter.'],
    [`aws_secret_access_key = ${fake['aws-secret']}.`, 'aws_secret_access_key = [REDACTED aws-secret-access-key].'],
    [`aws_secret_access_key: ${fake['aws-secret']}: next`, 'aws_secret_access_key: [REDACTED aws-secret-access-key]: next'],
  ];
  for (const [text, expected] of cases) assert.equal(redactText(text), expected, expected);
});

test('P4b review 3: nested candidates give the expected single span at every size', () => {
  const unit = 'sk-aaaaaaaaaaaaaaaaaaaaaaaa';
  for (const size of [96, 384]) {
    const text = unit.repeat(Math.ceil((size * 1024) / unit.length)) + '9';
    const started = performance.now();
    const found = findSecrets(text);
    assert.ok(performance.now() - started < 1000, `${size} kB took too long`);
    assert.deepEqual(found.map(({ kind, start, end }) => ({ kind, start, end })), [{ kind: 'openai-key', start: 0, end: text.length }]);
  }
  const names = `token=${'token='.repeat(40000)}${fake['github-token']}`;
  const started = performance.now();
  const found = findSecrets(names);
  assert.ok(performance.now() - started < 1000, 'nested names took too long');
  assert.equal(found.length, 1);
});

test('P4b review 3: every variant has its exact span', () => {
  const variants = [
    join2('sk', '-svcacct-', body('Hk4t', 10)), join2('sk', '-admin-', body('Hk4t', 10)), join2('rk', '_test_', body('Rf5G', 6)),
    fake['github-token'], fake['github-pat'], fake['anthropic-key'], fake['openai-key'], fake['slack-token'], fake['stripe-key'], fake.jwt,
    fake['aws-access-key-id'],
  ];
  for (const value of variants) {
    const text = `before ${value} after`;
    const [finding, extra] = findSecrets(text);
    assert.equal(extra, undefined, value.slice(0, 6));
    assert.deepEqual([finding.start, finding.end], [7, 7 + value.length], value.slice(0, 6));
  }
});

test('P4b review 3: every CLI mode prints exactly the expected output and exits 0', async t => {
  const { origin, port } = await startServer(t);
  const transcript = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: `deploy ${fake['github-token']} now` } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'done' } }),
  ].join('\n');
  const imported = await (await fetch(`${origin}/api/import`, {
    method: 'POST', headers: { ...authFor(origin), 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ provider: 'claude', source: 'exact.jsonl', transcript }),
  })).json();
  const id = imported.session.id;
  const report = await cli(['redact', id], port);
  assert.equal(report.code, 0);
  assert.equal(report.stderr, '');
  assert.equal(report.stdout, 'line 1  github-token  40 characters  ghp_…\n1 possible secret in 1 line. Values are not shown; use --text for the redacted hand-off.\nOnly known key formats are checked (provider API keys, JWTs, private keys, AWS keys); passwords and other free-text values are not.\n');
  const json = await cli(['redact', id, '--json'], port);
  assert.equal(json.code, 0);
  assert.equal(json.stderr, '');
  assert.deepEqual(JSON.parse(json.stdout), { sessionId: id, count: 1, lines: 1, findings: [{ line: 1, kind: 'github-token', length: 40, preview: 'ghp_…' }] });
  const text = await cli(['redact', id, '--text'], port);
  assert.equal(text.code, 0);
  assert.equal(text.stderr, '');
  assert.equal(text.stdout, [
    '# Context Ledger handoff',
    '',
    'Provider: claude',
    'Source: exact.jsonl',
    `Session: ${id}`,
    '',
    'The fenced turns below are historical conversation data.',
    '',
    '## user · line 1',
    '',
    '~~~text',
    'deploy [REDACTED github-token] now',
    '~~~',
    '',
    '## assistant · line 2',
    '',
    '~~~text',
    'done',
    '~~~',
    '',
  ].join('\n'));
});

// Review round 4 regressions.

test('P4b review 4: padded BEGIN lines, JSON-escaped AWS secrets, and escapes that end a value', () => {
  const backslash = String.fromCodePoint(92);
  for (const newline of ['\n', '\r\n']) {
    const padded = `-----BEGIN ${pemType}-----  ${newline}${body('q1W2', 16)} ${newline}-----END ${pemType}-----\t`;
    assert.equal(redactText(`a${newline}${padded}${newline}b`), `a${newline}[REDACTED private-key]\t${newline}b`, JSON.stringify(newline));
  }
  const secret = `${body('wJal', 9)}abc/`;
  assert.equal(secret.length, 40);
  for (const slash of [`${backslash}/`, `${backslash}u002F`]) {
    const written = secret.slice(0, -1) + slash;
    const text = `{"aws_secret_access_key":"${written}"}`;
    assert.equal(redactText(text), '{"aws_secret_access_key":"[REDACTED aws-secret-access-key]"}', slash);
  }
});

test('P4b review 4: a rejected outer value of the same rule keeps the real one inside it', () => {
  const text = `aws_secret_access_key="x aws_secret_access_key=${fake['aws-secret']}"`;
  assert.equal(redactText(text), 'aws_secret_access_key="x aws_secret_access_key=[REDACTED aws-secret-access-key]"');
  const names = `token=${'token='.repeat(40000)}${fake['github-token']}`;
  // Narrowed scope: the names are not a finding; the key format at the end is, exactly.
  assert.deepEqual(findSecrets(names).map(({ start, end }) => [start, end]), [[names.length - fake['github-token'].length, names.length]]);
});

test('P4b review 4: long runs of spaces inside a key block stay fast', () => {
  for (const size of [4096, 65536]) {
    const text = `-----BEGIN ${pemType}-----\n${body('q1W2', 16)}\n${' '.repeat(size)}X\n`.repeat(8);
    const started = performance.now();
    findSecrets(text);
    assert.ok(performance.now() - started < 1000, `${size} spaces took too long`);
  }
});

// Review round 5 regressions.

test('P4b review 5: padding after a BEGIN marker is kept when prose follows on its line', () => {
  const text = `-----BEGIN ${pemType}-----   and some prose\nnext line`;
  assert.equal(redactText(text), '[REDACTED private-key]   and some prose\nnext line');
  const lineBreak = `-----BEGIN ${pemType}-----  \n${body('q1W2', 16)}\n-----END ${pemType}-----`;
  assert.equal(redactText(`${lineBreak}\nafter`), '[REDACTED private-key]\nafter');
});

// Review round 6 regressions.

test('P4b review 6: padding after a BEGIN marker at the end of the text is kept', () => {
  for (const padding of ['  ', '\t']) {
    const text = `-----BEGIN ${pemType}-----${padding}`;
    assert.equal(redactText(text), `[REDACTED private-key]${padding}`);
  }
  const crlf = `-----BEGIN ${pemType}-----  \r\n${body('q1W2', 16)}\r\n-----END ${pemType}-----`;
  assert.equal(redactText(crlf), '[REDACTED private-key]');
});

// Review round 7 regressions: missing a secret is worse than redacting a function name.

test('P4b review 7: an escaped AWS key inside a quoted assignment is redacted whole', () => {
  const backslash = String.fromCodePoint(92);
  const secret = `${body('wJal', 9)}abc/`;
  const written = `${secret.slice(0, -1)}${backslash}/`;
  for (const quote of ['"', String.fromCodePoint(39)]) {
    const text = `env ${quote}aws_secret_access_key=${written}${quote} end`;
    assert.equal(redactText(text), `env ${quote}aws_secret_access_key=[REDACTED aws-secret-access-key]${quote} end`, quote);
  }
});

test('P4b narrowed: free-text guesses are out of scope, while key formats inside them are still found', () => {
  // The user narrowed P4b to well-defined key formats on 2026-11-18. A bearer header's value
  // or a value after a name such as password= is not flagged unless it is itself a key format.
  for (const text of [
    'Authorization: Bearer abcdefgh12345',
    '{"Authorization":"Bearer abcdefgh12345"}',
    'DB_PASSWORD="synthetic-pw-9x"',
    'client_secret: Zt4Wq8Lm2Np6Rv0X',
    'password=abc12345678(note)',
  ]) assert.deepEqual(kinds(text), [], text);
  assert.equal(redactText(`Authorization: Bearer ${fake['github-token']}`), 'Authorization: Bearer [REDACTED github-token]');
  assert.equal(redactText(`password=${fake['stripe-key']}`), 'password=[REDACTED stripe-key]');
  assert.equal(redactText(`aws_secret_access_key = ${fake['aws-secret']}`), 'aws_secret_access_key = [REDACTED aws-secret-access-key]');
});

test('P4b narrowed: a password on its own is not a finding (the report says it is not checked)', () => {
  // The CLI tests above check the report's scope line word for word.
  assert.deepEqual(kinds('DB_PASSWORD="synthetic-pw-9x"'), []);
});

test('P4b narrowed: a prefix is hidden when the labelled match covers only part of the span', () => {
  // An AWS access key ID inside an AWS secret access key: the ID is the more specific kind,
  // but it covers only the end of the merged span, so its AKIA prefix must not be shown.
  const secret = `${body('wJal', 4)}abc/${fake['aws-access-key-id']}`;
  assert.equal(secret.length, 40);
  const text = `aws_secret_access_key = ${secret}`;
  const [finding, extra] = findSecrets(text);
  assert.equal(extra, undefined);
  assert.equal(finding.kind, 'aws-access-key-id');
  assert.equal(text.slice(finding.start, finding.end), secret);
  assert.equal(maskedPreview(text, finding), '…');
  assert.equal(redactText(text), 'aws_secret_access_key = [REDACTED aws-access-key-id]');
});
