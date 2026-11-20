import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

// Card P1a: evidence for the storage engine decision (ADR-003). This records, on every
// system CI runs, which Node and SQLite build is in use and whether node:sqlite has FTS5.
// It never fails on a missing FTS5; it only reports. Synthetic data only.
test('P1a: report the SQLite build node:sqlite ships and whether FTS5 is in it', t => {
  const database = new DatabaseSync(':memory:');
  try {
    const { version } = database.prepare('SELECT sqlite_version() AS version').get();
    let fts5 = true;
    try {
      database.exec("CREATE VIRTUAL TABLE probe USING fts5(text); INSERT INTO probe VALUES ('ledger handoff');");
      assert.equal(database.prepare("SELECT count(*) AS n FROM probe WHERE probe MATCH 'handoff'").get().n, 1);
    } catch (error) {
      if (!/no such module: fts5/u.test(error.message)) throw error;
      fts5 = false;
    }
    t.diagnostic(`P1a probe: node ${process.version}, ${process.platform}-${process.arch}, sqlite ${version}, fts5 ${fts5 ? 'yes' : 'no'}`);
  } finally {
    database.close();
  }
});
