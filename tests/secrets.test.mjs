import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { handoffMarkdown } from '../src/handoff.mjs';
import {
  copyBudgetMessage, copyMatcher, findSecrets, maskedPreview, redactSession, redactText,
} from '../src/secrets.mjs';
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
    'max_tokens: 4096',
    'Use the risk-assessment-for-the-project-and-team page.',
    'See sk-learn-documentation-for-everyone here.',
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
    // P4c: the line tail after DB_PASSWORD= merges with the AWS key ID on the same line, so
    // one span covers both and no prefix is shown.
    'line 3  aws-access-key-id  43 characters  …',
    '2 possible secrets in 2 lines. Values are not shown; use --text for the redacted hand-off.',
    'Checked: known key formats, and the rest of the same line after an Authorization: Bearer header or a secret-like name followed by : or = (such as password=), unless the whole value is a placeholder. A value that continues onto the next line, and other free-text secrets, are not found.',
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
  // P4c: a bearer value of any length is redacted to the end of its line.
  assert.deepEqual(kinds('Authorization: Bearer short1'), ['bearer-token']);
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
    'Checked: known key formats, and the rest of the same line after an Authorization: Bearer header or a secret-like name followed by : or = (such as password=), unless the whole value is a placeholder. A value that continues onto the next line, and other free-text secrets, are not found.',
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
  assert.equal(report.stdout, 'line 1  github-token  40 characters  ghp_…\n1 possible secret in 1 line. Values are not shown; use --text for the redacted hand-off.\nChecked: known key formats, and the rest of the same line after an Authorization: Bearer header or a secret-like name followed by : or = (such as password=), unless the whole value is a placeholder. A value that continues onto the next line, and other free-text secrets, are not found.\n');
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
  // P4c: the first name's line tail covers the rest of the line, the key format included.
  assert.deepEqual(findSecrets(names).map(({ start, end }) => [start, end]), [[6, names.length]]);
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

test('P4c: after a bearer header or a secret-like name, the rest of the line is redacted', () => {
  const cases = [
    ['Authorization: Bearer abcdefgh12345', 'Authorization: Bearer [REDACTED bearer-token]'],
    ['{"Authorization":"Bearer abcdefgh12345"}', '{"Authorization":"Bearer [REDACTED bearer-token]'],
    ['DB_PASSWORD="synthetic-pw-9x"', 'DB_PASSWORD="[REDACTED assigned-secret]'],
    ['client_secret: Zt4Wq8Lm2Np6Rv0X', 'client_secret: [REDACTED assigned-secret]'],
    ['password=abc12345678(note)', 'password=[REDACTED assigned-secret]'],
    ['password: hunter2', 'password: [REDACTED assigned-secret]'],
    ['a\npassword=pw1\nnext line', 'a\npassword=[REDACTED assigned-secret]\nnext line'],
  ];
  for (const [text, expected] of cases) assert.equal(redactText(text), expected, text);
  // Key formats on such a line still give their own kind, with no prefix shown.
  assert.equal(redactText(`Authorization: Bearer ${fake['github-token']}`), 'Authorization: Bearer [REDACTED github-token]');
  assert.equal(redactText(`password=${fake['stripe-key']}`), 'password=[REDACTED stripe-key]');
  assert.equal(redactText(`aws_secret_access_key = ${fake['aws-secret']}`), 'aws_secret_access_key = [REDACTED aws-secret-access-key]');
});

test('P4c: code under a secret-like name is over-redacted, by design', () => {
  assert.deepEqual(kinds('token = getToken()'), ['assigned-secret']);
  assert.deepEqual(kinds('apiKey = config.apiKey'), ['assigned-secret']);
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

test('P4d: a value found once is removed wherever else it appears in the session', () => {
  const password = ['Zx9q', 'Wm3v', 'Lt7p', 'Rk2s'].join('');
  const quoted = ['Ab12', ' Cd34', 'xy'].join('');
  const session = {
    id: 'b'.repeat(64), provider: 'claude', source: `notes-${password}.jsonl`,
    messages: [
      { role: 'user', line: 1, text: `set password=${password} today.` },
      { role: 'assistant', line: 2, text: `I copied ${password} into the env file, and ${fake['github-token']}.` },
      { role: 'user', line: 3, text: `token: "${quoted}" and later ${quoted} again` },
      { role: 'user', line: 4, text: `push with ${fake['github-token']}` },
      { role: 'user', line: 5, text: 'password=ab12x then ab12x again, a short value' },
      { role: 'assistant', line: 6, text: 'Nothing to hide here, today.' },
    ],
  };
  const { session: redacted, findings } = redactSession(session);
  const shown = JSON.stringify(redacted);
  for (const value of [password, quoted, fake['github-token']]) assert.ok(!shown.includes(value), value.slice(0, 4));
  assert.equal(redacted.source, 'notes-[REDACTED assigned-secret].jsonl');
  assert.equal(redacted.messages[1].text, 'I copied [REDACTED assigned-secret] into the env file, and [REDACTED github-token].');
  assert.equal(redacted.messages[2].text, 'token: "[REDACTED assigned-secret]');
  // The rest of the line after a name is cut, but its other words are not searched for.
  assert.equal(redacted.messages[5], session.messages[5]);
  // A value shorter than six characters is removed only where it was found.
  assert.equal(redacted.messages[4].text, 'password=[REDACTED assigned-secret]');
  assert.deepEqual(findings.map(({ line, kind }) => [line, kind]), [
    [null, 'assigned-secret'], [1, 'assigned-secret'], [2, 'assigned-secret'], [2, 'github-token'],
    [3, 'assigned-secret'], [4, 'github-token'], [5, 'assigned-secret'],
  ]);
  // A copy shows no prefix; a format found where it stands still does.
  assert.deepEqual(findings.filter(finding => finding.line === 2).map(finding => finding.preview), ['…', 'ghp_…']);
  assert.equal(findings.find(finding => finding.line === 4).preview, 'ghp_…');
});

test('P4d: a copy that overlaps a finding widens it, and the longer of two values is matched whole', () => {
  const short = ['Qw8e', 'Rt5y', 'Ui'].join('');
  const long = short + ['Op3a', 'Sd'].join('');
  const session = {
    id: 'c'.repeat(64), provider: 'codex', source: 'x.jsonl',
    messages: [
      { role: 'user', line: 1, text: `secret=${short}` },
      { role: 'user', line: 2, text: `api_key=${long}` },
      { role: 'assistant', line: 3, text: `kept ${long} and ${short}` },
    ],
  };
  const { session: redacted } = redactSession(session);
  assert.equal(redacted.messages[2].text, 'kept [REDACTED assigned-secret] and [REDACTED assigned-secret]');
});

test('P4d: a found value is also removed from an agent turn\'s author and recipient', () => {
  const password = ['Pl4y', 'Gr0u', 'nd77'].join('');
  const session = {
    id: 'd'.repeat(64), provider: 'codex', source: 'agents.jsonl',
    messages: [
      { role: 'user', line: 1, text: `db password=${password}` },
      { role: 'agent', line: 2, author: `/root/${password}`, recipient: '/root/worker', text: 'Synthetic: picked it up.' },
    ],
  };
  const { session: redacted, findings } = redactSession(session);
  assert.equal(redacted.messages[1].author, '/root/[REDACTED assigned-secret]');
  assert.equal(redacted.messages[1].recipient, '/root/worker');
  assert.equal(redacted.messages[1].text, 'Synthetic: picked it up.');
  assert.ok(!JSON.stringify(redacted).includes(password));
  assert.deepEqual(findings.map(({ line, kind }) => [line, kind]), [[1, 'assigned-secret'], [2, 'assigned-secret']]);
  assert.equal(session.messages[1].author, `/root/${password}`, 'the input is not changed');
});

test('P4d review: a passphrase, a later key-like word and an escaped quote are matched as copies', () => {
  const phrase = ['correct', 'horse', 'battery', 'staple'].join(' ');
  const keyWord = ['def1', '2345', '6789'].join('');
  const BS = String.fromCodePoint(92);
  const quotedRaw = ['ab', BS, '"cd', 'efgh1234'].join('');
  const quotedDecoded = ['ab', '"cd', 'efgh1234'].join('');
  const session = {
    id: 'e'.repeat(64), provider: 'claude', source: 'x.jsonl',
    messages: [
      { role: 'user', line: 1, text: `password: ${phrase}` },
      { role: 'assistant', line: 2, text: `say ${phrase} now` },
      { role: 'user', line: 3, text: `password: abc ${keyWord}` },
      { role: 'assistant', line: 4, text: `later ${keyWord}` },
      { role: 'user', line: 5, text: `password: "${quotedRaw}"` },
      { role: 'assistant', line: 6, text: `as written ${quotedRaw} and decoded ${quotedDecoded} end` },
    ],
  };
  const { session: redacted } = redactSession(session);
  assert.equal(redacted.messages[1].text, 'say [REDACTED assigned-secret] now');
  assert.equal(redacted.messages[3].text, 'later [REDACTED assigned-secret]');
  assert.equal(redacted.messages[5].text, 'as written [REDACTED assigned-secret] and decoded [REDACTED assigned-secret] end');
});

test('P4d review: the copy search is one pass per field, not one per value', () => {
  const messages = Array.from({ length: 20000 }, (_, index) => ({ role: 'user', line: index + 1, text: `token=${('k' + index).padEnd(12, 'Q')}9z` }));
  messages.push({ role: 'assistant', line: 9999, text: 'x'.repeat(4 * 1024 * 1024) });
  const started = process.hrtime.bigint();
  const { findings } = redactSession({ id: 'f'.repeat(64), provider: 'claude', source: 'y.jsonl', messages });
  const seconds = Number(process.hrtime.bigint() - started) / 1e9;
  assert.equal(findings.length, 20000);
  // One indexOf per value took about 8 s on the Windows dev laptop; one pass, under 1 s.
  assert.ok(seconds < 4, `${seconds} s`);
});

test('P4d review 2: copies of values merged into one finding, spaced passphrases and escaped bearer values', () => {
  const BS = String.fromCodePoint(92);
  const word = ['Viol', 'etLa', 'rk'].join('');
  const session = {
    id: 'a'.repeat(64), provider: 'claude', source: 'x.jsonl',
    messages: [
      // A password and a GitHub token on one line merge into one github-token finding.
      { role: 'user', line: 1, text: `password=${word} with ${fake['github-token']}` },
      { role: 'assistant', line: 2, text: `${word} and a${fake['github-token']}` },
      { role: 'user', line: 3, text: 'password=Amber  Fox91 followed by prose' },
      { role: 'assistant', line: 4, text: 'again Amber  Fox91 here' },
      { role: 'user', line: 5, text: `"Authorization": "Bearer ${BS}u0051uartzOwl77"` },
      { role: 'assistant', line: 6, text: 'QuartzOwl77 later' },
    ],
  };
  const { session: redacted } = redactSession(session);
  assert.equal(redacted.messages[1].text, '[REDACTED github-token] and a[REDACTED github-token]');
  assert.equal(redacted.messages[3].text, 'again [REDACTED assigned-secret] here');
  assert.equal(redacted.messages[5].text, '[REDACTED bearer-token] later');
});

test('P4d review 2: an agent turn\'s heading never shows a found value, in author or recipient', () => {
  const value = ['Rook', 'Tide', '42'].join('');
  const session = {
    id: 'a'.repeat(64), provider: 'codex', source: 'agents.jsonl',
    messages: [
      { role: 'user', line: 1, text: `secret: ${value}` },
      { role: 'agent', line: 2, author: '/root/lead', recipient: `/root/${value}`, text: 'Synthetic: hand-over.' },
    ],
  };
  const markdown = handoffMarkdown(redactSession(session).session);
  assert.ok(!markdown.includes(value));
  assert.ok(markdown.includes('## agent /root/lead to /root/\\[REDACTED assigned-secret\\] · line 2'), markdown);
});

test('P4d review 2: many values that share their first characters stay linear', () => {
  const count = 20000;
  const messages = Array.from({ length: count }, (_, index) => ({ role: 'user', line: index + 1, text: `token=shared${index.toString(36).padStart(5, '0')}Q` }));
  messages.push({ role: 'assistant', line: count + 1, text: 'shared_'.repeat(count) });
  const started = process.hrtime.bigint();
  const { findings } = redactSession({ id: 'a'.repeat(64), provider: 'claude', source: 'y.jsonl', messages });
  const seconds = Number(process.hrtime.bigint() - started) / 1e9;
  assert.equal(findings.length, count);
  // Grouping values by their first six characters grew with the square (5 s at 8,000 in
  // Codex's run); the matcher takes under 1 s.
  assert.ok(seconds < 4, `${seconds} s`);
});

test('P4d review 3: nested keys keep their boundaries, long passphrases match whole, and suffix and crossing matches merge', () => {
  const token = ['gh', 'p_', 'A1'.repeat(18)].join('');
  const m = (line, text) => ({ role: 'user', line, text });
  const cases = [
    [[m(1, 'password=orchidvault Authorization: Bearer lavendergarden'), m(2, 'lavendergarden')], '[REDACTED assigned-secret]'],
    [[m(1, `password=orchidvault (${token})/suffix`), m(2, 'X' + token)], 'X[REDACTED github-token]'],
    [[m(1, 'password=amber birch cedar dune elm frost grove heath indigoorchard is rotated weekly'),
      m(2, 'amber birch cedar dune elm frost grove heath indigoorchard')], '[REDACTED assigned-secret]'],
    [[m(1, 'password=violetgarden'), m(2, 'password=northvioletgardenend'), m(3, 'northvioletgarden!')], 'north[REDACTED assigned-secret]!'],
    [[m(1, 'password=violetgarden'), m(2, 'password=gardennorth'), m(3, 'violetgardennorth')], '[REDACTED assigned-secret]'],
  ];
  for (const [messages, expected] of cases) {
    const { session } = redactSession({ id: 'a'.repeat(64), provider: 'claude', source: 'x.jsonl', messages });
    assert.equal(session.messages.at(-1).text, expected, messages.at(-1).text);
  }
});

test('P4d review 3: one very long finding adds a bounded amount to the copy search', () => {
  const text = 'password=synthetic9' + 'a'.repeat(1_000_000);
  const before = process.memoryUsage().heapUsed;
  const { session, findings } = redactSession({ id: 'a'.repeat(64), provider: 'claude', source: 'x.jsonl', messages: [{ role: 'user', line: 1, text }] });
  const grown = (process.memoryUsage().heapUsed - before) / 2 ** 20;
  assert.equal(session.messages[0].text, 'password=[REDACTED assigned-secret]');
  assert.equal(findings.length, 1);
  // A trie node per character of the whole value took about 290 MiB in Codex's run.
  assert.ok(grown < 64, `${grown} MiB`);
});

test('P4d review 4: a quoted Bearer value, many findings in one message and many key-like words in one stay bounded', () => {
  const m = (line, text) => ({ role: 'user', line, text });
  const quoted = redactSession({ id: 'a'.repeat(64), provider: 'claude', source: 'x.jsonl', messages: [
    m(1, '"Authorization": "Bearer SYNTHETIC-PHRASE","note":"example"'), m(2, 'Copied SYNTHETIC-PHRASE'),
  ] }).session;
  assert.equal(quoted.messages[1].text, 'Copied [REDACTED bearer-token]');

  const lines = Array.from({ length: 40000 }, (_, index) => 'password=z' + index.toString(36).padStart(7, '0')).join('\n');
  let started = process.hrtime.bigint();
  const { findings } = redactSession({ id: 'a'.repeat(64), provider: 'claude', source: 'x.jsonl', messages: [m(1, lines)] });
  let seconds = Number(process.hrtime.bigint() - started) / 1e9;
  assert.equal(findings.length, 40000);
  // Looking each candidate's finding up from the start took about 3.8 s in Codex's run.
  assert.ok(seconds < 3, `${seconds} s`);

  const words = Array.from({ length: 10000 }, (_, index) => index.toString(36).padStart(6, '0') + 'Ab' + 'x'.repeat(91)).join(' ');
  const before = process.memoryUsage().heapUsed;
  const wide = redactSession({ id: 'a'.repeat(64), provider: 'claude', source: 'x.jsonl', messages: [m(1, 'password=' + words)] });
  const grown = (process.memoryUsage().heapUsed - before) / 2 ** 20;
  assert.equal(wide.findings.length, 1);
  // An entry per key-like word took about 220 MiB in Codex's run; the budget is per candidate.
  assert.ok(grown < 64, `${grown} MiB`);
});

test('P4d review 5: a quoted value full of escapes is still searched for decoded', () => {
  const BS = String.fromCodePoint(92);
  const { session } = redactSession({ id: 'a'.repeat(64), provider: 'claude', source: 'x.jsonl', messages: [
    { role: 'user', line: 1, text: 'password="' + (BS + 'u0051').repeat(44) + '"' },
    { role: 'assistant', line: 2, text: 'Copied ' + 'Q'.repeat(44) },
  ] });
  assert.equal(session.messages[1].text, 'Copied [REDACTED assigned-secret]');
});

test('P4d review 6: a second named value on a line, and a long decoded passphrase, are searched for whole', () => {
  const BS = String.fromCodePoint(92);
  const tail = 'lilac maple cedar birch spruce poplar willow juniper hemlock chestnut sycamore hawthorn sequoia magnolia rhododendron';
  const run = messages => redactSession({ id: 'a'.repeat(64), provider: 'claude', source: 'x.jsonl', messages }).session.messages.at(-1).text;
  assert.equal(run([
    { role: 'user', line: 1, text: 'password=alphaPrim token=ZephyrMosaic72' },
    { role: 'assistant', line: 2, text: 'ZephyrMosaic72' },
  ]), '[REDACTED assigned-secret]');
  assert.equal(run([
    { role: 'user', line: 1, text: 'password=alphaPrim secret=lavendergarden' },
    { role: 'assistant', line: 2, text: 'got lavendergarden' },
  ]), 'got [REDACTED assigned-secret]');
  assert.equal(run([
    { role: 'user', line: 1, text: `password=${BS}u0061 ${tail}` },
    { role: 'assistant', line: 2, text: `a ${tail}` },
  ]), '[REDACTED assigned-secret]');
});

test('P4d review 7: a quoted value after a further name in JSON, and many names on one line', () => {
  const run = messages => redactSession({ id: 'a'.repeat(64), provider: 'claude', source: 'x.jsonl', messages }).session.messages.at(-1).text;
  assert.equal(run([
    { role: 'user', line: 1, text: '{"password":"firstphrase","token":"violetorchid","note":"synthetic"}' },
    { role: 'assistant', line: 2, text: 'Copied violetorchid today.' },
  ]), 'Copied [REDACTED assigned-secret] today.');
  assert.equal(run([
    { role: 'user', line: 1, text: 'password=firstphrase token=secondphrase token=thirdphrase ' + 'a'.repeat(370) + ' token=violetorchid' },
    { role: 'assistant', line: 2, text: 'Copied violetorchid today.' },
  ]), 'Copied [REDACTED assigned-secret] today.');
});

test('P4d review 8: a decoded value after a long span, and a value in a query string', () => {
  const BS = String.fromCodePoint(92);
  const value = ['violetorchid', 'mapleforest', 'indigomeadow', 'lavenderwillow', 'junipercedar'].join('');
  const run = messages => redactSession({ id: 'a'.repeat(64), provider: 'claude', source: 'x.jsonl', messages }).session.messages.at(-1).text;
  assert.equal(run([
    { role: 'user', line: 1, text: 'password=' + 'a'.repeat(437) + ' token="' + BS + 'u0076' + value.slice(1) + '"' },
    { role: 'assistant', line: 2, text: value },
  ]), '[REDACTED assigned-secret]');
  assert.equal(run([
    { role: 'user', line: 1, text: 'password=violetorchid&user=alice' },
    { role: 'assistant', line: 2, text: 'violetorchid' },
  ]), '[REDACTED assigned-secret]');
});

test('P4d review 9: a name after a long first part, and a whole long value, are still found', () => {
  const run = messages => redactSession({ id: 'a'.repeat(64), provider: 'claude', source: 'x.jsonl', messages }).session.messages.at(-1).text;
  // Codex review of 2026-11-27: the line's first 512 characters hid the later token=.
  assert.equal(run([
    { role: 'user', line: 1, text: 'password=' + 'a'.repeat(520) + ' token=LateValue987' },
    { role: 'assistant', line: 2, text: 'LateValue987' },
  ]), '[REDACTED assigned-secret]');
  // A bare copy of a long value lost only its first 512 characters.
  const long = 'a'.repeat(520) + 'TAILVALUE987';
  assert.equal(run([
    { role: 'user', line: 1, text: 'password=' + long },
    { role: 'assistant', line: 2, text: long },
  ]), '[REDACTED assigned-secret]');
  assert.equal(run([
    { role: 'user', line: 1, text: 'password=' + long },
    { role: 'assistant', line: 2, text: `before ${long} after` },
  ]), 'before [REDACTED assigned-secret] after');
  // A copy that differs after the first part is still cut, never left whole.
  assert.equal(run([
    { role: 'user', line: 1, text: 'password=' + long },
    { role: 'assistant', line: 2, text: 'a'.repeat(520) + 'OTHER' },
  ]), '[REDACTED assigned-secret]OTHER');
});

test('P4d review 9: a widened span keeps its end when later, shorter matches merge into it', () => {
  // The short value sits strictly inside the long one, which goes on past it (Codex round 4).
  const long = 'Zq9' + 'b'.repeat(600) + ' Kx7mWord ' + 'c'.repeat(40);
  const { session } = redactSession({ id: 'a'.repeat(64), provider: 'claude', source: 'x.jsonl', messages: [
    { role: 'user', line: 1, text: 'password=' + long },
    { role: 'user', line: 2, text: 'secret=Kx7mWord' },
    { role: 'assistant', line: 3, text: `${long} end` },
  ] });
  assert.equal(session.messages[2].text, '[REDACTED assigned-secret] end');
});

test('P4d review 9: the copy check refuses a session past its node or work budget', () => {
  const entry = value => ({ value, ends: [value.length], kind: 'assigned-secret' });
  // Codex: 12,000 distinct 500-character values made about six million trie nodes.
  const many = Array.from({ length: 50 }, (_, index) => entry(index.toString(36).padStart(4, '0') + 'x'.repeat(496)));
  assert.throws(() => copyMatcher(many, { nodeBudget: 10_000 }), { message: copyBudgetMessage });
  assert.doesNotThrow(() => copyMatcher(many, { nodeBudget: 30_000 }));
  // Comparing a long value at each of many places has its own budget.
  const value = 'y'.repeat(2000);
  const search = copyMatcher([entry(value)], { workBudget: 100_000 });
  assert.throws(() => search('z'.repeat(1).concat(value, ' ').repeat(200)), { message: copyBudgetMessage });
  assert.equal(copyMatcher([entry(value)])(`a ${value} b`).length, 1);
});

test('P4d review 9: a session with too many long values is refused, not signed half-checked', () => {
  // 2,200 distinct values of 500 characters need more matcher nodes than the budget allows.
  const lines = Array.from({ length: 2200 }, (_, index) => 'password=' + index.toString(36).padStart(4, '0') + 'Qx'.repeat(248));
  const started = performance.now();
  assert.throws(() => redactSession({ id: 'a'.repeat(64), provider: 'claude', source: 'x.jsonl', messages: [
    { role: 'user', line: 1, text: lines.join('\n') },
  ] }), { message: copyBudgetMessage });
  assert.ok(performance.now() - started < 20_000, 'the refusal took too long');
});

test('P4d review 9: a copy that holds a direct finding widens it and hides its prefix', () => {
  const value = 'Synth9-' + fake['aws-access-key-id'];
  const { session, findings } = redactSession({ id: 'a'.repeat(64), provider: 'claude', source: 'x.jsonl', messages: [
    { role: 'user', line: 1, text: `password=${value}` },
    { role: 'user', line: 2, text: `copied ${value} here` },
  ] });
  // Line 2's key is found directly; the copy of the whole value starts before it and widens it.
  const line2 = findings.filter(finding => finding.line === 2);
  assert.ok(findSecrets(`copied ${value} here`).length === 1, 'the key alone is a direct finding');
  // Line 1's finding takes its most specific kind, and the copy takes the finding's.
  assert.equal(session.messages[1].text, 'copied [REDACTED aws-access-key-id] here');
  assert.deepEqual(line2.map(finding => finding.preview), ['…']);
});

test('P4d review 10: the decoded start of a long escaped value still counts at its end', () => {
  const BS = String.fromCodePoint(92);
  const run = messages => redactSession({ id: 'a'.repeat(64), provider: 'claude', source: 'x.jsonl', messages }).session.messages.at(-1).text;
  // Codex round 2 of 2026-11-27: main cut this copy through ZT; keeping the whole value lost that.
  assert.equal(run([
    { role: 'user', line: 1, text: 'password="' + (BS + 'u0061').repeat(85) + 'ZTAILvalue"' },
    { role: 'assistant', line: 2, text: 'a'.repeat(85) + 'ZTOTHER' },
  ]), '[REDACTED assigned-secret]OTHER');
});

test('P4d review 10: many failed confirmations against a value with many ends stay fast', () => {
  const session = { id: 'a'.repeat(64), provider: 'claude', source: 'x.jsonl', messages: [
    { role: 'user', line: 1, text: 'password="' + 'a'.repeat(512) + ';'.repeat(65022) + 'X"' },
    { role: 'assistant', line: 2, text: ('a'.repeat(512) + 'Z').repeat(5000) },
  ] };
  const started = performance.now();
  redactSession(session);
  // Each failed confirmation filtered about 65,000 ends: about 14 s in Codex's run.
  assert.ok(performance.now() - started < 3000, `${performance.now() - started} ms`);
});

test('P4d review 10: a long run of punctuation before a last letter is scanned in linear time', () => {
  const session = { id: 'a'.repeat(64), provider: 'claude', source: 'x.jsonl', messages: [
    { role: 'user', line: 1, text: 'password="a1' + '!'.repeat(65533) + 'X"' },
  ] };
  const started = performance.now();
  redactSession(session);
  // An unanchored /[...]+$/ retried the run at every offset.
  assert.ok(performance.now() - started < 3000, `${performance.now() - started} ms`);
});

test('P4d review 10: a long value repeated in many messages is collected once', () => {
  const line = 'password="' + 'a'.repeat(512) + ';'.repeat(65022) + 'X"';
  const messages = Array.from({ length: 300 }, (_, index) => ({ role: 'user', line: index + 1, text: line }));
  const before = process.memoryUsage().heapUsed;
  const started = performance.now();
  const { findings } = redactSession({ id: 'a'.repeat(64), provider: 'claude', source: 'x.jsonl', messages });
  const grown = (process.memoryUsage().heapUsed - before) / 2 ** 20;
  assert.equal(findings.length, 300);
  // One endpoint list per copy held tens of millions of slots.
  assert.ok(grown < 200, `${grown} MiB`);
  assert.ok(performance.now() - started < 10_000, `${performance.now() - started} ms`);
});

test('P4d review 10: a confirmed long value keeps its end when shorter matches follow inside it', () => {
  const long = 'A'.repeat(512) + 'B'.repeat(100) + 'C'.repeat(20);
  const search = copyMatcher([
    { value: long, ends: [long.length], kind: 'long' },
    { value: 'B'.repeat(6), ends: [6], kind: 'short' },
  ]);
  // The B matches end before the C run; without the largest end the C run would be kept.
  assert.deepEqual(search(`x ${long} y`).map(({ start, end }) => [start, end]), [[2, 2 + long.length]]);
});

test('P4d review 11: every copy main removed is still removed, such as the start of a value cut by punctuation', () => {
  const run = messages => redactSession({ id: 'a'.repeat(64), provider: 'claude', source: 'x.jsonl', messages }).session.messages.at(-1).text;
  // Codex round 3 of 2026-11-27: main's 512-character part ended in !!, so it counted at 510.
  const start = 'a'.repeat(510);
  assert.equal(run([
    { role: 'user', line: 1, text: 'password=' + start + '!!X' },
    { role: 'assistant', line: 2, text: start },
  ]), '[REDACTED assigned-secret]');
});

test('P4d review 11: the copy check refuses a session with more copies than its span budget', () => {
  const search = copyMatcher([{ value: 'Synth9', ends: [6], kind: 'assigned-secret' }], { spanBudget: 1000 });
  assert.equal(search('Synth9 '.repeat(1000)).length, 1000);
  assert.throws(() => search('Synth9 '), { message: copyBudgetMessage });
  // Through redactSession: one short value pasted far more often than the budget allows.
  assert.throws(() => redactSession({ id: 'a'.repeat(64), provider: 'claude', source: 'x.jsonl', messages: [
    { role: 'user', line: 1, text: 'password=Synth9' },
    { role: 'assistant', line: 2, text: 'Synth9 '.repeat(2 ** 20 + 1) },
  ] }), { message: copyBudgetMessage });
});

test('P4d review 11: the copy check refuses a session past its collected-characters budget', () => {
  // 257 distinct 64 Ki values sharing their first 512 characters need few nodes but many characters.
  const shared = 'c'.repeat(512);
  const lines = Array.from({ length: 257 }, (_, index) => 'password=' + shared + index.toString(36).padStart(3, '0') + 'd'.repeat(65536 - 515));
  assert.throws(() => redactSession({ id: 'a'.repeat(64), provider: 'claude', source: 'x.jsonl', messages: [
    { role: 'user', line: 1, text: lines.join('\n') },
  ] }), { message: copyBudgetMessage });
});

test('P4d review 12: a value collected first as another one\'s decoded form is still decoded itself', () => {
  const BS = String.fromCodePoint(92);
  const p = 'SyntheticPhrase'.repeat(39);
  const run = messages => redactSession({ id: 'a'.repeat(64), provider: 'claude', source: 'x.jsonl', messages }).session.messages.at(-1).text;
  // Codex round 4: the first line's decoded value is the second's raw value.
  assert.equal(run([
    { role: 'user', line: 1, text: 'password=' + p + BS + BS + 'ZTail987' },
    { role: 'user', line: 2, text: 'password=' + p + BS + 'ZTail987' },
    { role: 'assistant', line: 3, text: p + 'ZTail987' },
  ]), '[REDACTED assigned-secret]');
});

test('P4d review 12: one long assignment is not refused for comparing against itself', () => {
  const { session } = redactSession({ id: 'a'.repeat(64), provider: 'claude', source: 'x.jsonl', messages: [
    { role: 'user', line: 1, text: 'password=' + 'A'.repeat(64000) },
  ] });
  assert.equal(session.messages[0].text, 'password=[REDACTED assigned-secret]');
});

test('P4d review 12: a session with more direct findings than the budget is refused', () => {
  assert.throws(() => redactSession({ id: 'a'.repeat(64), provider: 'claude', source: 'x.jsonl', messages: [
    { role: 'user', line: 1, text: 'pwd=a\n'.repeat(2 ** 20 + 1) },
  ] }), { message: copyBudgetMessage });
});

test('P4d review 12: the same value given twice counts at the ends of both', () => {
  const search = copyMatcher([
    { value: 'ABCDEFgh', ends: [8], kind: 'first' },
    { value: 'ABCDEFgh', ends: [6, 8], kind: 'second' },
  ]);
  // The merged end, with the first value's kind (Codex round 5).
  assert.deepEqual(search('x ABCDEF y'), [{ kind: 'first', start: 2, end: 8, prefix: 0 }]);
});

test('P4d review 12: a copy keeps the kind main gave it when a whole value also covers it', () => {
  const run = messages => redactSession({ id: 'a'.repeat(64), provider: 'claude', source: 'x.jsonl', messages }).session.messages.at(-1).text;
  // Codex round 4: with whole values first, this marker turned from assigned-secret to bearer-token.
  assert.equal(run([
    { role: 'user', line: 1, text: 'Authorization: Bearer ' + 'A'.repeat(520) + ' Kx7mWord' },
    { role: 'user', line: 2, text: 'password=Kx7mWord' },
    { role: 'assistant', line: 3, text: 'Kx7mWord' },
  ]), '[REDACTED assigned-secret]');
});

test('P4e: a bare copy of a hyphenated passphrase longer than 512 characters is replaced whole', () => {
  // Reproduced on main by the R1/R2 session: only the copy's first 512 characters were cut.
  const phrase = Array.from({ length: 120 }, (_, index) => 'word' + index.toString(36)).join('-');
  assert.ok(phrase.length > 512 && !/\s/u.test(phrase));
  const { session } = redactSession({ id: 'a'.repeat(64), provider: 'claude', source: 'x.jsonl', messages: [
    { role: 'user', line: 1, text: 'password=' + phrase },
    { role: 'assistant', line: 2, text: `copied ${phrase} here` },
  ] });
  assert.equal(session.messages[1].text, 'copied [REDACTED assigned-secret] here');
});
