// Card P4e: signing opens the ledger once, read-only, and checks the schema on that same
// connection, so a database file swapped in after a check is never migrated or written.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { OlderSchemaError, schemaVersion } from '../src/migrate.mjs';
import { openStore } from '../src/store.mjs';

const transcript = [
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'Synthetic: sign the hand-off read-only.' } }),
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'Synthetic: one connection, no migration.' } }),
].join('\n');

function folder(t) {
  const path = mkdtempSync(join(tmpdir(), 'ledger-p4e-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function seeded(t) {
  const path = join(folder(t), 'ledger.sqlite');
  const store = openStore(path);
  const { id } = store.importTranscript({ provider: 'claude', source: 'synthetic-p4e.jsonl', transcript });
  const session = store.get(id);
  const reviews = store.verifyReviews();
  store.close();
  return { path, id, session, reviews };
}

function setVersion(path, version) {
  const database = new DatabaseSync(path);
  database.exec(`PRAGMA user_version = ${version}`);
  database.close();
}

function snapshot(path) {
  return { sha256: createHash('sha256').update(readFileSync(path)).digest('hex'), mtimeMs: statSync(path).mtimeMs };
}

test('P4e: a read-only store reads what the normal store reads, and its writes fail', t => {
  const { path, id, session, reviews } = seeded(t);
  const before = snapshot(path);
  const store = openStore(path, { readOnly: true });
  try {
    assert.deepEqual(store.get(id), session);
    assert.deepEqual(store.verifyReviews(), reviews);
    assert.throws(() => store.importTranscript({ provider: 'claude', source: 'other.jsonl', transcript: transcript.replace('read-only', 'again') }));
    assert.throws(() => store.deleteSession(id));
  } finally {
    store.close();
  }
  assert.deepEqual(snapshot(path), before);
  assert.ok(!existsSync(path + '-journal'));
});

test('P4e: a read-only open refuses an older or a newer schema and leaves the file as it was', t => {
  for (const [version, expected] of [[schemaVersion - 1, OlderSchemaError], [schemaVersion + 1, null]]) {
    const { path } = seeded(t);
    setVersion(path, version);
    const before = snapshot(path);
    if (expected) {
      assert.throws(() => openStore(path, { readOnly: true }), expected);
    } else {
      assert.throws(() => openStore(path, { readOnly: true }),
        { message: `This ledger database was written by a newer Context Ledger (schema ${version}). Use that version or another CONTEXT_LEDGER_DB.` });
    }
    assert.deepEqual(snapshot(path), before, `schema ${version}`);
    assert.ok(!existsSync(path + '-journal'), `schema ${version}`);
    // The normal store would have upgraded the older file; the read-only one did not.
    const probe = new DatabaseSync(path, { readOnly: true });
    assert.equal(probe.prepare('PRAGMA user_version').get().user_version, version);
    probe.close();
  }
});

test('P4e: a read-only open never creates a file or its folder', t => {
  const missing = join(folder(t), 'absent', 'ledger.sqlite');
  assert.throws(() => openStore(missing, { readOnly: true }));
  assert.ok(!existsSync(missing));
  assert.ok(!existsSync(join(missing, '..')));
});

test('P4e: signing opens the ledger only through the read-only store, with no separate probe', () => {
  // A Windows checkout has CRLF line ends; the function's end is found on LF ones.
  const source = readFileSync(new URL('../src/cli.mjs', import.meta.url), 'utf8').replace(/\r\n/gu, '\n');
  const opener = source.slice(source.indexOf('async function openCurrentStore'), source.indexOf('\n}\n', source.indexOf('async function openCurrentStore')));
  assert.ok(opener.includes('openStore(databasePath, { readOnly: true })'));
  assert.ok(!opener.includes('new DatabaseSync('), 'no second connection checks the schema');
  // Outside the file import (card I1), every openStore call in the CLI is read-only.
  const calls = [...source.matchAll(/openStore\(([^)]*)\)/gu)].map(match => match[1]);
  const writable = calls.filter(args => !args.includes('readOnly: true'));
  assert.deepEqual(writable, ["process.env.CONTEXT_LEDGER_DB ?? '.context-ledger/ledger.sqlite'"]);
});
