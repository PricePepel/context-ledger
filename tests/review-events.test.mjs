// Card P3 (ADR-6, ADR-17): review decisions are append-only events chained by hash, and
// the decisions a graph shows are a fold of them. Synthetic transcripts and names only.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { schemaVersion } from '../src/migrate.mjs';
import { checkChain, eventHash, genesis, labelRule } from '../src/reviews.mjs';
import { InputError, openStore } from '../src/store.mjs';

const uuid = n => `0000000${n}-aaaa-4bbb-8ccc-00000000000${n}`;
const claude = turns => turns.map(([role, text], index) => JSON.stringify({ type: role, uuid: uuid(index + 1), message: { role, content: text } })).join('\n');
const transcript = claude([['user', 'Mira: the gateway ships on port 7100.'], ['assistant', 'Noted: port 7100.'], ['user', 'Tomas tests on Monday.']]);
const key = n => `u:${uuid(n)}`;
const packet = (sessionId, portLabel = 'Port 7100') => ({
  version: 3, sessionId, party: 'mira', edges: [],
  nodes: [
    { id: 'port', kind: 'decision', label: portLabel, evidence: [{ message: key(1) }, { message: key(2) }] },
    { id: 'test', kind: 'action', status: 'pending', label: 'Tomas tests the gateway', evidence: [{ message: key(3) }] },
  ],
});

async function fileStore(t, prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const path = join(directory, 'ledger.sqlite');
  const open = [];
  t.after(async () => { for (const item of open) item.close(); await rm(directory, { recursive: true, force: true }); });
  const keep = item => { open.push(item); return item; };
  return { path, keep };
}

function setup(store) {
  const session = store.importTranscript({ provider: 'claude', source: 'mira.jsonl', transcript });
  const graph = store.publishGraph(packet(session.id));
  const hash = id => graph.nodeHashes.find(entry => entry.id === id).sha256;
  return { session, graph, hash };
}

test('P3: every decision is an event; the graph shows the latest one per node hash', () => {
  const store = openStore(':memory:');
  const { graph, hash } = setup(store);
  store.reviewNode(graph.id, { nodeId: 'port', nodeSha256: hash('port'), decision: 'reject', reviewer: 'Mira' });
  store.reviewNode(graph.id, { nodeId: 'port', nodeSha256: hash('port'), decision: 'approve', reviewer: 'Tomas' });
  const reviews = store.reviewNode(graph.id, { nodeId: 'test', nodeSha256: hash('test'), decision: 'edit', label: 'Tomas tests the gateway on Monday', reviewer: 'Mira' });
  assert.deepEqual(reviews.map(({ nodeId, decision, label, reviewer }) => ({ nodeId, decision, label, reviewer })), [
    { nodeId: 'port', decision: 'approve', label: undefined, reviewer: 'Tomas' },
    { nodeId: 'test', decision: 'edit', label: 'Tomas tests the gateway on Monday', reviewer: 'Mira' },
  ]);
  assert.ok(reviews.every(review => /^[a-f0-9]{64}$/u.test(review.event) && !('seq' in review)));
  // Three events are kept, not one row per node.
  const verified = store.verifyReviews();
  assert.equal(verified.events, 3);
  assert.equal(verified.brokenAt, undefined);
  assert.equal(verified.head, reviews.find(review => review.nodeId === 'test').event);
  // The graph never changes: an edit is a review outcome beside the node.
  assert.equal(store.getGraph(graph.id).packet.nodes.find(node => node.id === 'test').label, 'Tomas tests the gateway');
  assert.deepEqual(store.graphReviews(graph.id), reviews);
  store.close();
});

test('P3: a changed node starts unreviewed, and its old events stay in the chain', () => {
  const store = openStore(':memory:');
  const { session, graph, hash } = setup(store);
  store.reviewNode(graph.id, { nodeId: 'port', nodeSha256: hash('port'), decision: 'approve', reviewer: 'Mira' });
  const changed = store.publishGraph(packet(session.id, 'Port 7200'));
  assert.deepEqual(store.graphReviews(changed.id), []);
  assert.deepEqual(store.graphReviews(graph.id).map(review => review.nodeId), ['port']);
  assert.equal(store.verifyReviews().events, 1);
  store.close();
});

test('P3: edits carry a label; approve and reject do not; errors never echo a value', () => {
  const store = openStore(':memory:');
  const { graph, hash } = setup(store);
  const base = { nodeId: 'port', nodeSha256: hash('port'), reviewer: 'Mira' };
  const refused = (input, message) => assert.throws(() => store.reviewNode(graph.id, input),
    error => error instanceof InputError && error.message === message, JSON.stringify(input));
  const secret = 'synthetic-value-9q';
  for (const label of [undefined, '', '   ', 'x'.repeat(501), String.fromCodePoint(0xd800), 7, 'Port\n7100', 'Port\r7100', `Port${String.fromCodePoint(0x2028)}7100`]) {
    refused({ ...base, decision: 'edit', label }, labelRule);
  }
  refused({ ...base, decision: 'approve', label: secret }, 'Only an edit carries a label.');
  refused({ ...base, decision: 'reject', label: secret }, 'Only an edit carries a label.');
  refused({ ...base, decision: secret }, 'decision must be approve, edit or reject.');
  store.reviewNode(graph.id, { ...base, decision: 'edit', label: 'x'.repeat(500) });
  // P3 review 8: 500 code points, as for graph labels, even when that is more UTF-16 units.
  const emoji = String.fromCodePoint(0x1f680);
  store.reviewNode(graph.id, { ...base, decision: 'edit', label: emoji.repeat(20) + 'x'.repeat(480) });
  refused({ ...base, decision: 'edit', label: emoji.repeat(21) + 'x'.repeat(480) }, labelRule);
  assert.equal(store.verifyReviews().events, 2);
  store.close();
});

test('P3: the database refuses to change or delete an event', async t => {
  const { path, keep } = await fileStore(t, 'ledger-p3-append-');
  const store = keep(openStore(path));
  const { graph, hash } = setup(store);
  store.reviewNode(graph.id, { nodeId: 'port', nodeSha256: hash('port'), decision: 'approve', reviewer: 'Mira' });
  const raw = keep(new DatabaseSync(path));
  assert.throws(() => raw.exec("UPDATE review_events SET decision = 'reject'"), /append-only/u);
  assert.throws(() => raw.exec('DELETE FROM review_events'), /append-only/u);
  const head = store.verifyReviews().head;
  const insert = (sql, ...values) => raw.prepare(`${sql} INTO review_events (seq, prev, hash, session_id, party, node_id, node_sha256, decision, label_json, reviewer, decided_at) VALUES (?, ?, ?, 's', 'p', 'n', 'h', ?, ?, 'r', 't')`).run(...values);
  assert.throws(() => insert('INSERT', 2, head, 'f'.repeat(64), 'approve', '"a label"'), /CHECK/u, 'only an edit has a label');
  // P3 review: INSERT OR REPLACE deletes without firing the delete trigger, so an insert
  // must be the next event after the head.
  assert.throws(() => insert('INSERT OR REPLACE', 1, genesis, 'e'.repeat(64), 'reject', null), /follow the head/u);
  assert.throws(() => insert('REPLACE', 1, genesis, 'e'.repeat(64), 'reject', null), /follow the head/u);
  assert.throws(() => insert('INSERT', 3, head, 'e'.repeat(64), 'reject', null), /follow the head/u, 'no gap in seq');
  assert.throws(() => insert('INSERT', 2, genesis, 'e'.repeat(64), 'reject', null), /follow the head/u, 'prev is the head');
  assert.equal(store.verifyReviews().events, 1);
  assert.equal(store.verifyReviews().brokenAt, undefined);
});

test('P3: verify recomputes the chain and names the first event that does not match', async t => {
  const { path, keep } = await fileStore(t, 'ledger-p3-verify-');
  const store = keep(openStore(path));
  const { graph, hash } = setup(store);
  for (const decision of ['approve', 'reject', 'approve']) {
    store.reviewNode(graph.id, { nodeId: 'port', nodeSha256: hash('port'), decision, reviewer: 'Mira' });
  }
  const clean = store.verifyReviews();
  assert.deepEqual({ events: clean.events, brokenAt: clean.brokenAt }, { events: 3, brokenAt: undefined });

  // Someone with the file drops the triggers and rewrites the second event's reviewer.
  const raw = keep(new DatabaseSync(path));
  raw.exec("DROP TRIGGER review_events_no_update; UPDATE review_events SET reviewer = 'Tomas' WHERE seq = 2;");
  assert.deepEqual(store.verifyReviews(), { events: 2, brokenAt: 2 });
});

test('P3: checkChain checks seq, prev and each hash', () => {
  const first = { seq: 1, prev: genesis, sessionId: 's', party: 'p', nodeId: 'n', nodeSha256: 'a'.repeat(64), decision: 'approve', reviewer: 'Mira', decidedAt: '2026-11-21T00:00:00.000Z' };
  first.hash = eventHash(first);
  const second = { ...first, seq: 2, prev: first.hash, decision: 'edit', label: 'Port 7100 on Monday' };
  second.hash = eventHash(second);
  assert.deepEqual(checkChain([first, second]), { events: 2, head: second.hash });
  assert.deepEqual(checkChain([]), { events: 0, head: genesis });
  assert.equal(checkChain([second]).brokenAt, 1, 'a chain must start at seq 1 after the genesis hash');
  assert.equal(checkChain([first, { ...second, label: 'Port 7200' }]).brokenAt, 2, 'the label is in the hash');
  assert.equal(checkChain([first, { ...second, prev: genesis }]).brokenAt, 2);
  // label is hashed only on an edit.
  assert.equal(eventHash({ ...first, label: 'ignored' }), first.hash);
});

test('P3: two stores on one file append to one chain', async t => {
  const { path, keep } = await fileStore(t, 'ledger-p3-two-');
  const a = keep(openStore(path));
  const b = keep(openStore(path));
  const { graph, hash } = setup(a);
  for (let index = 0; index < 6; index += 1) {
    (index % 2 ? a : b).reviewNode(graph.id, { nodeId: 'port', nodeSha256: hash('port'), decision: index % 2 ? 'approve' : 'reject', reviewer: index % 2 ? 'Mira' : 'Tomas' });
  }
  const verified = a.verifyReviews();
  assert.equal(verified.events, 6);
  assert.equal(verified.brokenAt, undefined);
  assert.deepEqual(b.graphReviews(graph.id).map(review => [review.decision, review.reviewer]), [['approve', 'Mira']]);
});

test('P3: a version 6 file with P2c rows gains one event per row, in order, and shows the same decisions', async t => {
  const { path, keep } = await fileStore(t, 'ledger-p3-migrate-');
  const first = openStore(path);
  const { graph, hash } = setup(first);
  first.close();

  // Back to version 6: the P2c table with two decisions, and no events.
  const raw = new DatabaseSync(path);
  raw.exec(`
    DROP TABLE review_events;
    CREATE TABLE node_reviews (
      session_id TEXT NOT NULL, party TEXT NOT NULL, node_id TEXT NOT NULL, node_sha256 TEXT NOT NULL,
      decision TEXT NOT NULL CHECK (decision IN ('approve', 'reject')), reviewer TEXT NOT NULL, decided_at TEXT NOT NULL,
      PRIMARY KEY (session_id, party, node_id, node_sha256)
    ) STRICT;
    PRAGMA user_version = 6;
  `);
  const insert = raw.prepare('INSERT INTO node_reviews VALUES (?, ?, ?, ?, ?, ?, ?)');
  insert.run(graph.packet.sessionId, 'mira', 'test', hash('test'), 'reject', 'Tomas', '2026-11-20T10:00:00.000Z');
  insert.run(graph.packet.sessionId, 'mira', 'port', hash('port'), 'approve', 'Mira', '2026-11-20T09:00:00.000Z');
  raw.close();

  const store = keep(openStore(path));
  assert.deepEqual(store.graphReviews(graph.id).map(({ nodeId, decision, reviewer, decidedAt }) => [nodeId, decision, reviewer, decidedAt]), [
    ['port', 'approve', 'Mira', '2026-11-20T09:00:00.000Z'],
    ['test', 'reject', 'Tomas', '2026-11-20T10:00:00.000Z'],
  ]);
  const verified = store.verifyReviews();
  assert.equal(verified.events, 2);
  assert.equal(verified.brokenAt, undefined);
  const check = keep(new DatabaseSync(path));
  assert.equal(check.prepare('PRAGMA user_version').get().user_version, schemaVersion);
  assert.equal(check.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'node_reviews'").get().n, 0);
  // In the order they were decided, not the order they were stored.
  assert.deepEqual(check.prepare('SELECT seq, node_id AS nodeId FROM review_events ORDER BY seq').all().map(row => [row.seq, row.nodeId]), [[1, 'port'], [2, 'test']]);
});

function cli(args, env) {
  return new Promise(resolve => {
    execFile(process.execPath, ['src/cli.mjs', ...args], { env: { ...process.env, ...env } }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, stderr });
    });
  });
}

test('P3: ledger reviews verify prints the count and head, and names a broken event by number only', async t => {
  const { path, keep } = await fileStore(t, 'ledger-p3-cli-');
  const store = openStore(path);
  const { graph, hash } = setup(store);
  const first = store.reviewNode(graph.id, { nodeId: 'port', nodeSha256: hash('port'), decision: 'approve', reviewer: 'Mira' });
  store.reviewNode(graph.id, { nodeId: 'test', nodeSha256: hash('test'), decision: 'edit', label: 'Tomas tests on Monday', reviewer: 'Mira' });
  const head = store.verifyReviews().head;
  store.close();

  const ok = await cli(['reviews', 'verify'], { CONTEXT_LEDGER_DB: path });
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(ok.stdout, `Review chain verified: 2 events.\nHead: ${head}\n`);
  assert.notEqual(first[0].event, head);
  assert.match(ok.stderr, /events removed from the end would not show/u);

  // P3 review: a trusted head shows a chain cut short or rewritten at its end.
  const trusted = await cli(['reviews', 'verify', '--head', first[0].event], { CONTEXT_LEDGER_DB: path });
  assert.equal(trusted.code, 0, trusted.stderr);
  assert.equal(trusted.stdout, `Review chain verified: 2 events, with the trusted head at event 1 (1 added since).\nHead: ${head}\n`);
  const unknown = await cli(['reviews', 'verify', '--head', 'c'.repeat(64)], { CONTEXT_LEDGER_DB: path });
  assert.notEqual(unknown.code, 0);
  assert.match(unknown.stderr, /The trusted head is not in this review chain/u);
  const badHead = await cli(['reviews', 'verify', '--head', 'not-a-hash'], { CONTEXT_LEDGER_DB: path });
  assert.match(badHead.stderr, /--head must be a 64-character lowercase hex hash\./u);
  assert.equal(badHead.stderr.includes('not-a-hash'), false);

  const raw = keep(new DatabaseSync(path));
  raw.exec(`DROP TRIGGER review_events_no_update; UPDATE review_events SET label_json = '"synthetic-tampered-label"' WHERE seq = 2;`);
  const broken = await cli(['reviews', 'verify'], { CONTEXT_LEDGER_DB: path });
  assert.notEqual(broken.code, 0);
  assert.match(broken.stderr, /Review chain broken at event 2: it does not match the events before it\./u);
  assert.equal(broken.stderr.includes('synthetic-tampered-label'), false);

  // An older file is not migrated by a check.
  raw.exec('PRAGMA user_version = 6;');
  const older = await cli(['reviews', 'verify'], { CONTEXT_LEDGER_DB: path });
  assert.match(older.stderr, /older schema.*then verify again/su);
  assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 6);
  const usage = await cli(['reviews'], { CONTEXT_LEDGER_DB: path });
  assert.match(usage.stderr, /reviews verify/u);
});

test('P3 review: an edit label with a NUL is kept whole, and the chain still verifies', () => {
  const store = openStore(':memory:');
  const { graph, hash } = setup(store);
  const label = `Corrected${String.fromCodePoint(0)}suffix`;
  const reviews = store.reviewNode(graph.id, { nodeId: 'port', nodeSha256: hash('port'), decision: 'edit', label, reviewer: 'Mira' });
  assert.equal(reviews[0].label, label);
  assert.equal(store.graphReviews(graph.id)[0].label, label);
  assert.equal(store.verifyReviews().brokenAt, undefined);
  store.close();
});

test('P3 review: a trusted head is found in the chain, or reported missing after the end is cut', () => {
  const store = openStore(':memory:');
  const { graph, hash } = setup(store);
  const approve = store.reviewNode(graph.id, { nodeId: 'port', nodeSha256: hash('port'), decision: 'approve', reviewer: 'Mira' })[0].event;
  const reject = store.reviewNode(graph.id, { nodeId: 'port', nodeSha256: hash('port'), decision: 'reject', reviewer: 'Mira' })[0].event;
  assert.equal(store.verifyReviews(approve).trustedAt, 1);
  assert.equal(store.verifyReviews(reject).trustedAt, 2);
  assert.equal(store.verifyReviews(genesis).trustedAt, 0);
  assert.equal(store.verifyReviews('d'.repeat(64)).trustedAt, null);
  assert.equal('trustedAt' in store.verifyReviews(), false);
  // The same events without the last one: the earlier head is still in it, the later one is not.
  const events = [];
  let prev = genesis;
  for (const [seq, decision] of [[1, 'approve'], [2, 'reject']]) {
    const event = { seq, prev, sessionId: 's', party: 'p', nodeId: 'n', nodeSha256: 'a'.repeat(64), decision, reviewer: 'Mira', decidedAt: 't' };
    event.hash = eventHash(event);
    events.push(event);
    prev = event.hash;
  }
  assert.equal(checkChain(events.slice(0, 1), events[1].hash).trustedAt, null);
  assert.equal(checkChain(events.slice(0, 1), events[0].hash).trustedAt, 1);
  store.close();
});

test('P3 review: two processes appending at the same time keep one chain', async t => {
  const { path, keep } = await fileStore(t, 'ledger-p3-race-');
  const store = openStore(path);
  const { graph, hash } = setup(store);
  store.close();
  const child = reviewer => new Promise((resolve, reject) => {
    const script = `
      import { openStore } from './src/store.mjs';
      const store = openStore(process.env.DB);
      for (let index = 0; index < 25; index += 1) {
        store.reviewNode(process.env.GRAPH, { nodeId: 'port', nodeSha256: process.env.HASH, decision: index % 2 ? 'approve' : 'reject', reviewer: process.env.WHO });
      }
      store.close();
    `;
    execFile(process.execPath, ['--input-type=module', '--no-warnings', '-e', script],
      { env: { ...process.env, DB: path, GRAPH: graph.id, HASH: hash('port'), WHO: reviewer } },
      error => (error ? reject(error) : resolve()));
  });
  await Promise.all([child('Mira'), child('Tomas'), child('Ana')]);
  const check = keep(openStore(path));
  const verified = check.verifyReviews();
  assert.equal(verified.events, 75);
  assert.equal(verified.brokenAt, undefined);
});

test('P3 review 2: INSERT OR REPLACE cannot reuse a stored hash to remove the head', async t => {
  const { path, keep } = await fileStore(t, 'ledger-p3-hash-');
  const store = keep(openStore(path));
  const { graph, hash } = setup(store);
  store.reviewNode(graph.id, { nodeId: 'port', nodeSha256: hash('port'), decision: 'approve', reviewer: 'Mira' });
  const head = store.verifyReviews().head;
  const raw = keep(new DatabaseSync(path));
  assert.throws(() => raw.prepare(`INSERT OR REPLACE INTO review_events (seq, prev, hash, session_id, party, node_id, node_sha256, decision, label_json, reviewer, decided_at)
    VALUES (2, ?, ?, 's', 'p', 'n', 'h', 'reject', NULL, 'r', 't')`).run(head, head), /follow the head/u);
  assert.deepEqual({ ...store.verifyReviews() }, { events: 1, head });
});

test('P3 review 2: a damaged label is reported by event number, and an earlier break still comes first', async t => {
  const { path, keep } = await fileStore(t, 'ledger-p3-damaged-');
  const store = keep(openStore(path));
  const { graph, hash } = setup(store);
  for (const label of ['Port 7100 first', 'Port 7100 second', 'Port 7100 third']) {
    store.reviewNode(graph.id, { nodeId: 'port', nodeSha256: hash('port'), decision: 'edit', label, reviewer: 'Mira' });
  }
  const raw = keep(new DatabaseSync(path));
  raw.exec("DROP TRIGGER review_events_no_update; UPDATE review_events SET label_json = '{not json' WHERE seq = 3;");
  assert.deepEqual(store.verifyReviews(), { events: 3, brokenAt: 3 });
  // The fold leaves the damaged event out and shows the one before it.
  assert.equal(store.graphReviews(graph.id)[0].label, 'Port 7100 second');
  raw.exec("UPDATE review_events SET reviewer = 'Tomas' WHERE seq = 2;");
  assert.deepEqual(store.verifyReviews(), { events: 2, brokenAt: 2 });
});

test('P3 review 3: a stored label with a lone surrogate is a broken event, named by number', async t => {
  const { path, keep } = await fileStore(t, 'ledger-p3-surrogate-');
  const store = keep(openStore(path));
  const { graph, hash } = setup(store);
  for (const label of ['Port 7100 first', 'Port 7100 second']) {
    store.reviewNode(graph.id, { nodeId: 'port', nodeSha256: hash('port'), decision: 'edit', label, reviewer: 'Mira' });
  }
  const raw = keep(new DatabaseSync(path));
  raw.exec(`DROP TRIGGER review_events_no_update; UPDATE review_events SET label_json = '"\\ud800"' WHERE seq = 2;`);
  assert.deepEqual(store.verifyReviews(), { events: 2, brokenAt: 2 });
  assert.equal(store.graphReviews(graph.id)[0].label, 'Port 7100 first');
});

test('P3 review 4: a NUL and suffix added to a stored field is seen by verify', async t => {
  const { path, keep } = await fileStore(t, 'ledger-p3-nul-');
  const store = keep(openStore(path));
  const { graph, hash } = setup(store);
  store.reviewNode(graph.id, { nodeId: 'port', nodeSha256: hash('port'), decision: 'approve', reviewer: 'Mira' });
  store.reviewNode(graph.id, { nodeId: 'test', nodeSha256: hash('test'), decision: 'reject', reviewer: 'Mira' });
  const raw = keep(new DatabaseSync(path));
  raw.exec("DROP TRIGGER review_events_no_update; UPDATE review_events SET reviewer = 'Mira' || char(0) || ' and Tomas' WHERE seq = 2;");
  assert.deepEqual(store.verifyReviews(), { events: 2, brokenAt: 2 });
  // Bytes that are not UTF-8 are a broken event too.
  raw.exec("UPDATE review_events SET reviewer = CAST(x'ff' AS TEXT) WHERE seq = 1;");
  assert.deepEqual(store.verifyReviews(), { events: 1, brokenAt: 1 });
});

test('P3 review 5: a leading BOM added to a stored field, or a seq past 2^53, is a broken event', async t => {
  const { path, keep } = await fileStore(t, 'ledger-p3-bom-');
  const store = keep(openStore(path));
  const { graph, hash } = setup(store);
  store.reviewNode(graph.id, { nodeId: 'port', nodeSha256: hash('port'), decision: 'approve', reviewer: 'Mira' });
  store.reviewNode(graph.id, { nodeId: 'test', nodeSha256: hash('test'), decision: 'reject', reviewer: 'Mira' });
  const raw = keep(new DatabaseSync(path));
  raw.exec("DROP TRIGGER review_events_no_update; UPDATE review_events SET reviewer = char(65279) || reviewer WHERE seq = 2;");
  assert.deepEqual(store.verifyReviews(), { events: 2, brokenAt: 2 });
  raw.exec('UPDATE review_events SET seq = 9007199254740993 WHERE seq = 2;');
  assert.deepEqual(store.verifyReviews(), { events: 2, brokenAt: 2 });
});

test('P3 review 6: a label added to an approval, or removed from an edit, breaks the chain', async t => {
  const { path, keep } = await fileStore(t, 'ledger-p3-label-');
  const store = keep(openStore(path));
  const { graph, hash } = setup(store);
  store.reviewNode(graph.id, { nodeId: 'port', nodeSha256: hash('port'), decision: 'approve', reviewer: 'Mira' });
  store.reviewNode(graph.id, { nodeId: 'test', nodeSha256: hash('test'), decision: 'edit', label: 'Tomas tests on Monday', reviewer: 'Mira' });
  const head = store.verifyReviews().head;
  // The CHECK and triggers are bypassed by rebuilding the table without them.
  const raw = keep(new DatabaseSync(path));
  raw.exec(`
    PRAGMA writable_schema = OFF;
    CREATE TABLE loose AS SELECT * FROM review_events;
    DROP TABLE review_events;
    ALTER TABLE loose RENAME TO review_events;
    UPDATE review_events SET label_json = '"a label"' WHERE seq = 1;
  `);
  assert.deepEqual(store.verifyReviews(head), { events: 1, brokenAt: 1 });
  raw.exec("UPDATE review_events SET label_json = NULL WHERE seq = 1; UPDATE review_events SET label_json = NULL WHERE seq = 2;");
  assert.deepEqual(store.verifyReviews(head), { events: 2, brokenAt: 2 });
});

test('P3 review 6: a UTF-16 ledger verifies', async t => {
  const { path, keep } = await fileStore(t, 'ledger-p3-utf16-');
  const raw = new DatabaseSync(path);
  raw.exec("PRAGMA encoding = 'UTF-16le'; CREATE TABLE touch (x); DROP TABLE touch;");
  raw.close();
  const store = keep(openStore(path));
  const { graph, hash } = setup(store);
  store.reviewNode(graph.id, { nodeId: 'port', nodeSha256: hash('port'), decision: 'edit', label: 'Port 7100 · Mira', reviewer: 'Mira' });
  store.reviewNode(graph.id, { nodeId: 'test', nodeSha256: hash('test'), decision: 'approve', reviewer: 'Tomas' });
  const check = keep(new DatabaseSync(path));
  assert.equal(check.prepare('PRAGMA encoding').get().encoding, 'UTF-16le');
  const verified = store.verifyReviews();
  assert.equal(verified.events, 2);
  assert.equal(verified.brokenAt, undefined);
});
