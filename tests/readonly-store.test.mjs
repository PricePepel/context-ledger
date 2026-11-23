// Card P3c: openStore's read-only mode, used by signing and `reviews verify`, never
// creates, migrates or writes the ledger. Synthetic transcripts and names only.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { refuseNewerSchema, schemaVersion } from '../src/migrate.mjs';
import { openStore } from '../src/store.mjs';

const uuid = n => `0000000${n}-aaaa-4bbb-8ccc-00000000000${n}`;
const transcript = [['user', 'Ines: the cache lives for ten minutes.'], ['assistant', 'Noted: ten minutes.']]
  .map(([role, text], index) => JSON.stringify({ type: role, uuid: uuid(index + 1), message: { role, content: text } })).join('\n');

function run(args, env, preload = []) {
  return new Promise(resolve => {
    execFile(process.execPath, [...preload, 'src/cli.mjs', ...args], { env: { ...process.env, ...env } }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, stderr });
    });
  });
}

/** A ledger with one session and one approved node; the folder is removed after the test. */
function ledger(t) {
  const folder = mkdtempSync(join(tmpdir(), 'ledger-p3c-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const database = join(folder, 'data', 'ledger.sqlite');
  const store = openStore(database);
  const session = store.importTranscript({ provider: 'claude', source: 'ines.jsonl', transcript });
  const graph = store.publishGraph({ version: 3, sessionId: session.id, party: 'ines', edges: [],
    nodes: [{ id: 'cache', kind: 'decision', label: 'Ten-minute cache', evidence: [{ message: `u:${uuid(1)}` }] }] });
  store.reviewNode(graph.id, { nodeId: 'cache', nodeSha256: graph.nodeHashes[0].sha256, decision: 'approve', reviewer: 'Ines' });
  store.close();
  return { folder, database, sessionId: session.id, graphId: graph.id, env: { CONTEXT_LEDGER_DB: database } };
}

const setVersion = (database, version) => {
  const raw = new DatabaseSync(database);
  raw.exec(`PRAGMA user_version = ${version};`);
  raw.close();
};

test('P3c: a read-only store reads a current ledger, and a write through it fails', t => {
  const context = ledger(t);
  const before = readFileSync(context.database);
  const store = openStore(context.database, { readOnly: true });
  try {
    assert.equal(store.get(context.sessionId).id, context.sessionId);
    const reviews = store.verifyReviews();
    assert.equal(reviews.events, 1);
    assert.equal(reviews.brokenAt, undefined);
    assert.throws(() => store.importTranscript({ provider: 'claude', source: 'more.jsonl', transcript: transcript + '\n' }));
  } finally {
    store.close();
  }
  assert.deepEqual(readFileSync(context.database), before);
});

test('P3c: a read-only store refuses an older or newer schema and leaves the file as it was', t => {
  const context = ledger(t);
  for (const version of [schemaVersion - 1, schemaVersion + 1]) {
    setVersion(context.database, version);
    const before = readFileSync(context.database);
    assert.throws(() => openStore(context.database, { readOnly: true }),
      error => error.code === 'LEDGER_SCHEMA' && error.version === version);
    assert.deepEqual(readFileSync(context.database), before);
    const check = new DatabaseSync(context.database, { readOnly: true });
    assert.equal(check.prepare('PRAGMA user_version').get().user_version, version);
    check.close();
  }
});

test('P3c: a read-only store never creates a missing file or its folder', t => {
  const folder = mkdtempSync(join(tmpdir(), 'ledger-p3c-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const database = join(folder, 'missing', 'ledger.sqlite');
  assert.throws(() => openStore(database, { readOnly: true }));
  assert.equal(existsSync(join(folder, 'missing')), false);
});

test('P3c: signing an older-schema ledger writes no bundle and leaves the file at its version', async t => {
  const context = ledger(t);
  const keygen = await run(['keygen'], context.env);
  assert.equal(keygen.code, 0, keygen.stderr);
  setVersion(context.database, schemaVersion - 1);
  const before = readFileSync(context.database);
  const bundle = join(context.folder, 'bundle');
  const refused = await run(['handoff', context.sessionId, '--sign', bundle], context.env);
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /older schema.*then sign again/su);
  assert.equal(existsSync(bundle), false);
  assert.deepEqual(readFileSync(context.database), before);
});

test('P3c: signing a current ledger still makes a bundle that verifies with its review head', async t => {
  const context = ledger(t);
  const keygen = await run(['keygen'], context.env);
  assert.equal(keygen.code, 0, keygen.stderr);
  const before = readFileSync(context.database);
  const bundle = join(context.folder, 'bundle');
  const signed = await run(['handoff', context.sessionId, '--sign', bundle], context.env);
  assert.equal(signed.code, 0, signed.stderr);
  assert.deepEqual(readFileSync(context.database), before);
  const checked = await run(['reviews', 'verify', '--bundle', bundle, '--fingerprint', keygen.stdout.trim()], context.env);
  assert.equal(checked.code, 0, checked.stderr);
});

test('P3c: the CLI opens the ledger for signing and reviews verify only through the read-only helper', () => {
  const source = readFileSync(new URL('../src/cli.mjs', import.meta.url), 'utf8');
  // The body of a top-level function: from its header to the next line that closes one.
  const body = name => {
    const start = source.indexOf(`async function ${name}(`);
    assert.ok(start >= 0, name);
    return source.slice(start, source.indexOf('\n}\n', start));
  };
  assert.match(body('openCurrentStore'), /openStore\(databasePath, \{ readOnly: true \}\)/u);
  // One open, and only that one.
  assert.equal((body('openCurrentStore').match(/openStore\(|DatabaseSync/gu) ?? []).length, 1);
  for (const name of ['readLedgerSession', 'readReviewChain']) {
    assert.match(body(name), /await openCurrentStore\(databasePath, '(sign|verify)'\)/u, name);
    assert.doesNotMatch(body(name), /openStore\(|DatabaseSync/u, name);
  }
  assert.equal((source.match(/new DatabaseSync\(/gu) ?? []).length, 0);
});

test('P3c review: a current-schema file missing its tables is refused and the connection closed', t => {
  const folder = mkdtempSync(join(tmpdir(), 'ledger-p3c-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const database = join(folder, 'ledger.sqlite');
  setVersion(database, schemaVersion);
  for (const readOnly of [true, false]) {
    assert.throws(() => openStore(database, { readOnly }));
    // Closed: the file can be removed at once, even on Windows.
    rmSync(database);
    setVersion(database, schemaVersion);
  }
});

test('P3c review: storeOn leaves closing to openStore, so its errors are not masked', () => {
  const source = readFileSync(new URL('../src/store.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('function storeOn(database) {');
  assert.ok(start >= 0);
  const setup = source.slice(start, source.indexOf('\n  return {', start));
  assert.doesNotMatch(setup, /database\.close\(\)/u);
});

test('P3c review: the final newer-schema check is coded like the read-only refusal', t => {
  const context = ledger(t);
  setVersion(context.database, schemaVersion + 1);
  const raw = new DatabaseSync(context.database, { readOnly: true });
  try {
    assert.throws(() => refuseNewerSchema(raw),
      error => error.code === 'LEDGER_SCHEMA' && error.version === schemaVersion + 1 && /newer Context Ledger/u.test(error.message));
  } finally {
    raw.close();
  }
});

test('P3c review: signing and reviews verify each open exactly one read-only connection, at run time', async t => {
  const context = ledger(t);
  const keygen = await run(['keygen'], context.env);
  assert.equal(keygen.code, 0, keygen.stderr);
  const log = join(context.folder, 'opens.jsonl');
  const preload = ['--require', fileURLToPath(new URL('./fixtures/count-opens.cjs', import.meta.url))];
  const counted = async args => {
    rmSync(log, { force: true });
    const result = await run(args, { ...context.env, P3C_OPEN_LOG: log }, preload);
    assert.equal(result.code, 0, result.stderr);
    return readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  };
  const bundle = join(context.folder, 'bundle');
  const expected = [{ path: context.database, readOnly: true }];
  assert.deepEqual(await counted(['handoff', context.sessionId, '--sign', bundle]), expected);
  assert.deepEqual(await counted(['reviews', 'verify']), expected);
  assert.deepEqual(await counted(['reviews', 'verify', '--bundle', bundle, '--fingerprint', keygen.stdout.trim()]), expected);
});
