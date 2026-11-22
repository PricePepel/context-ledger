import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import {
  createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify,
} from 'node:crypto';
import {
  appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync,
  symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { handoffMarkdown } from '../src/handoff.mjs';
import { redactSession, scannerName } from '../src/secrets.mjs';
import {
  canonicalJson, daclAllowsOnly, generateSigningKey, keyFingerprint, loadSigningKey, normalizeFingerprint, parseSavedAcl, verifyBundle,
  writeBundle,
} from '../src/sign.mjs';
import { openStore } from '../src/store.mjs';

const cp = (...points) => String.fromCodePoint(...points);
const BS = cp(92);
const u = hex => BS + 'u' + hex;
const transcript = [
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'Synthetic: ship the signed hand-off on Friday.' } }),
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'Synthetic: noted, Friday, with the verify command.' } }),
].join('\n');

// Import the synthetic transcript into a ledger database, as the server's import does.
function seedLedger(path) {
  const store = openStore(path);
  try {
    const { id } = store.importTranscript({ provider: 'claude', source: 'synthetic-p4a.jsonl', transcript });
    return store.get(id);
  } finally {
    store.close();
  }
}

const session = seedLedger(':memory:');
const sessionId = session.id;

function run(args, env = {}) {
  return new Promise(resolve => {
    execFile(process.execPath, ['src/cli.mjs', ...args], { env: { ...process.env, ...env } }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, stderr });
    });
  });
}

async function fakeLedger(t) {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/api/sessions/' + sessionId) {
      response.end(JSON.stringify({ session }));
      return;
    }
    response.statusCode = 404;
    response.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return String(server.address().port);
}

function tempFolder(t) {
  const folder = mkdtempSync(join(tmpdir(), 'ledger-p4a-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  return folder;
}

// One key, one seeded ledger database and one signed bundle per test, all in a temporary
// folder. --sign reads the database; the fake server on PORT only serves plain `handoff`.
async function signedBundle(t) {
  const folder = tempFolder(t);
  const database = join(folder, 'data', 'ledger.sqlite');
  const env = { CONTEXT_LEDGER_DB: database, PORT: await fakeLedger(t) };
  const keygen = await run(['keygen'], env);
  assert.equal(keygen.code, 0, keygen.stderr);
  seedLedger(database);
  const bundle = join(folder, 'bundle');
  const signed = await run(['handoff', sessionId, '--sign', bundle], env);
  assert.equal(signed.code, 0, signed.stderr);
  const privateKey = createPrivateKey(readFileSync(join(folder, 'data', 'signing-key.pem')));
  return { folder, database, env, bundle, fingerprint: keygen.stdout.trim(), privateKey };
}

let copies = 0;
function copyOf(context, change) {
  const target = join(context.folder, 'copy-' + (copies += 1));
  cpSync(context.bundle, target, { recursive: true });
  change?.(target);
  return target;
}

function flipByte(path, index) {
  const bytes = readFileSync(path);
  const at = index ?? Math.floor(bytes.length / 2);
  bytes[at] ^= 0x01;
  writeFileSync(path, bytes);
}

async function problemsOf(dir, options, hooks) {
  return (await verifyBundle(dir, options, hooks)).problems;
}

// --- RFC 8785 ---------------------------------------------------------------------

test('canonicalJson matches the RFC 8785 section 3.2.2 example', () => {
  const input = '{"numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],' +
    ' "string": "' + u('20ac') + '$' + u('000F') + u('000a') + "A'" + u('0042') + u('0022') + u('005c') +
    BS + BS + BS + '"' + BS + '/", "literals": [null, true, false]}';
  const expected = '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
    '"string":"' + cp(0x20ac) + '$' + u('000f') + BS + 'n' + "A'B" + BS + '"' + BS + BS + BS + BS + BS + '"' + '/"}';
  assert.equal(canonicalJson(JSON.parse(input)), expected);
});

test('canonicalJson sorts keys by UTF-16 code units (RFC 8785 section 3.2.3)', () => {
  const value = {
    [cp(0x20ac)]: 'Euro Sign',
    [cp(0x0d)]: 'Carriage Return',
    [cp(0xfb33)]: 'Hebrew Letter Dalet With Dagesh',
    1: 'One',
    [cp(0x1f600)]: 'Emoji: Grinning Face',
    [cp(0x80)]: 'Control',
    [cp(0xf6)]: 'Latin Small Letter O With Diaeresis',
  };
  const expected = '{"' + BS + 'r":"Carriage Return","1":"One","' + cp(0x80) + '":"Control","' + cp(0xf6) +
    '":"Latin Small Letter O With Diaeresis","' + cp(0x20ac) + '":"Euro Sign","' + cp(0x1f600) +
    '":"Emoji: Grinning Face","' + cp(0xfb33) + '":"Hebrew Letter Dalet With Dagesh"}';
  assert.equal(canonicalJson(value), expected);
});

test('canonicalJson numbers match the RFC 8785 Appendix B table', () => {
  const table = [
    ['0000000000000000', '0'], ['8000000000000000', '0'], ['0000000000000001', '5e-324'],
    ['8000000000000001', '-5e-324'], ['7fefffffffffffff', '1.7976931348623157e+308'],
    ['ffefffffffffffff', '-1.7976931348623157e+308'], ['4340000000000000', '9007199254740992'],
    ['c340000000000000', '-9007199254740992'], ['4430000000000000', '295147905179352830000'],
    ['44b52d02c7e14af5', '9.999999999999997e+22'], ['44b52d02c7e14af6', '1e+23'],
    ['44b52d02c7e14af7', '1.0000000000000001e+23'], ['444b1ae4d6e2ef4e', '999999999999999700000'],
    ['444b1ae4d6e2ef4f', '999999999999999900000'], ['444b1ae4d6e2ef50', '1e+21'],
    ['3eb0c6f7a0b5ed8c', '9.999999999999997e-7'], ['3eb0c6f7a0b5ed8d', '0.000001'],
    ['41b3de4355555553', '333333333.3333332'], ['41b3de4355555554', '333333333.33333325'],
    ['41b3de4355555555', '333333333.3333333'], ['41b3de4355555556', '333333333.3333334'],
    ['41b3de4355555557', '333333333.33333343'], ['becbf647612f3696', '-0.0000033333333333333333'],
    ['43143ff3c1cb0959', '1424953923781206.2'],
  ];
  const view = new DataView(new ArrayBuffer(8));
  for (const [bits, expected] of table) {
    view.setBigUint64(0, BigInt('0x' + bits));
    assert.equal(canonicalJson(view.getFloat64(0)), expected, bits);
  }
  for (const bits of ['7fffffffffffffff', '7ff0000000000000', 'fff0000000000000']) {
    view.setBigUint64(0, BigInt('0x' + bits));
    assert.throws(() => canonicalJson([view.getFloat64(0)]), TypeError, bits);
  }
});

test('canonicalJson keeps array order, nests objects and refuses values that are not JSON', () => {
  assert.equal(canonicalJson({ b: [3, { d: 1, c: [] }], a: {} }), '{"a":{},"b":[3,{"c":[],"d":1}]}');
  assert.equal(canonicalJson(cp(0x1f600)), '"' + cp(0x1f600) + '"');
  for (const bad of [undefined, () => 1, new Date(0), 1n, Symbol('s'), [undefined], { a: undefined },
    cp(0xd800), 'x' + cp(0xdfff), { [cp(0xdc00)]: 1 }, new Array(1)]) {
    assert.throws(() => canonicalJson(bad), TypeError);
  }
});

test('fingerprints accept spaces, colons or no separators in any case', () => {
  const hex = 'ab'.repeat(32);
  assert.equal(normalizeFingerprint(hex.toUpperCase().match(/../g).join(':')), hex);
  assert.equal(normalizeFingerprint(hex.match(/.{4}/g).join(' ')), hex);
  assert.throws(() => normalizeFingerprint(hex.slice(2)), /64 hex digits/);
  assert.throws(() => normalizeFingerprint(hex.slice(2) + 'zz'), /64 hex digits/);
});

// --- keygen -------------------------------------------------------------------------

test('keygen writes one Ed25519 key, prints only its fingerprint and never replaces it', async t => {
  const folder = tempFolder(t);
  const env = { CONTEXT_LEDGER_DB: join(folder, 'data', 'ledger.sqlite') };
  const first = await run(['keygen'], env);
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /^(?:[0-9a-f]{4} ){15}[0-9a-f]{4}\n$/);
  assert.equal(first.stderr, '');

  const keyPath = join(folder, 'data', 'signing-key.pem');
  const pem = readFileSync(keyPath);
  assert.match(pem.toString(), /^-----BEGIN PRIVATE KEY-----\n/);
  const privateKey = createPrivateKey(pem);
  assert.equal(privateKey.asymmetricKeyType, 'ed25519');
  assert.equal(first.stdout.trim(), keyFingerprint(createPublicKey(privateKey)));
  assert.deepEqual(readdirSync(join(folder, 'data')), ['signing-key.pem']);
  if (process.platform !== 'win32') assert.equal(statSync(keyPath).mode & 0o777, 0o600);

  const second = await run(['keygen'], env);
  assert.equal(second.code, 1);
  assert.equal(second.stdout, '');
  assert.match(second.stderr, /A signing key already exists\. It was not replaced\./);
  assert.ok(readFileSync(keyPath).equals(pem), 'the existing key is byte-identical');
});

test('keygen refuses an in-memory database location', async () => {
  const result = await run(['keygen'], { CONTEXT_LEDGER_DB: ':memory:' });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Set CONTEXT_LEDGER_DB to a file path/);
});

test('a signing key file other users can read is refused on POSIX', { skip: process.platform === 'win32' }, async t => {
  const folder = tempFolder(t);
  const env = { CONTEXT_LEDGER_DB: join(folder, 'ledger.sqlite') };
  assert.equal((await run(['keygen'], env)).code, 0);
  seedLedger(env.CONTEXT_LEDGER_DB);
  execFileSync('chmod', ['644', join(folder, 'signing-key.pem')]);
  const result = await run(['handoff', sessionId, '--sign', join(folder, 'bundle')], env);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Other users can read the signing key file/);
  assert.ok(!existsSync(join(folder, 'bundle')));
});

test('the default key file name is ignored by Git', () => {
  for (const path of ['signing-key.pem', 'data/signing-key.pem', '.context-ledger/signing-key.pem',
    'data/signing-key.pem.0123456789abcdef.tmp', 'data/signing-key.pem.a1B2c3/signing-key.pem.0123456789abcdef.tmp']) {
    const result = spawnSync('git', ['check-ignore', '-q', path]);
    if (result.error) return;
    assert.equal(result.status, 0, path);
  }
});

// --- handoff --sign -------------------------------------------------------------------

test('handoff --sign writes exactly the hand-off, the key, a canonical manifest and its signature', async t => {
  const context = await signedBundle(t);
  assert.deepEqual(readdirSync(context.bundle).sort(), ['handoff.md', 'manifest.json', 'manifest.sig', 'public-key.pem']);

  const plain = await run(['handoff', sessionId], context.env);
  assert.equal(plain.code, 0, plain.stderr);
  const markdown = readFileSync(join(context.bundle, 'handoff.md'));
  assert.equal(markdown.toString('utf8'), plain.stdout, 'the file holds what handoff prints');

  const manifestBytes = readFileSync(join(context.bundle, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  assert.equal(canonicalJson(manifest), manifestBytes.toString('utf8'));
  assert.ok(!manifestBytes.toString('utf8').endsWith('\n'));
  assert.deepEqual(Object.keys(manifest).sort(),
    ['algorithm', 'created_at', 'files', 'format', 'public_key', 'redaction', 'session', 'version']);
  assert.equal(manifest.format, 'context-ledger-signed-handoff');
  assert.equal(manifest.version, 2);
  // P4d: the synthetic session holds no secret, so nothing was replaced.
  assert.deepEqual(manifest.redaction, { scanner: 'context-ledger-secrets/1', findings: 0 });
  assert.equal(manifest.algorithm, 'Ed25519');
  assert.equal(manifest.session, sessionId);
  assert.match(manifest.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  const { createHash } = await import('node:crypto');
  assert.deepEqual(manifest.files, [{
    name: 'handoff.md', bytes: markdown.length, sha256: createHash('sha256').update(markdown).digest('hex'),
  }]);

  const publicKey = createPublicKey({ key: Buffer.from(manifest.public_key, 'base64'), format: 'der', type: 'spki' });
  assert.equal(keyFingerprint(publicKey), context.fingerprint);
  assert.equal(readFileSync(join(context.bundle, 'public-key.pem'), 'utf8'), publicKey.export({ type: 'spki', format: 'pem' }));
  const signature = readFileSync(join(context.bundle, 'manifest.sig'));
  assert.equal(signature.length, 64);
  assert.ok(edVerify(null, manifestBytes, publicKey, signature));
});

test('handoff --sign never writes into an existing folder and needs a key', async t => {
  const context = await signedBundle(t);
  const before = readdirSync(context.bundle).map(name => [name, readFileSync(join(context.bundle, name))]);
  const again = await run(['handoff', sessionId, '--sign', context.bundle], context.env);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /The output folder already exists/);
  for (const [name, bytes] of before) assert.ok(readFileSync(join(context.bundle, name)).equals(bytes), name);

  const empty = join(context.folder, 'empty');
  mkdirSync(empty);
  assert.equal((await run(['handoff', sessionId, '--sign', empty], context.env)).code, 1);
  assert.deepEqual(readdirSync(empty), []);

  const noKey = { ...context.env, CONTEXT_LEDGER_DB: join(context.folder, 'other', 'ledger.sqlite') };
  const missing = await run(['handoff', sessionId, '--sign', join(context.folder, 'unsigned')], noKey);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /No signing key\. Run npm run ledger -- keygen first\./);
  assert.ok(!existsSync(join(context.folder, 'unsigned')));

  for (const args of [['handoff', sessionId, '--sign'], ['handoff', sessionId, '--sign='],
    ['handoff', sessionId, '--sign', 'x', '--bogus' + cp(0x1b)]]) {
    const usage = await run(args, context.env);
    assert.equal(usage.code, 1, args.join(' '));
    assert.match(usage.stderr, /^Usage:/);
    assert.ok(!usage.stderr.includes(cp(0x1b)));
  }
});

// --- verify ---------------------------------------------------------------------------

test('verify passes an untouched bundle and checks the fingerprint in any separator style', async t => {
  const context = await signedBundle(t);
  const unchecked = await run(['verify', context.bundle]);
  assert.equal(unchecked.code, 0, unchecked.stderr);
  assert.match(unchecked.stdout, /^Verified: handoff\.md \(\d+ bytes\)\./);
  assert.ok(unchecked.stdout.includes('Key fingerprint: ' + context.fingerprint));
  assert.match(unchecked.stderr, /Warning: the key was not checked/);

  const hex = context.fingerprint.replace(/ /g, '');
  for (const fingerprint of [context.fingerprint, hex, hex.toUpperCase().match(/../g).join(':')]) {
    const checked = await run(['verify', context.bundle, '--fingerprint', fingerprint]);
    assert.equal(checked.code, 0, checked.stderr);
    assert.equal(checked.stderr, '');
  }

  const wrong = await run(['verify', context.bundle, '--fingerprint', 'f'.repeat(64)]);
  assert.equal(wrong.code, 1);
  assert.match(wrong.stderr, /signed by a different key than the fingerprint names/);
  assert.match(wrong.stderr, /Verification failed\./);
  assert.equal(wrong.stdout, '');
});

test('verify fails on any changed or appended byte', async t => {
  const context = await signedBundle(t);
  const markdownLength = readFileSync(join(context.bundle, 'handoff.md')).length;
  for (const index of [0, Math.floor(markdownLength / 2), markdownLength - 1]) {
    const dir = copyOf(context, target => flipByte(join(target, 'handoff.md'), index));
    assert.deepEqual(await problemsOf(dir), ['File changed: handoff.md'], 'byte ' + index);
  }
  const appended = copyOf(context, target => appendFileSync(join(target, 'handoff.md'), ' '));
  assert.deepEqual(await problemsOf(appended), ['File changed: handoff.md']);

  // A changed hash digit keeps the manifest canonical, so the signature catches it.
  const digit = copyOf(context, target => {
    const path = join(target, 'manifest.json');
    const text = readFileSync(path, 'utf8');
    const at = text.indexOf('"sha256":"') + 10;
    writeFileSync(path, text.slice(0, at) + (text[at] === '0' ? '1' : '0') + text.slice(at + 1));
  });
  assert.deepEqual(await problemsOf(digit), ['The signature does not match the manifest.']);
  const anyByte = copyOf(context, target => flipByte(join(target, 'manifest.json')));
  assert.equal((await problemsOf(anyByte)).length, 1);

  for (const index of [0, 31, 63]) {
    const dir = copyOf(context, target => flipByte(join(target, 'manifest.sig'), index));
    assert.deepEqual(await problemsOf(dir), ['The signature does not match the manifest.']);
  }
  const short = copyOf(context, target => {
    writeFileSync(join(target, 'manifest.sig'), readFileSync(join(target, 'manifest.sig')).subarray(0, 63));
  });
  assert.deepEqual(await problemsOf(short), ['The signature does not match the manifest.']);

  const cli = await run(['verify', copyOf(context, target => flipByte(join(target, 'handoff.md')))]);
  assert.equal(cli.code, 1);
  assert.match(cli.stderr, /^File changed: handoff\.md\nVerification failed\.\n$/);
});

test('verify fails on a missing file, an extra file or a subfolder', async t => {
  const context = await signedBundle(t);
  for (const name of ['handoff.md', 'manifest.json', 'manifest.sig', 'public-key.pem']) {
    const dir = copyOf(context, target => unlinkSync(join(target, name)));
    assert.deepEqual(await problemsOf(dir), ['Missing file: ' + name]);
  }
  const extra = copyOf(context, target => writeFileSync(join(target, 'notes.txt'), 'synthetic'));
  assert.deepEqual(await problemsOf(extra), ['Unexpected file: notes.txt']);
  const folder = copyOf(context, target => mkdirSync(join(target, 'more')));
  assert.deepEqual(await problemsOf(folder), ['Not a regular file: more']);
  const renamed = copyOf(context, target => {
    renameSync(join(target, 'handoff.md'), join(target, 'Handoff.md'));
  });
  assert.deepEqual((await problemsOf(renamed)).sort(), ['Missing file: handoff.md', 'Unexpected file: Handoff.md']);
  assert.equal((await run(['verify', join(context.folder, 'nowhere')])).code, 1);
});

test('verify fails on a wrong key unless only the embedded key is trusted', async t => {
  const context = await signedBundle(t);
  const other = generateKeyPairSync('ed25519');
  const resigned = copyOf(context, target => {
    const manifest = JSON.parse(readFileSync(join(target, 'manifest.json'), 'utf8'));
    manifest.public_key = other.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const bytes = Buffer.from(canonicalJson(manifest));
    writeFileSync(join(target, 'manifest.json'), bytes);
    writeFileSync(join(target, 'manifest.sig'), edSign(null, bytes, other.privateKey));
    writeFileSync(join(target, 'public-key.pem'), other.publicKey.export({ type: 'spki', format: 'pem' }));
  });
  // Without a pinned fingerprint the bundle is only self-consistent; that is why verify warns.
  assert.deepEqual(await problemsOf(resigned), []);
  assert.deepEqual(await problemsOf(resigned, { fingerprint: context.fingerprint }),
    ['The bundle was signed by a different key than the fingerprint names.']);

  const otherSignature = copyOf(context, target => {
    writeFileSync(join(target, 'manifest.sig'),
      edSign(null, readFileSync(join(target, 'manifest.json')), other.privateKey));
  });
  assert.deepEqual(await problemsOf(otherSignature), ['The signature does not match the manifest.']);

  const otherPem = copyOf(context, target => {
    writeFileSync(join(target, 'public-key.pem'), other.publicKey.export({ type: 'spki', format: 'pem' }));
  });
  assert.deepEqual(await problemsOf(otherPem), ['public-key.pem does not match the key in the manifest.']);
});

test('verify refuses a correctly signed manifest that is not canonical', async t => {
  const context = await signedBundle(t);
  const text = readFileSync(join(context.bundle, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(text);
  const reversed = Object.fromEntries(Object.entries(manifest).reverse());
  const variants = {
    whitespace: JSON.stringify(manifest, null, 2),
    unsorted: JSON.stringify(reversed),
    duplicate: '{"version":1,' + text.slice(1),
    'trailing newline': text + '\n',
    'byte-order mark': cp(0xfeff) + text,
    'needless escape': text.replace('"Ed25519"', '"Ed' + u('0032') + '5519"'),
  };
  for (const [label, variant] of Object.entries(variants)) {
    const dir = copyOf(context, target => {
      const bytes = Buffer.from(variant, 'utf8');
      writeFileSync(join(target, 'manifest.json'), bytes);
      writeFileSync(join(target, 'manifest.sig'), edSign(null, bytes, context.privateKey));
    });
    assert.deepEqual(await problemsOf(dir), ['The manifest is not canonical JSON (RFC 8785).'], label);
  }

  const shapes = {
    'extra key': { ...manifest, note: 'x' },
    'other version': { ...manifest, version: 3 },
    'version 1 with a redaction record': { ...manifest, version: 1 },
    'bad file name': { ...manifest, files: [{ ...manifest.files[0], name: '../handoff.md' }] },
    'envelope listed': { ...manifest, files: [...manifest.files, { ...manifest.files[0], name: 'manifest.sig' }] },
    'bad date': { ...manifest, created_at: '2026-02-30T00:00:00.000Z' },
  };
  // P4d review 6: the version 1 shape with a redaction record is refused by the CLI too.
  const mixedVersion = copyOf(context, target => {
    const bytes = Buffer.from(canonicalJson({ ...manifest, version: 1 }), 'utf8');
    writeFileSync(join(target, 'manifest.json'), bytes);
    writeFileSync(join(target, 'manifest.sig'), edSign(null, bytes, context.privateKey));
  });
  const refused = await run(['verify', mixedVersion]);
  assert.equal(refused.code, 1);
  assert.equal(refused.stdout, '');
  assert.match(refused.stderr, /^The manifest does not match the signed hand-off format\.\r?\nVerification failed\./);
  for (const [label, shape] of Object.entries(shapes)) {
    const dir = copyOf(context, target => {
      const bytes = Buffer.from(canonicalJson(shape), 'utf8');
      writeFileSync(join(target, 'manifest.json'), bytes);
      writeFileSync(join(target, 'manifest.sig'), edSign(null, bytes, context.privateKey));
    });
    assert.deepEqual(await problemsOf(dir), ['The manifest does not match the signed hand-off format.'], label);
  }
});

test('verify prints file names from the folder escaped', async t => {
  const context = await signedBundle(t);
  const hostile = ['note' + cp(0x202e) + 'dm.exe'];
  if (process.platform !== 'win32') hostile.push('bell' + cp(0x07) + cp(0x1b) + '[31m');
  const dir = copyOf(context, target => {
    for (const name of hostile) writeFileSync(join(target, name), 'synthetic');
  });
  const result = await run(['verify', dir]);
  assert.equal(result.code, 1);
  for (const point of [0x202e, 0x07, 0x1b]) {
    assert.ok(![...result.stderr].some(character => character.codePointAt(0) === point), 'raw U+' + point.toString(16));
  }
  assert.ok(result.stderr.includes('Unexpected file: note' + u('202e') + 'dm.exe'));
});

// --- OpenSSL-only recipe ----------------------------------------------------------------

const opensslMissing = (() => {
  const probe = spawnSync('openssl', ['version'], { encoding: 'utf8' });
  return probe.error || probe.status !== 0 ? 'openssl is not on PATH' : false;
})();

function recipeCommands() {
  const doc = readFileSync('docs/signed-handoff.md', 'utf8').replace(/\r\n/g, '\n');
  const block = doc.match(/<!-- openssl-recipe -->\n```sh\n([\s\S]*?)```/);
  assert.ok(block, 'the recipe block is marked in docs/signed-handoff.md');
  return block[1].split('\n').filter(line => line.startsWith('openssl '))
    .map(line => line.split(' | ').map(part => part.trim().split(/ +/)));
}

// Like sh -o pipefail: the pipeline fails if any stage fails.
function runPipeline(pipeline, cwd) {
  let input;
  let status = 0;
  for (const [program, ...args] of pipeline) {
    const result = spawnSync(program, args, { cwd, input });
    if (result.status !== 0) status = result.status ?? 1;
    input = result.stdout;
  }
  return { status, stdout: input.toString('utf8') };
}

test('the OpenSSL-only recipe in the docs accepts a bundle and refuses a changed manifest', { skip: opensslMissing }, async t => {
  const context = await signedBundle(t);
  const [fingerprintCommand, signatureCommand, hashCommand] = recipeCommands();
  assert.ok(hashCommand, 'three recipe commands');

  const fingerprint = runPipeline(fingerprintCommand, context.bundle);
  assert.equal(fingerprint.status, 0);
  assert.equal(fingerprint.stdout.match(/= ?([0-9a-f]{64})/)[1], normalizeFingerprint(context.fingerprint));

  const signature = runPipeline(signatureCommand, context.bundle);
  assert.equal(signature.status, 0, signature.stdout);
  assert.match(signature.stdout, /Signature Verified Successfully/);

  const manifest = JSON.parse(readFileSync(join(context.bundle, 'manifest.json'), 'utf8'));
  const hash = runPipeline(hashCommand, context.bundle);
  assert.equal(hash.status, 0);
  assert.equal(hash.stdout.match(/= ?([0-9a-f]{64})/)[1], manifest.files[0].sha256);

  const changed = copyOf(context, target => flipByte(join(target, 'manifest.json')));
  assert.notEqual(runPipeline(signatureCommand, changed).status, 0);
  const sig65 = copyOf(context, target => appendFileSync(join(target, 'manifest.sig'), Buffer.from([0])));
  assert.notEqual(runPipeline(signatureCommand, sig65).status, 0);

  // A changed hand-off still has a valid signature; only step 3 (hash against the
  // manifest) catches it, which is why the docs make that comparison a required step.
  const edited = copyOf(context, target => flipByte(join(target, 'handoff.md')));
  assert.equal(runPipeline(signatureCommand, edited).status, 0);
  assert.notEqual(runPipeline(hashCommand, edited).stdout.match(/= ?([0-9a-f]{64})/)[1], manifest.files[0].sha256);

  // A bundle re-signed by another key passes the signature step; only step 1 catches it.
  const other = generateKeyPairSync('ed25519');
  const resigned = copyOf(context, target => {
    const bytes = readFileSync(join(target, 'manifest.json'));
    writeFileSync(join(target, 'manifest.sig'), edSign(null, bytes, other.privateKey));
    writeFileSync(join(target, 'public-key.pem'), other.publicKey.export({ type: 'spki', format: 'pem' }));
  });
  assert.equal(runPipeline(signatureCommand, resigned).status, 0);
  assert.notEqual(runPipeline(fingerprintCommand, resigned).stdout.match(/= ?([0-9a-f]{64})/)[1],
    normalizeFingerprint(context.fingerprint));
});

test('the P4a files hold no raw control or format characters', () => {
  for (const path of ['src/sign.mjs', 'src/cli.mjs', 'tests/sign.test.mjs', 'docs/signed-handoff.md']) {
    const text = readFileSync(path, 'utf8');
    const hostile = [...text].filter(character => /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(character)
      && !['\t', '\n', '\r'].includes(character));
    assert.deepEqual(hostile, [], path);
  }
});

// --- Codex review, round 1 -------------------------------------------------------------

test('verify refuses a version 1 or 2 manifest without exactly one handoff.md', async t => {
  const context = await signedBundle(t);
  const signed = JSON.parse(readFileSync(join(context.bundle, 'manifest.json'), 'utf8'));
  const { redaction: _, ...asVersion1 } = signed;
  for (const manifest of [signed, { ...asVersion1, version: 1 }]) await refusesOtherFiles(context, manifest);
});

async function refusesOtherFiles(context, manifest) {
  const [entry] = manifest.files;
  const shapes = {
    'only notes.txt': [{ ...entry, name: 'notes.txt' }],
    'handoff.md and notes.txt': [entry, { ...entry, name: 'notes.txt' }],
    'handoff.md twice': [entry, entry],
    'no files': [],
  };
  for (const [label, files] of Object.entries(shapes)) {
    const dir = copyOf(context, target => {
      if (files.some(file => file.name === 'notes.txt')) {
        writeFileSync(join(target, 'notes.txt'), readFileSync(join(target, 'handoff.md')));
      }
      const bytes = Buffer.from(canonicalJson({ ...manifest, files }), 'utf8');
      writeFileSync(join(target, 'manifest.json'), bytes);
      writeFileSync(join(target, 'manifest.sig'), edSign(null, bytes, context.privateKey));
    });
    assert.deepEqual(await problemsOf(dir, { fingerprint: context.fingerprint }),
      ['The manifest does not match the signed hand-off format.'], `version ${manifest.version}: ${label}`);
  }
}

test('verify checks the size on its own, the exact PEM bytes and the exact signature length', async t => {
  const context = await signedBundle(t);
  const wrongSize = copyOf(context, target => {
    const manifest = JSON.parse(readFileSync(join(target, 'manifest.json'), 'utf8'));
    manifest.files[0].bytes += 1;
    const bytes = Buffer.from(canonicalJson(manifest), 'utf8');
    writeFileSync(join(target, 'manifest.json'), bytes);
    writeFileSync(join(target, 'manifest.sig'), edSign(null, bytes, context.privateKey));
  });
  assert.deepEqual(await problemsOf(wrongSize), ['File changed: handoff.md']);

  for (const [label, change] of [['trailing blank line', pem => pem + '\n'], ['CR LF', pem => pem.replace(/\n/g, '\r\n')]]) {
    const dir = copyOf(context, target => {
      const pemPath = join(target, 'public-key.pem');
      writeFileSync(pemPath, change(readFileSync(pemPath, 'utf8')));
    });
    assert.deepEqual(await problemsOf(dir), ['public-key.pem does not match the key in the manifest.'], label);
  }

  const long = copyOf(context, target => appendFileSync(join(target, 'manifest.sig'), Buffer.from([0])));
  assert.deepEqual(await problemsOf(long), ['The signature does not match the manifest.']);
});

test('verify refuses a symlink or a FIFO in place of a bundle file', async t => {
  const context = await signedBundle(t);
  const outside = join(context.folder, 'outside.md');
  writeFileSync(outside, readFileSync(join(context.bundle, 'handoff.md')));
  let linked;
  try {
    linked = copyOf(context, target => {
      unlinkSync(join(target, 'handoff.md'));
      symlinkSync(outside, join(target, 'handoff.md'));
    });
  } catch {
    linked = undefined; // Windows without the symlink privilege
  }
  if (linked) assert.deepEqual(await problemsOf(linked), ['Not a regular file: handoff.md']);

  if (process.platform !== 'win32') {
    const fifo = copyOf(context, target => {
      unlinkSync(join(target, 'manifest.sig'));
      execFileSync('mkfifo', [join(target, 'manifest.sig')]);
    });
    assert.deepEqual(await problemsOf(fifo), ['Not a regular file: manifest.sig']);
  }
});

test('a failed bundle write removes what it created', async t => {
  const folder = tempFolder(t);
  const outDir = join(folder, 'bundle');
  const files = [{ name: 'handoff.md', data: Buffer.from('synthetic') }, { name: 'bad' + cp(0) + 'name', data: Buffer.from('x') }];
  await assert.rejects(writeBundle(outDir, { files }), /Cannot write the bundle files\./);
  assert.ok(!existsSync(outDir));
});

test('keygen leaves no temporary file and a stale one does not block it', async t => {
  const folder = tempFolder(t);
  const data = join(folder, 'data');
  mkdirSync(data);
  writeFileSync(join(data, 'signing-key.pem.0123456789abcdef.tmp'), 'partial');
  const env = { CONTEXT_LEDGER_DB: join(data, 'ledger.sqlite') };
  const result = await run(['keygen'], env);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(readdirSync(data).sort(), ['signing-key.pem', 'signing-key.pem.0123456789abcdef.tmp']);
  assert.equal(createPrivateKey(readFileSync(join(data, 'signing-key.pem'))).asymmetricKeyType, 'ed25519');
});

test('terminal messages escape joiners in names and never quote parser or response text', async t => {
  const context = await signedBundle(t);
  const dir = copyOf(context, target => writeFileSync(join(target, 'a' + cp(0x200d) + 'b'), 'synthetic'));
  const result = await run(['verify', dir]);
  assert.equal(result.code, 1);
  assert.ok(result.stderr.includes('Unexpected file: a' + u('200d') + 'b'));
  assert.ok(!result.stderr.includes(cp(0x200d)));

  const usage = await run(['search', '--bogus' + cp(0x1b) + '[31m']);
  assert.equal(usage.code, 1);
  assert.match(usage.stderr, /^Usage:/);
  assert.ok(!usage.stderr.includes(cp(0x1b)));

  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end('{"session": ' + cp(0x1b) + '[31m oops');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const broken = await run(['handoff', sessionId], { PORT: String(server.address().port) });
  assert.equal(broken.code, 1);
  // The sentence main's CLI uses for any reply that is not JSON (P1d).
  assert.equal(broken.stderr, 'Context Ledger returned an unexpected response.\n');
});

// --- Codex review, round 2 -------------------------------------------------------------

test('verify and --sign resolve a symlink before .. in the folder path', { skip: process.platform === 'win32' }, async t => {
  const context = await signedBundle(t);
  // base/link points to base/other/sub, so the OS reads base/link/../bundle as base/other/bundle.
  const base = join(context.folder, 'base');
  mkdirSync(join(base, 'other', 'sub'), { recursive: true });
  cpSync(context.bundle, join(base, 'bundle'), { recursive: true });
  cpSync(context.bundle, join(base, 'other', 'bundle'), { recursive: true });
  flipByte(join(base, 'other', 'bundle', 'handoff.md'));
  symlinkSync(join(base, 'other', 'sub'), join(base, 'link'));
  const tricky = base + '/link/../bundle';
  assert.deepEqual(await problemsOf(tricky), ['File changed: handoff.md']);

  const signed = await run(['handoff', sessionId, '--sign', base + '/link/../fresh'], context.env);
  assert.equal(signed.code, 0, signed.stderr);
  assert.ok(existsSync(join(base, 'other', 'fresh', 'handoff.md')), 'written where the OS resolves the path');
  assert.ok(!existsSync(join(base, 'fresh')));
  assert.deepEqual(await problemsOf(join(base, 'other', 'fresh')), []);
});

test('verify notices a folder that changes after it is listed or read', async t => {
  const context = await signedBundle(t);
  const changed = ['The bundle folder changed while it was being verified.'];
  const added = copyOf(context);
  assert.deepEqual(await problemsOf(added, {}, {
    afterList: dir => writeFileSync(join(dir, 'late.txt'), 'synthetic'),
  }), changed);

  const replaced = copyOf(context);
  assert.deepEqual(await problemsOf(replaced, {}, {
    afterRead: dir => {
      // Move the original aside (outside the folder) first, so its inode cannot be reused.
      const bytes = readFileSync(join(dir, 'handoff.md'));
      renameSync(join(dir, 'handoff.md'), join(context.folder, 'aside-handoff.md'));
      writeFileSync(join(dir, 'handoff.md'), bytes);
    },
  }), changed, 'a new file with the same bytes is still a different file');

  const edited = copyOf(context);
  assert.deepEqual(await problemsOf(edited, {}, {
    afterRead: dir => flipByte(join(dir, 'handoff.md')),
  }), changed);

  const untouched = copyOf(context);
  assert.deepEqual(await problemsOf(untouched, {}, { afterList: () => {}, afterRead: () => {} }), []);

  if (process.platform !== 'win32') {
    const outside = join(context.folder, 'outside.md');
    writeFileSync(outside, readFileSync(join(context.bundle, 'handoff.md')));
    const linked = copyOf(context);
    assert.deepEqual(await problemsOf(linked, {}, {
      afterList: dir => {
        unlinkSync(join(dir, 'handoff.md'));
        symlinkSync(outside, join(dir, 'handoff.md'));
      },
    }), ['File changed: handoff.md'], 'O_NOFOLLOW refuses a symlink swapped in after listing');

    const fifo = copyOf(context);
    assert.deepEqual(await problemsOf(fifo, {}, {
      afterList: dir => {
        unlinkSync(join(dir, 'manifest.sig'));
        execFileSync('mkfifo', [join(dir, 'manifest.sig')]);
      },
    }), ['Cannot read the bundle files.'], 'O_NONBLOCK keeps a FIFO swapped in from blocking');
  }
});

test('an inflated hand-off is refused on its size', async t => {
  const context = await signedBundle(t);
  const inflated = copyOf(context, target => appendFileSync(join(target, 'handoff.md'), Buffer.alloc(4 * 1024 * 1024)));
  assert.deepEqual(await problemsOf(inflated), ['File changed: handoff.md']);
});

test('without pipefail, a missing PEM gives the empty-input hash, which no fingerprint matches', { skip: opensslMissing }, async t => {
  const context = await signedBundle(t);
  const [fingerprintCommand] = recipeCommands();
  const missing = copyOf(context, target => unlinkSync(join(target, 'public-key.pem')));
  const result = runPipeline(fingerprintCommand, missing);
  const printed = result.stdout.match(/= ?([0-9a-f]{64})/)[1];
  assert.equal(printed, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.notEqual(printed, normalizeFingerprint(context.fingerprint));
});

// --- Security review of PR #44 ----------------------------------------------------------

const onWindows = process.platform === 'win32';
const system32 = name => join(process.env.SystemRoot ?? 'C:' + BS + 'Windows', 'System32', name);
const icacls = (...args) => execFileSync(system32('icacls.exe'), args, { stdio: 'ignore', windowsHide: true });
const everyone = 'S-1-1-0';
const users = 'S-1-5-32-545';

function windowsSid() {
  const output = execFileSync(system32('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { windowsHide: true });
  return /"(S-1-[0-9-]+)"\s*$/.exec(output.toString('latin1'))[1];
}

// How SDDL spells this account ("LA" for the built-in Administrator on CI runners, P5a),
// read with PowerShell, independently of src/sign.mjs.
function windowsSpelling() {
  const script = '$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; ' +
    "(New-Object System.Security.AccessControl.RawSecurityDescriptor ('O:' + $sid)).GetSddlForm('Owner').Substring(2)";
  return execFileSync(system32(join('WindowsPowerShell', 'v1.0', 'powershell.exe')),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, encoding: 'utf8' }).trim();
}

// The DACL of a file in SDDL form, read independently of src/sign.mjs.
function savedDacl(t, path) {
  const out = join(tempFolder(t), 'acl');
  icacls(path, '/save', out);
  return readFileSync(out).toString('utf16le').split(/\r?\n/)[1];
}

test('daclAllowsOnly accepts only this account, SYSTEM and Administrators', () => {
  const me = 'S-1-5-21-1-2-3-1001';
  const ace = (sid, type = 'A', flags = '') => '(' + type + ';' + flags + ';FA;;;' + sid + ')';
  assert.equal(daclAllowsOnly('D:PAI' + ace(me), me), true);
  assert.equal(daclAllowsOnly('D:AI' + ace('SY', 'A', 'ID') + ace('BA', 'A', 'ID') + ace(me, 'A', 'ID'), me), true);
  assert.equal(daclAllowsOnly('D:P' + ace('S-1-5-18') + ace('S-1-5-32-544') + ace(me), me), true);
  assert.equal(daclAllowsOnly('D:P' + ace('WD', 'D') + ace(me), me), true, 'a deny entry grants nothing');
  assert.equal(daclAllowsOnly('D:P', me), true, 'an empty DACL grants nothing');
  for (const other of ['WD', 'BU', 'AU', 'IU', 'OW', 'CO', everyone, users, 'S-1-5-21-1-2-3-1002']) {
    assert.equal(daclAllowsOnly('D:PAI' + ace(me) + ace(other), me), false, other);
    assert.equal(daclAllowsOnly('D:AI' + ace(other, 'A', 'ID') + ace(me, 'A', 'ID'), me), false, other);
  }
  for (const odd of ['', 'D:NO_ACCESS_CONTROL', 'O:BAG:SYD:PAI' + ace(me), 'D:PAI' + ace(me) + 'S:AI',
    'D:PAI(A;;FA;;' + me + ')', 'D:PAI(XA;;FA;;;' + me + ';(@User.x == 1))', 'D:PAI' + ace(me) + ' ']) {
    assert.equal(daclAllowsOnly(odd, me), false, odd);
  }
  // P5a: the built-in Administrator (RID 500, GitHub's Windows runner account) is spelt LA.
  const admin = 'S-1-5-21-1-2-3-500';
  assert.equal(daclAllowsOnly('D:PAI' + ace('LA'), admin, 'LA'), true);
  assert.equal(daclAllowsOnly('D:PAI' + ace('LA') + ace(admin), admin, 'LA'), true, 'either spelling');
  assert.equal(daclAllowsOnly('D:PAI' + ace('LA'), admin), false, 'no alias given');
  assert.equal(daclAllowsOnly('D:PAI' + ace('LA'), me, me), false, 'another account named LA');
  assert.equal(daclAllowsOnly('D:PAI' + ace('LA') + ace('WD'), admin, 'LA'), false, 'Everyone too');
  for (const alias of ['la', 'LAX', 'S-1-1-0', '', null]) {
    assert.equal(daclAllowsOnly('D:PAI' + ace('LA'), admin, alias), false, String(alias));
  }
});

test('keygen restricts the key to this account on Windows, even in a folder others can read', { skip: !onWindows }, async t => {
  const folder = tempFolder(t);
  const data = join(folder, 'data');
  mkdirSync(data);
  // The review's scenario: a ledger folder whose inherited access list lets other accounts read.
  icacls(data, '/grant', '*' + everyone + ':(OI)(CI)R', '*' + users + ':(OI)(CI)R');
  assert.match(savedDacl(t, data), /;;;WD\)/);
  const env = { CONTEXT_LEDGER_DB: join(data, 'ledger.sqlite') };
  const keygen = await run(['keygen'], env);
  assert.equal(keygen.code, 0, keygen.stderr);
  const keyPath = join(data, 'signing-key.pem');
  assert.equal(savedDacl(t, keyPath), 'D:PAI(A;;FA;;;' + windowsSpelling() + ')');
  assert.deepEqual(readdirSync(data), ['signing-key.pem'], 'no staging file is left');

  seedLedger(env.CONTEXT_LEDGER_DB);
  const signed = await run(['handoff', sessionId, '--sign', join(folder, 'bundle')], env);
  assert.equal(signed.code, 0, signed.stderr);
});

test('a signing key file other accounts can read is refused on Windows', { skip: !onWindows }, async t => {
  const folder = tempFolder(t);
  const env = { CONTEXT_LEDGER_DB: join(folder, 'ledger.sqlite') };
  assert.equal((await run(['keygen'], env)).code, 0);
  seedLedger(env.CONTEXT_LEDGER_DB);
  const keyPath = join(folder, 'signing-key.pem');
  let attempt = 0;
  const sign = () => run(['handoff', sessionId, '--sign', join(folder, 'bundle-' + (attempt += 1))], env);
  const refused = async label => {
    const result = await sign();
    assert.equal(result.code, 1, label);
    assert.match(result.stderr, /Other accounts can read the signing key file\. Restrict it to your account with icacls/, label);
    assert.ok(!existsSync(join(folder, 'bundle-' + attempt)), label);
  };

  icacls(keyPath, '/grant', '*' + everyone + ':R');
  await refused('Everyone');
  icacls(keyPath, '/remove:g', '*' + everyone);
  icacls(keyPath, '/grant', '*' + users + ':R');
  await refused('Users');
  icacls(keyPath, '/remove:g', '*' + users);

  // Inheritance switched back on, under a folder that grants Everyone read.
  icacls(folder, '/grant', '*' + everyone + ':(OI)(CI)R');
  icacls(keyPath, '/inheritance:e');
  await refused('inherited from the folder');
  icacls(keyPath, '/inheritance:r');

  const accepted = await sign();
  assert.equal(accepted.code, 0, accepted.stderr);
  assert.equal(savedDacl(t, keyPath), 'D:PAI(A;;FA;;;' + windowsSpelling() + ')');
});

test('handoff --sign reads the ledger database and never contacts PORT', async t => {
  const folder = tempFolder(t);
  const database = join(folder, 'data', 'ledger.sqlite');
  const env = { CONTEXT_LEDGER_DB: database };
  const keygen = await run(['keygen'], env);
  assert.equal(keygen.code, 0, keygen.stderr);
  seedLedger(database);

  // Whatever answers on PORT (here a forged session with the right ID) is never asked.
  let requests = 0;
  const forged = { ...session, messages: [{ role: 'user', line: 1, text: 'Synthetic forgery from PORT.' }] };
  const server = createServer((request, response) => {
    requests += 1;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ session: forged }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));

  const bundle = join(folder, 'bundle');
  const signed = await run(['handoff', sessionId, '--sign', bundle], { ...env, PORT: String(server.address().port) });
  assert.equal(signed.code, 0, signed.stderr);
  assert.equal(requests, 0, 'the server on PORT was not contacted');
  const markdown = readFileSync(join(bundle, 'handoff.md'), 'utf8');
  assert.equal(markdown, handoffMarkdown(session) + '\n');
  assert.ok(!markdown.includes('forgery'));
  assert.deepEqual(await problemsOf(bundle, { fingerprint: keygen.stdout.trim() }), []);

  // No server at all, and a PORT that is not even a port number.
  const offline = await run(['handoff', sessionId, '--sign', join(folder, 'offline')], { ...env, PORT: 'none' });
  assert.equal(offline.code, 0, offline.stderr);
  assert.equal(readFileSync(join(folder, 'offline', 'handoff.md'), 'utf8'), markdown);
});

test('handoff --sign needs the ledger database and the session in it, and says so in fixed words', async t => {
  const folder = tempFolder(t);
  const database = join(folder, 'ledger.sqlite');
  const env = { CONTEXT_LEDGER_DB: database };
  assert.equal((await run(['keygen'], env)).code, 0);

  const noDatabase = await run(['handoff', sessionId, '--sign', join(folder, 'a')], env);
  assert.equal(noDatabase.code, 1);
  assert.equal(noDatabase.stderr, 'No ledger database. Import a session first, or set CONTEXT_LEDGER_DB.\n');
  assert.ok(!existsSync(database), 'no empty database is created');
  assert.ok(!existsSync(join(folder, 'a')));

  writeFileSync(database, 'Synthetic: not a database. ' + cp(0x1b) + '[31m');
  const broken = await run(['handoff', sessionId, '--sign', join(folder, 'b')], env);
  assert.equal(broken.code, 1);
  assert.match(broken.stderr, /^Cannot open the ledger database\.$/m);
  assert.ok(!broken.stderr.includes(cp(0x1b)));
  assert.ok(!existsSync(join(folder, 'b')));

  rmSync(database);
  seedLedger(database);
  const unknown = await run(['handoff', 'b'.repeat(64), '--sign', join(folder, 'c')], env);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /^Session not found\.$/m);
  assert.ok(!existsSync(join(folder, 'c')));
});

// --- Codex review of the security fixes (67d91fc) ---------------------------------------

// Every SID an allow entry names, parsed here rather than with src/sign.mjs.
const allowedSids = sddl => [...sddl.matchAll(/\(A;[^;]*;[^;]*;[^;]*;[^;]*;([^;)]*)\)/g)].map(match => match[1]);
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');

test('daclAllowsOnly refuses entry types and flags it does not know', () => {
  const me = 'S-1-5-21-1-2-3-1001';
  for (const type of ['OA', 'XA', 'ZA', 'AU', 'AL', 'ML', 'SP', 'XU']) {
    assert.equal(daclAllowsOnly('D:PAI(' + type + ';;FA;;;' + me + ')', me), false, type);
  }
  for (const flags of ['PX', 'PAIZ', 'NO_ACCESS_CONTROL', 'AI_', 'p']) {
    assert.equal(daclAllowsOnly('D:' + flags + '(A;;FA;;;' + me + ')', me), false, flags);
  }
  assert.equal(daclAllowsOnly('D:PAI(A;;FA;;;' + me + ';(x))', me), false, 'a seventh field');
  assert.equal(daclAllowsOnly('D:PAR(A;OICI;FA;;;' + me + ')', me), true);
});

test('keygen on Windows never lets the staging file inherit the data folder\'s list', { skip: !onWindows }, async t => {
  const folder = tempFolder(t);
  const data = join(folder, 'data');
  mkdirSync(data);
  icacls(data, '/grant', '*' + everyone + ':(OI)(CI)R', '*' + users + ':(OI)(CI)R');
  const sid = windowsSpelling(); // as SDDL writes this account (P5a)
  const seen = {};
  await generateSigningKey(join(data, 'signing-key.pem'), {
    afterCreate: staging => {
      seen.parent = dirname(staging);
      seen.file = savedDacl(t, staging);
      seen.folder = savedDacl(t, seen.parent);
    },
  });
  assert.notEqual(seen.parent, data, 'the staging file is not created in the data folder itself');
  assert.equal(dirname(seen.parent), data, 'but beside the key, on the same volume');
  assert.ok(allowedSids(seen.file).length > 0, seen.file);
  assert.deepEqual([...new Set(allowedSids(seen.file))], [sid], 'the empty staging file grants this account only');
  assert.deepEqual(allowedSids(seen.folder), [sid], 'its folder grants this account only');
  assert.deepEqual(readdirSync(data), ['signing-key.pem'], 'the staging folder is removed');
  assert.equal(savedDacl(t, join(data, 'signing-key.pem')), 'D:PAI(A;;FA;;;' + sid + ')');
});

test('the Windows key check refuses a key file replaced between the read and the check', { skip: !onWindows }, async t => {
  const folder = tempFolder(t);
  const keyPath = join(folder, 'signing-key.pem');
  await generateSigningKey(keyPath);
  // The real key is readable by Everyone; a restricted stand-in is put in its place.
  icacls(keyPath, '/grant', '*' + everyone + ':R');
  await assert.rejects(loadSigningKey(keyPath), /Other accounts can read the signing key file\./);
  const swap = () => {
    renameSync(keyPath, join(folder, 'aside.pem'));
    writeFileSync(keyPath, 'Synthetic stand-in.');
    icacls(keyPath, '/inheritance:r', '/grant:r', '*' + windowsSid() + ':F');
  };
  await assert.rejects(loadSigningKey(keyPath, { beforeAclCheck: swap }),
    /^Error: The signing key file changed while it was being checked\.$/);
});

test('handoff --sign leaves the ledger database unchanged, and refuses an older schema', async t => {
  const folder = tempFolder(t);
  const database = join(folder, 'ledger.sqlite');
  const env = { CONTEXT_LEDGER_DB: database };
  assert.equal((await run(['keygen'], env)).code, 0);
  seedLedger(database);

  const current = sha256(database);
  assert.equal((await run(['handoff', sessionId, '--sign', join(folder, 'a')], env)).code, 0);
  assert.equal((await run(['handoff', 'b'.repeat(64), '--sign', join(folder, 'b')], env)).code, 1);
  assert.equal(sha256(database), current, 'signing and a failed lookup write nothing');

  // A version 0 file, as a build before schema versions wrote it.
  const older = new DatabaseSync(database);
  older.exec('PRAGMA user_version = 0');
  older.close();
  const before = sha256(database);
  const refused = await run(['handoff', sessionId, '--sign', join(folder, 'c')], env);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /^This ledger database has an older schema\. Start Context Ledger once with npm start/m);
  assert.ok(!existsSync(join(folder, 'c')));
  assert.equal(sha256(database), before, 'the older file is not migrated');

  const newer = new DatabaseSync(database);
  newer.exec('PRAGMA user_version = 99');
  newer.close();
  const ahead = await run(['handoff', sessionId, '--sign', join(folder, 'd')], env);
  assert.equal(ahead.code, 1);
  assert.match(ahead.stderr, /^This ledger database was written by a newer Context Ledger \(schema 99\)\./m);
});

test('handoff --sign does not create the target of a dangling database symlink', { skip: onWindows }, async t => {
  const folder = tempFolder(t);
  const target = join(folder, 'missing', 'ledger.sqlite');
  mkdirSync(dirname(target));
  const database = join(folder, 'ledger.sqlite');
  symlinkSync(target, database);
  const env = { CONTEXT_LEDGER_DB: database };
  assert.equal((await run(['keygen'], env)).code, 0);
  const result = await run(['handoff', sessionId, '--sign', join(folder, 'bundle')], env);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /^Cannot open the ledger database\.$/m);
  assert.ok(!existsSync(target));
});

test('P5a review: an icacls /save record is read only when it is one record for the expected file', () => {
  const bom = String.fromCharCode(0xfeff);
  const crlf = String.fromCharCode(13, 10);
  const dacl = 'D:PAI(A;;FA;;;S-1-5-21-1-2-3-1001)';
  assert.equal(parseSavedAcl(bom + 'signing-key.pem' + crlf + dacl + crlf, 'signing-key.pem'), dacl);
  for (const text of [
    'other.pem' + crlf + dacl + crlf, // another file's record
    'Signing-Key.PEM' + crlf + dacl + crlf, // the name exactly as asked for, not case-folded
    'signing-key.pem' + crlf + dacl + crlf + 'other.pem' + crlf + 'D:PAI(A;;FA;;;WD)' + crlf, // extra records
    'signing-key.pem' + crlf, // no DACL line
    dacl + crlf, // no name line
    '',
  ]) {
    assert.equal(parseSavedAcl(text, 'signing-key.pem'), '', JSON.stringify(text));
  }
});

// --- P4d: the signed hand-off is the redacted one ------------------------------------

// Fake credentials put together from fragments, as in tests/secrets.test.mjs, so no
// committed file holds a whole string in a real credential format. None is real.
const fakeSecret = {
  aws: ['AK', 'IA', 'Q3XZ7W2M9KD4PL6N'].join(''),
  github: ['gh', 'p_', 'Ab3D'.repeat(9)].join(''),
  password: ['Zx9q', 'Wm3v', 'Lt7p', 'Rk2s'].join(''),
  sourceToken: ['gh', 'o_', 'Qw8E'.repeat(9)].join(''),
};
const secretTranscript = [
  JSON.stringify({ type: 'user', message: { role: 'user', content: `Synthetic: deploy with ${fakeSecret.aws} and password=${fakeSecret.password} today.` } }),
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: `Synthetic: pushing with ${fakeSecret.github}.` } }),
  // A bare copy of the password, with no name before it (P4d review, round 1).
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: `Synthetic: saved ${fakeSecret.password} to the vault.` } }),
].join('\n');
const secretSource = `synthetic-p4d-${fakeSecret.sourceToken}.jsonl`;

function seedSecrets(path) {
  const store = openStore(path);
  try {
    const { id } = store.importTranscript({ provider: 'claude', source: secretSource, transcript: secretTranscript });
    return store.get(id);
  } finally {
    store.close();
  }
}

// A stand-in for the ledger on PORT that serves the given sessions, for `redact`.
async function servingLedger(t, sessions) {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    const found = sessions.find(entry => request.url === '/api/sessions/' + entry.id);
    response.statusCode = found ? 200 : 404;
    response.end(JSON.stringify(found ? { session: found } : {}));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return String(server.address().port);
}

async function secretBundle(t) {
  const context = await signedBundle(t);
  const secret = seedSecrets(context.database);
  const bundle = join(context.folder, 'secret-bundle');
  const signed = await run(['handoff', secret.id, '--sign', bundle], context.env);
  assert.equal(signed.code, 0, signed.stderr);
  return { ...context, secret, secretDir: bundle, signed };
}

// Every 12-character piece of every fake value, so a partly kept value is caught too.
function pieces() {
  return Object.values(fakeSecret).flatMap(value =>
    Array.from({ length: value.length - 11 }, (_, index) => value.slice(index, index + 12)));
}

function assertNoSecret(text, label) {
  for (const piece of pieces()) assert.ok(!text.includes(piece), `${label} holds part of a fake secret`);
}

test('P4d: handoff --sign signs the redacted hand-off and records the count', async t => {
  const context = await secretBundle(t);
  const { session: redacted, findings } = redactSession(context.secret);
  assert.equal(findings.length, 5, 'four fake values, one of them pasted twice');
  const markdown = readFileSync(join(context.secretDir, 'handoff.md'), 'utf8');
  assert.equal(markdown, handoffMarkdown(redacted) + '\n');
  for (const kind of ['aws-access-key-id', 'github-token', 'assigned-secret']) {
    assert.ok(markdown.includes(`[REDACTED ${kind}]`), kind);
  }
  for (const name of readdirSync(context.secretDir)) {
    assertNoSecret(readFileSync(join(context.secretDir, name)).toString('latin1'), name);
  }

  const manifest = JSON.parse(readFileSync(join(context.secretDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, 2);
  assert.deepEqual(manifest.redaction, { scanner: scannerName, findings: 5 });
  // The count is the one the redaction report gives for the same session.
  const port = await servingLedger(t, [context.secret]);
  const report = await run(['redact', context.secret.id, '--json'], { ...context.env, PORT: port });
  assert.equal(report.code, 0, report.stderr);
  assert.equal(JSON.parse(report.stdout).count, manifest.redaction.findings);

  // The sender sees counts and where to look, never a value.
  assert.ok(context.signed.stdout.includes('Redacted: 5 possible secrets in 3 transcript lines and the source name, ' +
    `each replaced by [REDACTED <kind>]. Run npm run ledger -- redact ${context.secret.id} to see where.`), context.signed.stdout);
  assertNoSecret(context.signed.stdout + context.signed.stderr, 'the --sign output');
  // Not even a masked preview: the summary has counts only.
  for (const prefix of ['AKIA', 'ghp_', 'gho_', 'Zx9q']) assert.ok(!context.signed.stdout.includes(prefix), prefix);

  const checked = await run(['verify', context.secretDir, '--fingerprint', context.fingerprint]);
  assert.equal(checked.code, 0, checked.stderr);
  assert.ok(checked.stdout.includes('Redaction: 5 replacements, by context-ledger-secrets/1'), checked.stdout);
  assert.equal(checked.stderr, '');
  assertNoSecret(checked.stdout, 'the verify output');
});

test('P4d: a clean session is signed unchanged and says the checks found nothing', async t => {
  const context = await signedBundle(t);
  const again = join(context.folder, 'again');
  const signed = await run(['handoff', sessionId, '--sign', again], context.env);
  assert.equal(signed.code, 0, signed.stderr);
  assert.match(signed.stdout, /Redacted: nothing; the secret checks found no value\. They cannot find every secret/);
  const plain = await run(['handoff', sessionId], context.env);
  assert.equal(readFileSync(join(again, 'handoff.md'), 'utf8'), plain.stdout);
  const checked = await run(['verify', again, '--fingerprint', context.fingerprint]);
  assert.equal(checked.code, 0, checked.stderr);
  assert.ok(checked.stdout.includes('Redaction: 0 replacements, by context-ledger-secrets/1'), checked.stdout);
});

test('P4d: there is no option to sign without redaction', async t => {
  const context = await signedBundle(t);
  for (const flag of ['--no-redact', '--redact=false', '--unredacted', '--raw']) {
    const target = join(context.folder, 'flag' + flag.replace(/[^a-z]/g, ''));
    const usage = await run(['handoff', sessionId, '--sign', target, flag], context.env);
    assert.equal(usage.code, 1, flag);
    assert.match(usage.stderr, /^Usage:/, flag);
    assert.ok(!existsSync(target), flag);
  }
});

test('P4d: verify refuses a version 2 manifest whose redaction record is not exact', async t => {
  const context = await signedBundle(t);
  const manifest = JSON.parse(readFileSync(join(context.bundle, 'manifest.json'), 'utf8'));
  const { redaction } = manifest;
  const shapes = {
    'no redaction': (({ redaction: _, ...rest }) => rest)(manifest),
    'redaction null': { ...manifest, redaction: null },
    'redaction a list': { ...manifest, redaction: [redaction] },
    'extra key': { ...manifest, redaction: { ...redaction, kinds: {} } },
    'missing count': { ...manifest, redaction: { scanner: redaction.scanner } },
    'other scanner': { ...manifest, redaction: { ...redaction, scanner: 'context-ledger-secrets/2' } },
    'negative count': { ...manifest, redaction: { ...redaction, findings: -1 } },
    'fractional count': { ...manifest, redaction: { ...redaction, findings: 1.5 } },
    'count as text': { ...manifest, redaction: { ...redaction, findings: '0' } },
    'unsafe count': { ...manifest, redaction: { ...redaction, findings: 2 ** 53 } },
  };
  for (const [label, shape] of Object.entries(shapes)) {
    const dir = copyOf(context, target => {
      const bytes = Buffer.from(canonicalJson(shape), 'utf8');
      writeFileSync(join(target, 'manifest.json'), bytes);
      writeFileSync(join(target, 'manifest.sig'), edSign(null, bytes, context.privateKey));
    });
    assert.deepEqual(await problemsOf(dir, { fingerprint: context.fingerprint }),
      ['The manifest does not match the signed hand-off format.'], label);
    {
      const cli = await run(['verify', dir, '--fingerprint', context.fingerprint]);
      assert.equal(cli.code, 1);
      assert.equal(cli.stdout, '');
      assert.match(cli.stderr, /^The manifest does not match the signed hand-off format\.\r?\nVerification failed\./);
    }
  }
  // A changed count under the old signature is a broken signature.
  const recount = copyOf(context, target => {
    writeFileSync(join(target, 'manifest.json'), Buffer.from(canonicalJson({ ...manifest, redaction: { ...redaction, findings: 1 } }), 'utf8'));
  });
  assert.deepEqual(await problemsOf(recount, { fingerprint: context.fingerprint }), ['The signature does not match the manifest.']);
});

test('P4d: a version 1 bundle from P4a still verifies, with a warning that it was not redacted', async t => {
  const context = await secretBundle(t);
  // The P4a shape: version 1, no redaction record, and the hand-off as it was, secrets and all.
  const markdown = Buffer.from(handoffMarkdown(context.secret) + '\n', 'utf8');
  assert.ok(markdown.toString('utf8').includes(fakeSecret.password));
  const manifest = JSON.parse(readFileSync(join(context.secretDir, 'manifest.json'), 'utf8'));
  const { redaction: _, ...rest } = manifest;
  const dir = join(context.folder, 'p4a-bundle');
  cpSync(context.secretDir, dir, { recursive: true });
  writeFileSync(join(dir, 'handoff.md'), markdown);
  const bytes = Buffer.from(canonicalJson({
    ...rest, version: 1, files: [{ name: 'handoff.md', bytes: markdown.length, sha256: createHash('sha256').update(markdown).digest('hex') }],
  }), 'utf8');
  writeFileSync(join(dir, 'manifest.json'), bytes);
  writeFileSync(join(dir, 'manifest.sig'), edSign(null, bytes, context.privateKey));
  const result = await verifyBundle(dir, { fingerprint: context.fingerprint });
  assert.deepEqual(result.problems, []);
  assert.equal(result.version, 1);
  assert.equal(result.redaction, null);
  const checked = await run(['verify', dir, '--fingerprint', context.fingerprint]);
  assert.equal(checked.code, 0, checked.stderr);
  assert.ok(checked.stdout.includes('Redaction: not recorded (a version 1 bundle)'), checked.stdout);
  assert.match(checked.stderr, /^Warning: this bundle was signed before hand-offs were redacted\. Its hand-off was not checked for secrets/);
});
