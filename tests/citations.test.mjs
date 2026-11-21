// Card P2b (ADR-7b): version 3 packets cite P1c message keys or registered artifacts.
// Synthetic transcripts and made-up repositories only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { artifactId } from '../src/artifacts.mjs';
import { contextText } from '../src/context.mjs';
import { GraphInputError, nodeLines } from '../src/graph.mjs';
import { schemaVersion } from '../src/migrate.mjs';
import { InputError, openStore } from '../src/store.mjs';
import { citedLines } from '../public/console/model.mjs';
import { bearer, ledgerToken } from './ledger-auth.mjs';

const uuid = n => `0000000${n}-aaaa-4bbb-8ccc-00000000000${n}`;
const claude = turns => turns.map(([role, text], index) => JSON.stringify({ type: role, uuid: uuid(index + 1), message: { role, content: text } })).join('\n');
const transcript = claude([
  ['user', 'Leo: the adapter ships on port 4317 this Friday.'],
  ['assistant', 'Noted: port 4317, Friday.'],
  ['user', 'Ali reviews the outline on Thursday.'],
]);
const key = n => `u:${uuid(n)}`;

function setup(project = 'orbit') {
  const store = openStore(':memory:');
  const session = store.importTranscript({ provider: 'claude', source: 'leo.jsonl', transcript, project });
  const commit = store.registerArtifact({ project, kind: 'commit', repo: 'orbit-labs/adapter', ref: '4317abcdef0' });
  return { store, session, commit };
}

const packet = (sessionId, nodes, extra = {}) => ({ version: 3, sessionId, party: 'leo', nodes, edges: [], ...extra });

test('P2b: a version 3 graph cites keys and artifacts; the store resolves them to lines and rows', () => {
  const { store, session, commit } = setup();
  const graph = store.publishGraph(packet(session.id, [
    { id: 'port', kind: 'decision', label: 'Port 4317 on Friday', evidence: [{ artifact: commit.id }, { message: key(2) }, { message: key(1) }] },
    { id: 'review', kind: 'action', status: 'pending', label: 'Ali reviews the outline', evidence: [{ message: key(3) }] },
  ]));
  assert.deepEqual(graph.packet.nodes.find(node => node.id === 'port').evidence, [{ message: key(1) }, { message: key(2) }, { artifact: commit.id }], 'canonical order');
  assert.deepEqual(graph.citations, [
    { id: 'port', lines: [1, 2], artifacts: [{ id: commit.id, kind: 'commit', repo: 'orbit-labs/adapter', ref: '4317abcdef0' }] },
    { id: 'review', lines: [3], artifacts: [] },
  ]);
  assert.deepEqual(graph.quotedNodeIds.sort(), ['port', 'review'], 'G7 grounds on the resolved lines');
  // Order is not identity.
  const again = store.publishGraph(packet(session.id, [
    { id: 'review', kind: 'action', status: 'pending', label: 'Ali reviews the outline', evidence: [{ message: key(3) }] },
    { id: 'port', kind: 'decision', label: 'Port 4317 on Friday', evidence: [{ message: key(1) }, { artifact: commit.id }, { message: key(2) }] },
  ]));
  assert.equal(again.id, graph.id);
  assert.deepEqual(store.getGraph(graph.id), graph);
  // Readers get lines and artifacts without parsing keys.
  const port = graph.packet.nodes.find(node => node.id === 'port');
  assert.deepEqual(nodeLines(graph, port), [1, 2]);
  assert.deepEqual(citedLines(graph, port), [1, 2], 'the console reads the same lines');
  const text = contextText(graph, store.get(session.id));
  assert.match(text, /- port: Port 4317 on Friday \(L1 L2 commit orbit-labs\/adapter@4317abcdef0\)/u);
  const exported = store.exportGraphs([graph.id]);
  assert.equal(exported.nodes.find(node => node.ledger_node === 'port').source_location, 'L1, L2, commit orbit-labs/adapter@4317abcdef0');
  store.close();
});

test('P2b: unknown keys, unregistered artifacts and another project\'s artifacts are refused in fixed words', () => {
  const { store, session } = setup();
  const vela = store.registerArtifact({ project: 'vela', kind: 'pr', repo: 'orbit-labs/adapter', ref: '12' });
  const publish = evidence => () => store.publishGraph(packet(session.id, [{ id: 'port', kind: 'decision', label: 'Port 4317', evidence }]));
  const refusedKey = error => error instanceof GraphInputError && error.message === 'Evidence must cite stored messages of the source session by key.';
  const refusedArtifact = error => error instanceof GraphInputError && error.message === 'Evidence must cite an artifact registered in this project.';
  assert.throws(publish([{ message: key(9) }]), refusedKey);
  assert.throws(publish([{ message: 'l:1' }]), refusedKey, 'a line key that this session does not have');
  assert.throws(publish([{ artifact: 'e'.repeat(64) }]), refusedArtifact);
  assert.throws(publish([{ artifact: vela.id }]), refusedArtifact);
  for (const evidence of [[], [{ line: 1 }], [{ message: key(1), artifact: vela.id }], [{ message: 'x:1' }], [{ message: key(1) }, { message: key(1) }]]) {
    assert.throws(publish(evidence), /Invalid version 3 graph packet\./u, JSON.stringify(evidence));
  }
  // A version 3 node cannot use evidenceLines, and a version 2 node cannot use evidence.
  assert.throws(() => store.publishGraph(packet(session.id, [{ id: 'a', kind: 'goal', label: 'Ship', evidenceLines: [1] }])), /Invalid version 3/u);
  assert.throws(() => store.publishGraph({ ...packet(session.id, [{ id: 'a', kind: 'goal', label: 'Ship', evidence: [{ message: key(1) }] }]), version: 2 }), /Invalid version 2/u);
  store.close();
});

test('P2b: version 2 and version 3 graphs link to each other, meet in rooms and diff as party graphs', () => {
  const { store, session } = setup();
  const ali = store.importTranscript({ provider: 'claude', source: 'ali.jsonl', transcript: claude([['user', 'Ali offers review time on Thursday.']]), project: 'orbit' });
  const v2 = store.publishGraph({ version: 2, sessionId: ali.id, party: 'ali', nodes: [{ id: 'review-time', kind: 'offer', label: 'Review time Thursday', evidenceLines: [1] }], edges: [] });
  const first = store.publishGraph(packet(session.id, [{ id: 'review', kind: 'offer', label: 'Ali reviews the outline', evidence: [{ message: key(3) }] }],
    { links: [{ from: 'review', graph: v2.id, to: 'review-time', type: 'matches' }] }));
  const room = store.openRoom({ graphIds: [first.id, v2.id] });
  assert.equal(room.proposals.length, 1);
  const back = store.publishGraph({ version: 2, sessionId: ali.id, party: 'ali', nodes: [{ id: 'review-time', kind: 'offer', label: 'Review time Thursday', evidenceLines: [1] }], edges: [],
    links: [{ from: 'review-time', graph: first.id, to: 'review', type: 'matches' }] });
  assert.ok(back.id);
  const second = store.publishGraph(packet(session.id, [{ id: 'review', kind: 'offer', label: 'Ali reviews the outline', evidence: [{ message: key(1) }, { message: key(3) }] }]));
  const diff = store.diffGraphs(second.id, first.id);
  assert.deepEqual(diff.nodes.changed.map(node => [node.id, Object.keys(node.changes)]), [['review', ['evidence']]]);
  store.close();
});

test('P2b: artifacts are checked, registered once per project, and listed newest first with paging', () => {
  const store = openStore(':memory:');
  const add = input => store.registerArtifact(input);
  const commit = add({ kind: 'commit', repo: 'orbit-labs/adapter', ref: 'abc1234' });
  assert.deepEqual(Object.keys(commit), ['id', 'project', 'kind', 'repo', 'ref', 'createdAt']);
  assert.equal(commit.project, 'default');
  assert.equal(commit.id, artifactId({ project: 'default', kind: 'commit', repo: 'orbit-labs/adapter', ref: 'abc1234' }));
  assert.deepEqual(add({ kind: 'commit', repo: 'orbit-labs/adapter', ref: 'abc1234' }), commit, 'the same artifact twice is one row');
  const file = add({ project: 'orbit', kind: 'file', repo: 'gitlab-group/sub/adapter', ref: 'src/port.mjs' });
  const pr = add({ project: 'orbit', kind: 'pr', repo: 'orbit-labs/adapter', ref: '58' });
  assert.notEqual(add({ project: 'orbit', kind: 'commit', repo: 'orbit-labs/adapter', ref: 'abc1234' }).id, commit.id, 'another project, another ID');
  const refused = (input, message) => assert.throws(() => add(input), error => error instanceof InputError && error.message === message, JSON.stringify(input));
  refused({ kind: 'branch', repo: 'a/b', ref: 'main' }, 'kind must be commit, pr or file.');
  for (const repo of ['adapter', 'a/../b', '/a/b', 'a/b/', 'a b/c', 'a/' + 'b'.repeat(200), 7]) {
    refused({ kind: 'pr', repo, ref: '1' }, 'repo must be a repository path such as owner/name: letters, digits, . _ and -, at most 200 characters.');
  }
  for (const ref of ['ABC1234', 'abc12', 'g'.repeat(40), 'a'.repeat(65)]) refused({ kind: 'commit', repo: 'a/b', ref }, 'ref must be a commit hash of 7 to 64 lowercase hex characters.');
  for (const ref of ['0', '-1', '1.5', 'x', '12345678901']) refused({ kind: 'pr', repo: 'a/b', ref }, 'ref must be a pull request number.');
  for (const ref of ['', '/etc/passwd', '../x', 'a/./b', 'a//b', 'a\\b', `a${String.fromCodePoint(0x202e)}b`, 'x'.repeat(513)]) {
    refused({ kind: 'file', repo: 'a/b', ref }, 'ref must be a file path relative to the repository root, at most 512 characters, with no . or .. part.');
  }
  refused({ kind: 'pr', repo: 'a/b', ref: '1', extra: 1 }, 'An artifact has only project, kind, repo and ref.');
  refused({ project: 'Orbit', kind: 'pr', repo: 'a/b', ref: '1' }, 'project must be a slug of at most 64 lowercase letters, digits and single hyphens.');
  refused(null, 'An artifact must be a JSON object.');

  const ids = page => page.artifacts.map(artifact => artifact.id);
  const orbit = store.listArtifacts({ project: 'orbit', limit: 10 });
  assert.equal(orbit.artifacts.length, 3);
  assert.deepEqual(ids(orbit).slice(1), [pr.id, file.id]);
  const first = store.listArtifacts({ limit: 1 });
  const second = store.listArtifacts({ limit: 1, after: first.next });
  assert.notEqual(ids(first)[0], ids(second)[0]);
  assert.throws(() => store.listArtifacts({ limit: 1, after: 'f'.repeat(64) }), /Unknown cursor/u);
  store.close();
});

test('P2b: a version 3 file gains the artifacts table in place; the step is version 4', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-p2b-migrate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'ledger.sqlite');
  const first = openStore(path);
  const session = first.importTranscript({ provider: 'claude', source: 'leo.jsonl', transcript });
  first.close();
  // What a build of P1c (schema version 3) left: no artifacts table.
  const raw = new DatabaseSync(path);
  raw.exec('DROP TABLE artifacts; PRAGMA user_version = 3;');
  raw.close();
  assert.equal(schemaVersion, 4);
  const store = openStore(path);
  assert.equal(store.get(session.id).messages.length, 3);
  assert.ok(store.registerArtifact({ kind: 'pr', repo: 'orbit-labs/adapter', ref: '7' }).id);
  store.close();
  const check = new DatabaseSync(path);
  assert.equal(check.prepare('PRAGMA user_version').get().user_version, 4);
  assert.deepEqual(check.prepare('PRAGMA table_info(artifacts)').all().map(column => column.name), ['id', 'project_id', 'kind', 'repo', 'ref', 'created_at']);
  check.close();
});

async function startLedger(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-p2b-'));
  const database = join(directory, 'ledger.sqlite');
  const child = spawn(process.execPath, ['src/server.mjs'], { env: { ...process.env, PORT: '0', CONTEXT_LEDGER_DB: database }, stdio: ['ignore', 'pipe', 'ignore'] });
  const ended = once(child, 'exit').catch(() => {});
  let running = true;
  ended.then(() => { running = false; });
  t.after(async () => {
    if (running) {
      child.kill();
      await ended;
    }
    await rm(directory, { recursive: true, force: true });
  });
  let output = '';
  const port = await new Promise((resolve, reject) => {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = /listening at http:\/\/127\.0\.0\.1:(\d+)/u.exec(output);
      if (match) resolve(Number(match[1]));
    });
    ended.then(() => reject(new Error('The server exited before listening.')));
  });
  return { port, database, origin: `http://127.0.0.1:${port}`, auth: bearer(await ledgerToken(database, port)) };
}

function cli(args, ledger) {
  const child = spawn(process.execPath, ['src/cli.mjs', ...args], { env: { ...process.env, PORT: String(ledger.port), CONTEXT_LEDGER_DB: ledger.database }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  return once(child, 'exit').then(([code]) => ({ code, stdout, stderr }));
}

test('P2b: the artifact routes need the token and the local Origin; the CLI registers and lists', async t => {
  const ledger = await startLedger(t);
  const body = JSON.stringify({ project: 'orbit', kind: 'commit', repo: 'orbit-labs/adapter', ref: 'abc1234' });
  const post = headers => fetch(ledger.origin + '/api/artifacts', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
  assert.equal((await post({ Origin: ledger.origin })).status, 401, 'no token');
  assert.equal((await post({ ...ledger.auth, Origin: 'http://evil.test' })).status, 403, 'a foreign Origin');
  const created = await post({ ...ledger.auth, Origin: ledger.origin });
  assert.equal(created.status, 200);
  const { artifact } = await created.json();
  assert.equal(artifact.id, artifactId({ project: 'orbit', kind: 'commit', repo: 'orbit-labs/adapter', ref: 'abc1234' }));
  assert.equal((await fetch(ledger.origin + '/api/artifacts')).status, 401);
  const listed = await (await fetch(ledger.origin + '/api/artifacts?project=orbit', { headers: ledger.auth })).json();
  assert.deepEqual(listed.artifacts.map(row => row.id), [artifact.id]);
  assert.equal((await fetch(ledger.origin + '/api/artifacts?project=Orbit', { headers: ledger.auth })).status, 400);

  const added = await cli(['artifact', 'add', 'pr', 'orbit-labs/adapter', '58', '--project', 'orbit'], ledger);
  assert.equal(added.code, 0, added.stderr);
  assert.equal(JSON.parse(added.stdout).artifact.ref, '58');
  const bad = await cli(['artifact', 'add', 'commit', 'orbit-labs/adapter', 'nothex'], ledger);
  assert.deepEqual({ code: bad.code, stderr: bad.stderr }, { code: 1, stderr: 'ref must be a commit hash of 7 to 64 lowercase hex characters.\n' });
  const list = await cli(['artifact', 'list', '--project', 'orbit'], ledger);
  assert.equal(list.code, 0, list.stderr);
  assert.deepEqual(JSON.parse(list.stdout).artifacts.map(row => row.kind), ['pr', 'commit']);
  for (const args of [['artifact'], ['artifact', 'add', 'pr', 'a/b'], ['artifact', 'list', 'extra'], ['artifact', 'add', 'pr', 'a/b', '1', '--project', 'Bad']]) {
    assert.equal((await cli(args, ledger)).code, 1, args.join(' '));
  }
});

// P2b review (Codex round 1).
import { citedArtifacts, createModel } from '../public/console/model.mjs';

test('P2b review: the same key or line in another session is a change, for the diff and the console', () => {
  const store = openStore(':memory:');
  // Two sessions whose first turns have the same record UUID (another transcript reusing it).
  const first = store.importTranscript({ provider: 'claude', source: 'a.jsonl', transcript: claude([['user', 'Leo: port 4317.']]), project: 'orbit' });
  const second = store.importTranscript({ provider: 'claude', source: 'b.jsonl', transcript: claude([['user', 'Leo: port 4400 instead.']]), project: 'orbit' });
  const v3 = sessionId => packet(sessionId, [{ id: 'port', kind: 'decision', label: 'The port', evidence: [{ message: key(1) }] }]);
  const older = store.publishGraph(v3(first.id));
  const newer = store.publishGraph(v3(second.id));
  assert.deepEqual(store.diffGraphs(newer.id, older.id).nodes.changed.map(node => [node.id, Object.keys(node.changes)]), [['port', ['evidence']]]);
  const v2 = sessionId => ({ version: 2, sessionId, party: 'ali', nodes: [{ id: 'port', kind: 'decision', label: 'The port', evidenceLines: [1] }], edges: [] });
  const olderLines = store.publishGraph(v2(first.id));
  const newerLines = store.publishGraph(v2(second.id));
  assert.deepEqual(store.diffGraphs(newerLines.id, olderLines.id).nodes.changed.map(node => [node.id, Object.keys(node.changes)]), [['port', ['evidenceLines']]]);
  // Same session, same citations: no change.
  assert.deepEqual(store.diffGraphs(older.id, older.id).nodes.changed, []);

  // The console: a republish in another session with the same keys changes the node, and an
  // answer to the old question does not carry over to it.
  const model = createModel();
  const question = sessionId => ({ id: sessionId.slice(0, 8) + 'q'.repeat(56), packet: { version: 3, sessionId, party: 'ali',
    nodes: [{ id: 'which-port', kind: 'question', status: 'open', to: 'leo', label: 'Which port?', evidence: [{ message: key(1) }] }], edges: [] } });
  const asked = question(first.id);
  model.apply({ graph: asked, provider: 'claude', at: 1 });
  model.apply({ graph: { id: 'l'.repeat(64), packet: { version: 2, sessionId: 'f'.repeat(64), party: 'leo', nodes: [{ id: 'port', kind: 'decision', label: 'Port 4317', evidenceLines: [1] }],
    edges: [], links: [{ from: 'port', graph: asked.id, to: 'which-port', type: 'answers' }] } }, provider: 'codex', at: 2 });
  assert.equal(model.answeredByLink().size, 1);
  const moved = model.apply({ graph: question(second.id), provider: 'claude', at: 3 });
  assert.deepEqual(moved.changed.length, 1, 'the node changed');
  assert.equal(model.answeredByLink().size, 0, 'the old answer does not answer the new question');
  store.close();
});

test('P2b review: the export keeps artifacts as records, and the console passes them to the panel', () => {
  const { store, session } = setup();
  const file = store.registerArtifact({ project: 'orbit', kind: 'file', repo: 'orbit-labs/adapter', ref: 'docs/a, b@c.md' });
  const graph = store.publishGraph(packet(session.id, [{ id: 'doc', kind: 'goal', label: 'Write the doc', evidence: [{ artifact: file.id }] }]));
  const exported = store.exportGraphs([graph.id]).nodes[0];
  assert.deepEqual(exported.ledger_artifacts, [{ id: file.id, kind: 'file', repo: 'orbit-labs/adapter', ref: 'docs/a, b@c.md' }]);
  assert.deepEqual(citedArtifacts(graph, graph.packet.nodes[0]), [{ kind: 'file', repo: 'orbit-labs/adapter', ref: 'docs/a, b@c.md' }]);
  assert.deepEqual(citedArtifacts({ ...graph, citations: [{ id: 'doc', artifacts: [{ kind: 1 }] }] }, graph.packet.nodes[0]), [], 'odd rows are left out');
  const model = createModel();
  model.apply({ graph, provider: 'claude', at: 1 });
  const [column] = model.graph().columns;
  assert.deepEqual(column.nodes[0].evidenceLines, []);
  assert.deepEqual(column.nodes[0].artifacts, [{ kind: 'file', repo: 'orbit-labs/adapter', ref: 'docs/a, b@c.md' }]);
  store.close();
});

test('P2b review: ledger artifact list pages with --limit and --after', async t => {
  const ledger = await startLedger(t);
  for (const ref of ['1', '2', '3']) assert.equal((await cli(['artifact', 'add', 'pr', 'orbit-labs/adapter', ref], ledger)).code, 0);
  const first = JSON.parse((await cli(['artifact', 'list', '--limit', '2'], ledger)).stdout);
  assert.deepEqual([first.artifacts.map(row => row.ref), typeof first.next], [['3', '2'], 'string']);
  const rest = JSON.parse((await cli(['artifact', 'list', '--limit', '2', '--after', first.next], ledger)).stdout);
  assert.deepEqual([rest.artifacts.map(row => row.ref), rest.next], [['1'], null]);
  for (const args of [['--limit', '0'], ['--limit', '101'], ['--after', 'x'], ['--limit', '1', '--limit', '2']]) {
    assert.equal((await cli(['artifact', 'list', ...args], ledger)).code, 1, args.join(' '));
  }
});
