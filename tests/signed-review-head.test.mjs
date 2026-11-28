// Card P3b: a signed hand-off (manifest version 2) records the review chain's count and
// head (P3, ADR-17), and `ledger reviews verify --bundle` checks a ledger against it.
// Synthetic transcripts, names and keys only.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createPrivateKey } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { handoffMarkdown } from '../src/handoff.mjs';
import { buildBundle, verifyBundle, writeBundle } from '../src/sign.mjs';
import { openStore } from '../src/store.mjs';

const uuid = n => `0000000${n}-aaaa-4bbb-8ccc-00000000000${n}`;
const transcript = [['user', 'Vera: the relay ships on port 6100.'], ['assistant', 'Noted: port 6100.']]
  .map(([role, text], index) => JSON.stringify({ type: role, uuid: uuid(index + 1), message: { role, content: text } })).join('\n');

function run(args, env) {
  return new Promise(resolve => {
    execFile(process.execPath, ['src/cli.mjs', ...args], { env: { ...process.env, ...env } }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, stderr });
    });
  });
}

/** A ledger with one session, a version 3 graph and `reviews` decisions, a key, and its env. */
async function ledger(t, reviews = 2) {
  const folder = mkdtempSync(join(tmpdir(), 'ledger-p3b-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const database = join(folder, 'data', 'ledger.sqlite');
  const env = { CONTEXT_LEDGER_DB: database };
  const keygen = await run(['keygen'], env);
  assert.equal(keygen.code, 0, keygen.stderr);
  const store = openStore(database);
  const session = store.importTranscript({ provider: 'claude', source: 'vera.jsonl', transcript });
  const graph = store.publishGraph({ version: 3, sessionId: session.id, party: 'vera', edges: [],
    nodes: [{ id: 'port', kind: 'decision', label: 'Port 6100', evidence: [{ message: `u:${uuid(1)}` }] }] });
  const nodeSha256 = graph.nodeHashes[0].sha256;
  const review = decision => store.reviewNode(graph.id, { nodeId: 'port', nodeSha256, decision, reviewer: 'Vera' });
  for (let index = 0; index < reviews; index += 1) review(index % 2 ? 'reject' : 'approve');
  const head = store.verifyReviews().head;
  store.close();
  const privateKey = createPrivateKey(readFileSync(join(folder, 'data', 'signing-key.pem')));
  const more = decision => {
    const again = openStore(database);
    try {
      again.reviewNode(graph.id, { nodeId: 'port', nodeSha256, decision, reviewer: 'Vera' });
    } finally {
      again.close();
    }
  };
  return { folder, database, env, sessionId: session.id, head, fingerprint: keygen.stdout.trim(), privateKey, more };
}

async function sign(context, name = 'bundle') {
  const bundle = join(context.folder, name);
  const signed = await run(['handoff', context.sessionId, '--sign', bundle], context.env);
  assert.equal(signed.code, 0, signed.stderr);
  return bundle;
}

test('P3b: signing records the review chain, and verify shows it', async t => {
  const context = await ledger(t);
  const bundle = await sign(context);
  const manifest = JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8'));
  // Version 3 since card P4d, which adds the redaction record beside the review chain.
  assert.equal(manifest.version, 3);
  assert.deepEqual(manifest.reviews, { events: 2, head: context.head });

  const verified = await run(['verify', bundle, '--fingerprint', context.fingerprint], context.env);
  assert.equal(verified.code, 0, verified.stderr);
  assert.match(verified.stdout, new RegExp(`\\nReview chain at signing: 2 events, head ${context.head}\\nRedaction: 0 replacements, by context-ledger-secrets/1\\n$`, 'u'));
  const result = await verifyBundle(bundle, { fingerprint: context.fingerprint });
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.reviews, { events: 2, head: context.head });
});

test('P3b: reviews verify --bundle passes while the ledger only grows past the signed head', async t => {
  const context = await ledger(t);
  const bundle = await sign(context);
  const now = await run(['reviews', 'verify', '--bundle', bundle, '--fingerprint', context.fingerprint], context.env);
  assert.equal(now.code, 0, now.stderr);
  assert.match(now.stdout, /^Review chain verified: 2 events, with the trusted head at event 2 \(0 added since\)\./u);
  assert.doesNotMatch(now.stderr, /key was not checked/u);

  context.more('approve');
  const later = await run(['reviews', 'verify', '--bundle', bundle, '--fingerprint', context.fingerprint], context.env);
  assert.equal(later.code, 0, later.stderr);
  assert.match(later.stdout, /^Review chain verified: 3 events, with the trusted head at event 2 \(1 added since\)\./u);
  // Without the fingerprint it still checks, and says the key was not checked.
  const unkeyed = await run(['reviews', 'verify', '--bundle', bundle], context.env);
  assert.equal(unkeyed.code, 0, unkeyed.stderr);
  assert.match(unkeyed.stderr, /the key was not checked/u);
});

test('P3b: a ledger cut short or rewritten after signing fails against the bundle', async t => {
  const context = await ledger(t, 3);
  const bundle = await sign(context);
  // Someone with the file keeps only the first event: the shorter chain still checks alone.
  const raw = new DatabaseSync(context.database);
  raw.exec(`
    CREATE TABLE kept AS SELECT * FROM review_events WHERE seq = 1;
    DROP TABLE review_events;
    ALTER TABLE kept RENAME TO review_events;
  `);
  raw.close();
  const alone = await run(['reviews', 'verify'], context.env);
  assert.equal(alone.code, 0, alone.stderr);
  const against = await run(['reviews', 'verify', '--bundle', bundle, '--fingerprint', context.fingerprint], context.env);
  assert.notEqual(against.code, 0);
  assert.match(against.stderr, /The trusted head is not in this review chain/u);
});

test('P3b: a bundle that does not verify, or names another key, is not trusted for its head', async t => {
  const context = await ledger(t);
  const bundle = await sign(context);
  const other = await ledger(t);
  const wrongKey = await run(['reviews', 'verify', '--bundle', bundle, '--fingerprint', other.fingerprint], context.env);
  assert.notEqual(wrongKey.code, 0);
  assert.match(wrongKey.stderr, /signed by a different key/u);
  assert.match(wrongKey.stderr, /The signed hand-off did not verify, so its review head is not trusted\./u);

  // A head changed in the manifest breaks the signature.
  const manifestPath = join(bundle, 'manifest.json');
  const text = readFileSync(manifestPath, 'utf8');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(manifestPath, text.replace(`"events":2`, `"events":1`));
  const changed = await run(['reviews', 'verify', '--bundle', bundle, '--fingerprint', context.fingerprint], context.env);
  assert.notEqual(changed.code, 0);
  assert.match(changed.stderr, /The signature does not match the manifest\./u);
});

test('P3b: a signed count that does not match the head position fails', async t => {
  const context = await ledger(t);
  // Signed by the right key, but claiming the head is event 5.
  const store = openStore(context.database);
  const markdown = handoffMarkdown(store.get(context.sessionId)) + '\n';
  store.close();
  const bundle = join(context.folder, 'miscount');
  await writeBundle(bundle, buildBundle({ sessionId: context.sessionId, markdown, privateKey: context.privateKey, reviews: { events: 5, head: context.head } }));
  const result = await run(['reviews', 'verify', '--bundle', bundle, '--fingerprint', context.fingerprint], context.env);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /The signed head is event 5 of its chain, but event 2 here\./u);
});

test('P3b: a version 1 bundle still verifies, and says it records no review head', async t => {
  const context = await ledger(t);
  const store = openStore(context.database);
  const markdown = handoffMarkdown(store.get(context.sessionId)) + '\n';
  store.close();
  const bundle = join(context.folder, 'v1');
  await writeBundle(bundle, buildBundle({ sessionId: context.sessionId, markdown, privateKey: context.privateKey }));
  assert.equal(JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8')).version, 1);
  const verified = await run(['verify', bundle, '--fingerprint', context.fingerprint], context.env);
  assert.equal(verified.code, 0, verified.stderr);
  assert.match(verified.stdout, /\nReview chain at signing: not recorded \(a version 1 bundle\)\nRedaction: not recorded \(a version 1 bundle\)\n$/u);
  assert.equal((await verifyBundle(bundle)).reviews, null);
  const against = await run(['reviews', 'verify', '--bundle', bundle], context.env);
  assert.notEqual(against.code, 0);
  assert.match(against.stderr, /This signed hand-off is version 1 and records no review head\./u);
});

test('P3b: an empty chain signs as 0 events and the genesis head', async t => {
  const context = await ledger(t, 0);
  const bundle = await sign(context);
  assert.deepEqual(JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8')).reviews, { events: 0, head: '0'.repeat(64) });
  const against = await run(['reviews', 'verify', '--bundle', bundle, '--fingerprint', context.fingerprint], context.env);
  assert.equal(against.code, 0, against.stderr);
  assert.match(against.stdout, /^Review chain verified: 0 events, with the trusted head at event 0 \(0 added since\)\./u);
});

test('P3b: a broken chain is never signed, and nothing is written', async t => {
  const context = await ledger(t);
  const raw = new DatabaseSync(context.database);
  raw.exec("DROP TRIGGER review_events_no_update; UPDATE review_events SET reviewer = 'Other' WHERE seq = 1;");
  raw.close();
  const bundle = join(context.folder, 'refused');
  const signed = await run(['handoff', context.sessionId, '--sign', bundle], context.env);
  assert.notEqual(signed.code, 0);
  assert.match(signed.stderr, /Review chain broken at event 1: run reviews verify, and sign once the ledger is repaired\./u);
  assert.equal(existsSync(bundle), false);
});

test('P3b: --bundle and --head do not combine, and --fingerprint needs --bundle', async t => {
  const context = await ledger(t, 0);
  const both = await run(['reviews', 'verify', '--bundle', context.folder, '--head', '0'.repeat(64)], context.env);
  assert.match(both.stderr, /Give --head or --bundle, not both\./u);
  const lone = await run(['reviews', 'verify', '--fingerprint', context.fingerprint], context.env);
  assert.match(lone.stderr, /--fingerprint goes with --bundle\./u);
});

test('P3b review: a changed handoff.md under a valid signature is not trusted for its head', async t => {
  const context = await ledger(t);
  const bundle = await sign(context);
  const { appendFileSync } = await import('node:fs');
  appendFileSync(join(bundle, 'handoff.md'), 'one more line\n');
  const result = await run(['reviews', 'verify', '--bundle', bundle, '--fingerprint', context.fingerprint], context.env);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /File changed: handoff\.md/u);
  assert.match(result.stderr, /The signed hand-off did not verify, so its review head is not trusted\./u);
  assert.equal(result.stdout, '');
});

test('P3b review: reviews verify reads the ledger read-only and never migrates it', async t => {
  const context = await ledger(t);
  const bundle = await sign(context);
  const raw = new DatabaseSync(context.database);
  raw.exec('PRAGMA user_version = 6;');
  raw.close();
  const result = await run(['reviews', 'verify', '--bundle', bundle, '--fingerprint', context.fingerprint], context.env);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /older schema.*then verify again/su);
  const check = new DatabaseSync(context.database, { readOnly: true });
  assert.equal(check.prepare('PRAGMA user_version').get().user_version, 6);
  check.close();
  const missing = await run(['reviews', 'verify'], { CONTEXT_LEDGER_DB: join(context.folder, 'none.sqlite') });
  assert.match(missing.stderr, /No ledger database\./u);
  assert.equal(existsSync(join(context.folder, 'none.sqlite')), false);
});

test('P4d review: reviews verify --bundle warns that a version 2 hand-off was not redacted', async t => {
  const context = await ledger(t);
  const store = openStore(context.database);
  const markdown = handoffMarkdown(store.get(context.sessionId)) + '\n';
  store.close();
  const old = join(context.folder, 'old');
  await writeBundle(old, buildBundle({ sessionId: context.sessionId, markdown, privateKey: context.privateKey,
    reviews: { events: 2, head: context.head } }));
  const audit = await run(['reviews', 'verify', '--bundle', old, '--fingerprint', context.fingerprint], context.env);
  assert.equal(audit.code, 0, audit.stderr);
  assert.match(audit.stderr, /signed before hand-offs were redacted/u);
  // A version 3 bundle, which was redacted, has no such warning.
  const current = await run(['reviews', 'verify', '--bundle', await sign(context), '--fingerprint', context.fingerprint], context.env);
  assert.equal(current.code, 0, current.stderr);
  assert.doesNotMatch(current.stderr, /redacted/u);
});
