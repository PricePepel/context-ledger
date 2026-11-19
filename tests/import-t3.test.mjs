import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { openStore } from '../src/store.mjs';
import { openT3Copy, T3ImportError } from '../src/t3code.mjs';
import { tokenFileFor } from '../src/token.mjs';
import { bearer, ledgerToken, restrictToOwner } from './ledger-auth.mjs';

// D3: a T3 Code v0.1.10 database (schema head 96) built at test time from the table
// definitions in the pinned source (pingdotgg/t3code 7d32075, migrations 055,
// OrchestrationV2/Foundation and 081). Every thread here is synthetic.

const execute = promisify(execFile);

// apps/server/src/persistence/Migrations.ts at the pinned commit.
const migrationNames = [
  'OrchestrationEvents', 'OrchestrationCommandReceipts', 'CheckpointDiffBlobs', 'ProviderSessionRuntime', 'Projections',
  'ProjectionThreadSessionRuntimeModeColumns', 'ProjectionThreadMessageAttachments', 'ProjectionThreadActivitySequence',
  'ProviderSessionRuntimeMode', 'ProjectionThreadsRuntimeMode', 'OrchestrationThreadCreatedRuntimeMode',
  'ProjectionThreadsInteractionMode', 'ProjectionThreadProposedPlans', 'ProjectionThreadProposedPlanImplementation',
  'ProjectionTurnsSourceProposedPlan', 'CanonicalizeModelSelections', 'ProjectionThreadsArchivedAt',
  'ProjectionThreadsArchivedAtIndex', 'ProjectionSnapshotLookupIndexes', 'AuthAccessManagement',
  'AuthSessionClientMetadata', 'AuthSessionLastConnectedAt', 'ProjectionThreadShellSummary',
  'BackfillProjectionThreadShellSummary', 'CleanupInvalidProjectionPendingApprovals', 'CanonicalizeModelSelectionOptions',
  'ProviderSessionRuntimeInstanceId', 'ProjectionThreadSessionInstanceId', 'ProjectionThreadDetailOrderingIndexes',
  'ProjectionThreadShellArchiveIndexes', 'AuthAuthorizationScopes', 'AuthPairingProofKeyThumbprint',
  'ProjectionThreadsSettled', 'ProjectionThreadsSnoozed', 'ProjectionThreadTitleRegeneration', 'ProjectionThreadsPinned',
  'ProjectionTurnsKeysetIndex', 'ProjectionThreadsPinOrderKey', 'ProjectionProjectsDefaultThreadEnvMode',
  'ProjectionProjectFaviconPath', 'AuthSessionClientConnection', 'ProjectionThreadLinkedPullRequest',
  'ProjectionThreadsUnsettledAt', 'ClearAutomaticProjectModelDefaults', 'ProjectionProjectsAutoPull',
  'RepairAutomaticSettlementTimestamps', 'ProjectionProjectIcon', 'ProjectionThreadBranchPullRequest',
  'ProjectionThreadsActiveOrderKey', 'ProjectionThreadPullRequests', 'ProjectionThreadMessageContext',
  'ProjectionThreadTitleState', 'PullRequestFilesViewed', 'ProjectionThreadsAutoSettleDisabledAt', 'OrchestrationV2',
  'RemoveRedundantProjectionIndexes', 'ScheduledTaskWebhooks', 'WebhookRelayDeliveries', 'McpAppModelContext',
  'ThreadSnapshotWindowIndexes', 'PullRequestReviewGuides', 'ThreadFailureLookupIndex', 'DropUnusedV1Projections',
  'CanonicalizeThreadPullRequestLinks', 'CodexUsageNativeTurnIndex', 'RepairClientSettlementTimestamps', 'WebhookDedupe',
  'ShellStopRequestIndex', 'ThreadMessageSearch', 'PeerLinks', 'PeerLinkFence', 'WaitingLinkRequestIndex',
  'ActiveTurnItemIndexes', 'ExcludeAttachmentPlaceholdersFromSearch', 'SubagentDeliveryState',
  'ProjectionProjectsPinArchive', 'RepairBooleanSettledOverride', 'DropOrchestrationEventCorrelationIndex',
  'DelegatedRecoveryIndexes', 'ScheduledTaskThreadMode', 'ProjectionMessageSearchText', 'TurnItemConversationIndex',
  'CommandReadIndexes', 'LastExecutedRunIndex', 'TurnItemCounts', 'QueuedTurnInputIndex', 'ProjectionProjectsCustomTitle',
  'TurnItemTypeStatusIndex', 'ShellThreadReadIndexes', 'AuthConnectDevices', 'AuthConnectDeniedRequests',
  'QueuedTurnInputIndexJsonValid', 'ProviderTurnAttemptIndex', 'TurnItemMessageOrdinalIndex', 'TurnItemInlineWorkOutput',
  'RepairStaleTitleRegeneration',
];
assert.equal(migrationNames.length, 96);

// The tables the importer reads, with the columns migrations 055, Foundation and 081 leave.
const schema = `
  CREATE TABLE effect_sql_migrations (
    migration_id integer PRIMARY KEY NOT NULL,
    created_at datetime NOT NULL DEFAULT current_timestamp,
    name VARCHAR(255) NOT NULL
  );
  CREATE TABLE orchestration_v2_projection_threads (
    thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, default_provider TEXT NOT NULL,
    runtime_mode TEXT NOT NULL, interaction_mode TEXT NOT NULL, active_provider_thread_id TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT, deleted_at TEXT,
    payload_json TEXT NOT NULL, provider_instance_id TEXT
  );
  CREATE TABLE orchestration_v2_projection_runs (
    run_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, ordinal INTEGER NOT NULL, provider TEXT NOT NULL,
    provider_thread_id TEXT, status TEXT NOT NULL, requested_at TEXT NOT NULL, completed_at TEXT,
    payload_json TEXT NOT NULL, provider_instance_id TEXT
  );
  CREATE TABLE orchestration_v2_projection_run_attempts (
    attempt_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, run_id TEXT NOT NULL, attempt_ordinal INTEGER NOT NULL,
    root_node_id TEXT NOT NULL, provider TEXT NOT NULL, provider_thread_id TEXT NOT NULL, provider_turn_id TEXT,
    status TEXT NOT NULL, payload_json TEXT NOT NULL, provider_instance_id TEXT
  );
  CREATE TABLE orchestration_v2_projection_provider_threads (
    provider_thread_id TEXT PRIMARY KEY, thread_id TEXT, owner_node_id TEXT, provider TEXT NOT NULL,
    provider_session_id TEXT, status TEXT NOT NULL, first_run_ordinal INTEGER, last_run_ordinal INTEGER,
    updated_at TEXT NOT NULL, payload_json TEXT NOT NULL, driver TEXT, provider_instance_id TEXT
  );
  CREATE TABLE orchestration_v2_projection_messages (
    message_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, run_id TEXT, node_id TEXT, role TEXT NOT NULL,
    streaming INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload_json TEXT NOT NULL,
    search_text TEXT
  );
`;

const at = minute => `2026-11-10T10:${String(minute).padStart(2, '0')}:00.000Z`;

/** A synthetic thread with one run per agent driver given, and its messages. */
function thread(id, { drivers = ['claudeAgent'], instance = 'claudeAgent', messages = [], deletedAt = null, minute = 0, lineage } = {}) {
  return { id, drivers, instance, messages, deletedAt, minute, lineage };
}

function buildCopy(path, threads, { head = 96, rename = null, dropMessageColumn = false, mutate } = {}) {
  const database = new DatabaseSync(path);
  database.exec('PRAGMA journal_mode = WAL');
  database.exec(dropMessageColumn ? schema.replace('streaming INTEGER NOT NULL, ', '') : schema);
  const migration = database.prepare('INSERT INTO effect_sql_migrations (migration_id, name) VALUES (?, ?)');
  const names = [...migrationNames];
  if (head === 98) names.push('ThreadSnapshotLookupIndexes', 'ActiveShellIndexIndexes');
  names.slice(0, head).forEach((name, index) => migration.run(index + 1, index + 1 === rename?.id ? rename.name : name));

  const insertThread = database.prepare(`INSERT INTO orchestration_v2_projection_threads VALUES
    (?, 'project-1', ?, ?, 'full-access', 'default', NULL, ?, ?, NULL, ?, ?, ?)`);
  const insertRun = database.prepare(`INSERT INTO orchestration_v2_projection_runs VALUES
    (?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?)`);
  const insertAttempt = database.prepare(`INSERT INTO orchestration_v2_projection_run_attempts VALUES
    (?, ?, ?, 1, ?, ?, ?, NULL, 'completed', '{}', ?)`);
  const insertProviderThread = database.prepare(`INSERT INTO orchestration_v2_projection_provider_threads VALUES
    (?, ?, NULL, ?, NULL, 'idle', 1, 1, ?, '{}', ?, ?)`);
  const insertMessage = dropMessageColumn ? null : database.prepare(`INSERT INTO orchestration_v2_projection_messages VALUES
    (?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL)`);

  for (const item of threads) {
    const created = at(item.minute);
    insertThread.run(item.id, `Synthetic ${item.id}`, item.instance, created, created, item.deletedAt,
      JSON.stringify({ id: item.id, providerInstanceId: item.instance, ...(item.lineage ? { lineage: item.lineage } : {}) }), item.instance);
    item.drivers.forEach((spec, index) => {
      // A driver, or { run, attempt } when a run's second attempt used another provider thread.
      const driver = typeof spec === 'string' ? spec : spec.run;
      const runId = `${item.id}-run-${index + 1}`;
      const providerThreadId = driver === 'missing-run' ? null : `${item.id}-pt-${index + 1}`;
      const model = driver === 'codex' ? 'gpt-synthetic' : 'claude-synthetic';
      insertRun.run(runId, item.id, index + 1, item.instance, providerThreadId, created, created,
        JSON.stringify({ id: runId, modelSelection: { instanceId: item.instance, model } }), item.instance);
      if (providerThreadId === null) return;
      insertAttempt.run(`${runId}-attempt`, item.id, runId, `${runId}-root`, item.instance, providerThreadId, item.instance);
      if (driver === 'missing-provider-thread') return;
      insertProviderThread.run(providerThreadId, item.id, item.instance, created, driver === 'null-driver' ? null : driver, item.instance);
      if (typeof spec === 'string') return;
      insertAttempt.run(`${runId}-attempt-2`, item.id, runId, `${runId}-root`, item.instance, `${providerThreadId}-b`, item.instance);
      insertProviderThread.run(`${providerThreadId}-b`, item.id, item.instance, created, spec.attempt, item.instance);
    });
    item.messages.forEach((message, index) => {
      const id = message.id ?? `${item.id}-m${String(index + 1).padStart(2, '0')}`;
      const createdAt = message.createdAt ?? at(item.minute + index + 1);
      const payload = message.raw ?? JSON.stringify({
        id, threadId: item.id, role: message.role, text: message.text,
        ...(message.createdBy === undefined ? {} : { createdBy: message.createdBy }),
        attachments: [], streaming: Boolean(message.streaming),
      });
      const run = message.run === null ? null : `${item.id}-run-${message.run ?? 1}`;
      insertMessage.run(id, item.id, run, message.role, message.streaming ? 1 : 0, createdAt, createdAt, payload);
    });
  }
  if (mutate) database.exec(mutate);
  database.close();
  return path;
}

function workspace(t) {
  const directory = mkdtempSync(join(tmpdir(), 'ledger-t3-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

const conversation = [
  { role: 'user', text: 'Plan the synthetic rollout for the demo service.', createdBy: 'user' },
  { role: 'assistant', text: 'Step one: stage the synthetic build.', createdBy: 'agent' },
  { role: 'user', text: 'Then run the synthetic smoke test.' },
  { role: 'assistant', text: 'The synthetic smoke test passed.' },
];

function requestsFor(path, threadId) {
  const copy = openT3Copy(path);
  try {
    return copy.threads(threadId).map(item => ({ id: item.id, ...copy.importRequest(item) }));
  } finally {
    copy.close();
  }
}

function importInto(store, request) {
  // P1c: stored messages carry their stable keys; these tests compare the rest.
  const session = store.get(store.importTranscript(request).id);
  return { ...session, messages: session.messages.map(({ key, ...message }) => message) };
}

test('a Claude Code thread imports as claude with each message on the line of its position', t => {
  const path = buildCopy(join(workspace(t), 'copy.sqlite'), [thread('thread-claude', { messages: conversation })]);
  const [request] = requestsFor(path);
  assert.equal(request.provider, 'claude');
  assert.equal(request.source, 't3-thread-claude.jsonl');

  const store = openStore(':memory:');
  t.after(() => store.close());
  const session = importInto(store, request);
  assert.equal(session.provider, 'claude');
  assert.equal(session.source, 't3-thread-claude.jsonl');
  assert.deepEqual(session.messages, conversation.map((message, index) => ({ role: message.role, text: message.text, line: index + 1 })));
});

test('a Codex thread on a custom instance imports as codex; the instance name is not the agent', t => {
  const path = buildCopy(join(workspace(t), 'copy.sqlite'), [
    thread('thread-codex', { drivers: ['codex'], instance: 'codex_personal', messages: conversation }),
    // An instance can be named after another agent; only the driver decides.
    thread('thread-named-codex', { drivers: ['cursor'], instance: 'codex', messages: conversation, minute: 20 }),
  ]);
  const [codex, cursor] = requestsFor(path);
  assert.equal(codex.provider, 'codex');
  assert.deepEqual(cursor, { id: 'thread-named-codex', refusal: 'This T3 thread was run by an agent other than Claude Code or Codex.' });

  const store = openStore(':memory:');
  t.after(() => store.close());
  const session = importInto(store, codex);
  assert.equal(session.provider, 'codex');
  assert.deepEqual(session.messages, conversation.map((message, index) => ({ role: message.role, text: message.text, line: index + 1 })));
});

test('Codex user text shaped like injected context is still imported', t => {
  const envelope = '<environment_context>synthetic</environment_context>';
  const path = buildCopy(join(workspace(t), 'copy.sqlite'), [
    thread('thread-codex', { drivers: ['codex'], messages: [{ role: 'user', text: envelope }, { role: 'assistant', text: 'Noted.' }] }),
  ]);
  const store = openStore(':memory:');
  t.after(() => store.close());
  const session = importInto(store, requestsFor(path)[0]);
  assert.deepEqual(session.messages.map(message => message.text), [envelope, 'Noted.']);
});

test('system, generated, streaming and empty messages are left out and later lines do not move', t => {
  const path = buildCopy(join(workspace(t), 'copy.sqlite'), [thread('thread-mixed', {
    messages: [
      { role: 'system', text: 'Synthetic system prompt.' },
      { role: 'user', text: 'First real question.' },
      { role: 'user', text: 'Pull request #1 was updated.', createdBy: 'agent' },
      { role: 'user', text: 'Scheduled synthetic notice.', createdBy: 'system' },
      { role: 'assistant', text: 'Half an ans', streaming: true },
      { role: 'assistant', text: '   ' },
      { role: 'assistant', text: 'The real answer.' },
    ],
  })]);
  const store = openStore(':memory:');
  t.after(() => store.close());
  const session = importInto(store, requestsFor(path)[0]);
  assert.deepEqual(session.messages, [
    { role: 'user', text: 'First real question.', line: 2 },
    { role: 'assistant', text: 'The real answer.', line: 7 },
  ]);
});

test('messages come back in T3 order: created_at, then message_id', t => {
  const path = buildCopy(join(workspace(t), 'copy.sqlite'), [thread('thread-order', {
    messages: [
      { id: 'm-c', role: 'assistant', text: 'third', createdAt: at(30) },
      { id: 'm-b', role: 'user', text: 'second', createdAt: at(10) },
      { id: 'm-a', role: 'user', text: 'first', createdAt: at(10) },
    ],
  })]);
  const store = openStore(':memory:');
  t.after(() => store.close());
  const session = importInto(store, requestsFor(path)[0]);
  assert.deepEqual(session.messages.map(message => [message.text, message.line]), [['first', 1], ['second', 2], ['third', 3]]);
});

test('threads whose agent is another, several, unrecorded or absent are refused', t => {
  const path = buildCopy(join(workspace(t), 'copy.sqlite'), [
    thread('t-cursor', { drivers: ['cursor'], messages: conversation, minute: 1 }),
    thread('t-both', { drivers: ['claudeAgent', 'codex'], messages: conversation, minute: 2 }),
    thread('t-lost', { drivers: ['claudeAgent', 'missing-provider-thread'], messages: conversation, minute: 3 }),
    thread('t-null', { drivers: ['null-driver'], messages: conversation, minute: 4 }),
    thread('t-none', { drivers: [], messages: conversation, minute: 5 }),
    thread('t-queued', { drivers: ['missing-run'], messages: conversation, minute: 6 }),
    thread('t-quiet', { drivers: ['codex'], messages: [{ role: 'system', text: 'only a system prompt' }], minute: 7 }),
  ]);
  assert.deepEqual(requestsFor(path), [
    { id: 't-cursor', refusal: 'This T3 thread was run by an agent other than Claude Code or Codex.' },
    { id: 't-both', refusal: 'This T3 thread was run by more than one agent. Only threads run by one agent are imported.' },
    { id: 't-lost', refusal: 'This T3 thread has a run whose agent is not recorded.' },
    { id: 't-null', refusal: 'This T3 thread has a run whose agent is not recorded.' },
    { id: 't-none', refusal: 'This T3 thread has no recorded agent run, so its agent is unknown.' },
    { id: 't-queued', refusal: 'This T3 thread has a run whose agent is not recorded.' },
    { id: 't-quiet', refusal: 'This T3 thread has no finished user or assistant messages.' },
  ]);
});

test('a message whose payload is not JSON refuses its thread', t => {
  const path = buildCopy(join(workspace(t), 'copy.sqlite'), [
    thread('t-bad', { messages: [{ role: 'user', text: 'fine' }, { role: 'assistant', raw: '{not json' }] }),
  ]);
  assert.deepEqual(requestsFor(path), [{ id: 't-bad', refusal: 'A message in this T3 thread could not be read.' }]);
});

test('an unknown layout is refused with one fixed sentence that names no path', t => {
  const directory = workspace(t);
  const layout = 'This T3 Code database layout is not supported. The importer reads copies made by T3 Code v0.1.10 (schema 96) only.';
  const cases = [
    ['schema-81.sqlite', { head: 81 }, layout],
    ['schema-98.sqlite', { head: 98 }, layout],
    ['renamed.sqlite', { rename: { id: 96, name: 'SomethingElse' } }, layout],
    ['no-streaming.sqlite', { dropMessageColumn: true }, layout],
  ];
  for (const [name, options, message] of cases) {
    const threads = options.dropMessageColumn ? [] : [thread('thread-1', { messages: conversation })];
    const path = buildCopy(join(directory, name), threads, options);
    assert.throws(() => openT3Copy(path), error => error instanceof T3ImportError && error.message === message && !error.message.includes(name));
  }

  const empty = join(directory, 'empty.sqlite');
  new DatabaseSync(empty).close();
  writeFileSync(join(directory, 'not-sqlite.sqlite'), 'synthetic text, not a database\n');
  const blank = new DatabaseSync(join(directory, 'blank.sqlite'));
  blank.exec('CREATE TABLE unrelated (a)');
  blank.close();
  assert.throws(() => openT3Copy(empty), { message: 'This file is not a SQLite database.' });
  assert.throws(() => openT3Copy(join(directory, 'not-sqlite.sqlite')), { message: 'This file is not a SQLite database.' });
  assert.throws(() => openT3Copy(join(directory, 'blank.sqlite')), { message: layout });
  assert.throws(() => openT3Copy(join(directory, 'missing.sqlite')), { message: 'Cannot read the T3 Code database copy.' });
  assert.throws(() => openT3Copy(directory), { message: 'Cannot read the T3 Code database copy.' });
});

test('T3 live database path is refused before it is opened, and a copy is not changed', t => {
  const directory = workspace(t);
  mkdirSync(join(directory, 'userdata'));
  const live = buildCopy(join(directory, 'userdata', 'statev2.sqlite'), [thread('thread-1', { messages: conversation })]);
  assert.throws(() => openT3Copy(live), { message: 'This looks like T3 Code\'s own database. Quit T3 Code, copy statev2.sqlite to another folder, and import the copy.' });
  assert.throws(() => openT3Copy(join(directory, 'USERDATA', 'StateV2.sqlite')), { message: /own database/ });

  const copy = buildCopy(join(directory, 'statev2.sqlite'), [thread('thread-1', { messages: conversation })]);
  const before = readFileSync(copy);
  requestsFor(copy);
  assert.deepEqual(readFileSync(copy), before);
});

test('equal threads stay two sessions, a second import gives the same IDs, deleted threads are skipped', t => {
  const path = buildCopy(join(workspace(t), 'copy.sqlite'), [
    thread('thread-a', { messages: conversation, minute: 1 }),
    thread('thread-b', { messages: conversation, minute: 2 }),
    thread('thread-gone', { messages: conversation, minute: 3, deletedAt: at(50) }),
  ]);
  const store = openStore(':memory:');
  t.after(() => store.close());
  const first = requestsFor(path).map(request => store.importTranscript(request).id);
  const second = requestsFor(path).map(request => store.importTranscript(request).id);
  assert.equal(first.length, 2);
  assert.notEqual(first[0], first[1]);
  assert.deepEqual(second, first);

  const copy = openT3Copy(path);
  try {
    assert.throws(() => copy.threads('thread-gone'), { message: 'T3 thread not found in this copy.' });
    assert.throws(() => copy.threads('thread-unknown'), { message: 'T3 thread not found in this copy.' });
    assert.deepEqual(copy.threads('thread-b').map(item => item.id), ['thread-b']);
  } finally {
    copy.close();
  }
});

test('a thread ID of another form is refused without being shown', t => {
  const odd = 'thread' + String.fromCodePoint(0x202e) + 'evil';
  const path = buildCopy(join(workspace(t), 'copy.sqlite'), [thread(odd, { messages: conversation })]);
  assert.deepEqual(requestsFor(path), [{ id: null, refusal: 'This T3 thread ID has an unsupported form.' }]);
});

// P1e: the database behind each test ledger, by port. The CLI finds the token from PORT
// and CONTEXT_LEDGER_DB, as it does for a real ledger.
const ledgerDatabases = new Map();
const ledgerHeaders = async port => bearer(await ledgerToken(ledgerDatabases.get(port), port));

async function startLedger(t) {
  const directory = mkdtempSync(join(tmpdir(), 'ledger-t3-server-'));
  const child = spawn(process.execPath, ['src/server.mjs'], {
    env: { ...process.env, PORT: '0', CONTEXT_LEDGER_DB: join(directory, 'ledger.sqlite') },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  // Stop the server before removing its database, which Windows keeps locked while it runs.
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await once(child, 'exit');
    }
    rmSync(directory, { recursive: true, force: true });
  });
  let output = '';
  for await (const chunk of child.stdout) {
    output += chunk;
    const match = output.match(/listening at http:\/\/127\.0\.0\.1:(\d+)/u);
    if (match) {
      const port = Number(match[1]);
      ledgerDatabases.set(port, join(directory, 'ledger.sqlite'));
      return port;
    }
  }
  throw new Error('Server exited before listening.');
}

// node:sqlite prints an ExperimentalWarning on Node 22; it is not part of the CLI's output.
const withoutWarning = text => text
  .split('\n')
  .filter(line => !/^\(node:\d+\) ExperimentalWarning: SQLite/u.test(line) && !line.startsWith('(Use `node --trace-warnings'))
  .join('\n');
const noLedger = join(tmpdir(), 'context-ledger-no-ledger', 'none.sqlite');
const cli = (port, ...args) => execute(process.execPath, ['src/cli.mjs', 'import-t3', ...args], {
  env: { ...process.env, PORT: String(port), CONTEXT_LEDGER_DB: ledgerDatabases.get(port) ?? noLedger },
}).then(result => ({ ...result, stderr: withoutWarning(result.stderr) }), error => {
  error.stderr = withoutWarning(error.stderr);
  throw error;
});

test('the CLI imports a copy through the running ledger and prints escaped JSON', async t => {
  const bidi = String.fromCodePoint(0x202e);
  const bell = String.fromCodePoint(7);
  const messages = [{ role: 'user', text: `Synthetic ${bidi}reversed${bell} request.` }, { role: 'assistant', text: 'Done.' }];
  const path = buildCopy(join(workspace(t), 'copy of store.sqlite'), [
    thread('thread-one', { messages, minute: 1 }),
    thread('thread-two', { drivers: ['codex'], messages: conversation, minute: 2 }),
    thread('thread-cursor', { drivers: ['cursor'], messages: [{ role: 'user', text: 'Cursor secret synthetic text.' }], minute: 3 }),
  ]);
  const port = await startLedger(t);

  const listed = await cli(port, path, '--list');
  assert.equal(listed.stderr, '');
  assert.doesNotMatch(listed.stdout, new RegExp(`[${bidi}${bell}]`, 'u'));
  assert.deepEqual(JSON.parse(listed.stdout), [
    { thread: 'thread-one', agent: 'claude', models: ['claude-synthetic'], messages: 2, title: 'Synthetic thread-one' },
    { thread: 'thread-two', agent: 'codex', models: ['gpt-synthetic'], messages: 4, title: 'Synthetic thread-two' },
    { thread: 'thread-cursor', refused: 'This T3 thread was run by an agent other than Claude Code or Codex.' },
  ]);

  const run = await cli(port, path).then(result => ({ code: 0, ...result }), error => error);
  assert.equal(run.code, 1);
  assert.equal(run.stderr, '');
  assert.doesNotMatch(run.stdout, new RegExp(`[${bidi}${bell}]|Cursor secret|copy of store`, 'u'));
  const output = JSON.parse(run.stdout);
  assert.deepEqual(output.refused, [{ thread: 'thread-cursor', refused: 'This T3 thread was run by an agent other than Claude Code or Codex.' }]);
  assert.deepEqual(output.imported.map(item => [item.thread, item.agent, item.session.provider, item.session.source, item.session.messageCount]), [
    ['thread-one', 'claude', 'claude', 't3-thread-one.jsonl', 2],
    ['thread-two', 'codex', 'codex', 't3-thread-two.jsonl', 4],
  ]);

  const stored = await fetch(`http://127.0.0.1:${port}/api/sessions/${output.imported[0].session.id}`, { headers: await ledgerHeaders(port) })
    .then(response => response.json());
  // P1c: each stored message also has its stable key.
  assert.deepEqual(stored.session.messages.map(({ key, ...message }) => message), messages.map((message, index) => ({ ...message, line: index + 1 })));
  assert.ok(stored.session.messages.every(message => /^h:[0-9a-f]{32}$/u.test(message.key)));

  const one = await cli(port, path, '--thread', 'thread-two');
  assert.deepEqual(JSON.parse(one.stdout).imported.map(item => item.session.id), [output.imported[1].session.id]);
});

test('CLI refusals are fixed sentences on stderr with exit code 1', async t => {
  const directory = workspace(t);
  const path = buildCopy(join(directory, 'copy.sqlite'), [
    thread('thread-cursor', { drivers: ['cursor'], messages: conversation }),
  ]);
  const old = buildCopy(join(directory, 'old-secret-name.sqlite'), [thread('thread-1', { messages: conversation })], { head: 81 });
  const failure = (...args) => cli(1, ...args).then(() => assert.fail('expected exit 1'), error => error);

  const cases = [
    [[path, '--thread', 'thread-cursor'], 'This T3 thread was run by an agent other than Claude Code or Codex.'],
    [[path, '--thread', 'thread-missing'], 'T3 thread not found in this copy.'],
    [[path, '--thread', '../etc'], 'A T3 thread ID is 1 to 128 letters, digits, hyphens or underscores.'],
    [[old, '--list'], 'This T3 Code database layout is not supported. The importer reads copies made by T3 Code v0.1.10 (schema 96) only.'],
    [[join(directory, 'nothing-here.sqlite'), '--list'], 'Cannot read the T3 Code database copy.'],
  ];
  for (const [args, message] of cases) {
    const error = await failure(...args);
    assert.equal(error.code, 1);
    assert.equal(error.stdout, '');
    assert.equal(error.stderr.trim(), message);
  }
  for (const args of [[], [path, path], [path, '--bogus']]) {
    const error = await failure(...args);
    assert.match(error.stderr, /^Usage: /u);
    assert.doesNotMatch(error.stderr, /bogus/u);
  }

  const good = buildCopy(join(directory, 'good.sqlite'), [thread('thread-1', { messages: conversation })]);
  // P1e: with no token for the port, the transcript is not sent anywhere.
  const unreachable = await failure(good);
  assert.equal(unreachable.stderr.trim(), 'Cannot read the Context Ledger access token. Start the ledger with npm start, and run this with the same PORT and CONTEXT_LEDGER_DB as the ledger.');
});

// Review round 1 (Codex, of 6384054): one regression test or more per finding.

test('attribution is per run: an unlinked run with an answer, an attempt on another agent, an answer without a run', t => {
  const answerInRun2 = [...conversation.slice(0, 2), { role: 'user', text: 'Again.', run: 2 }, { role: 'assistant', text: 'Unattributed.', run: 2 }];
  const path = buildCopy(join(workspace(t), 'copy.sqlite'), [
    thread('t-mixed', { drivers: ['claudeAgent', 'missing-run'], messages: answerInRun2, minute: 1 }),
    thread('t-attempt-switch', { drivers: [{ run: 'claudeAgent', attempt: 'codex' }], messages: conversation, minute: 2 }),
    thread('t-orphan', { messages: [...conversation, { role: 'assistant', text: 'From nowhere.', run: null }], minute: 3 }),
    // A queued run holds only the person's message; nothing in it needs an agent.
    thread('t-queued-ok', { drivers: ['claudeAgent', 'missing-run'], messages: [...conversation, { role: 'user', text: 'Queued.', run: 2 }], minute: 4 }),
  ]);
  const [mixed, attempt, orphan, queued] = requestsFor(path);
  assert.equal(mixed.refusal, 'This T3 thread has a run whose agent is not recorded.');
  assert.equal(attempt.refusal, 'This T3 thread was run by more than one agent. Only threads run by one agent are imported.');
  assert.equal(orphan.refusal, 'This T3 thread has a run whose agent is not recorded.');
  assert.equal(queued.provider, 'claude');
});

test('the layout gate checks the whole migration history, table kinds, column types and keys', t => {
  const directory = workspace(t);
  const layout = 'This T3 Code database layout is not supported. The importer reads copies made by T3 Code v0.1.10 (schema 96) only.';
  const messagesWithoutKey = `
    ALTER TABLE orchestration_v2_projection_messages RENAME TO old_messages;
    CREATE TABLE orchestration_v2_projection_messages (
      message_id TEXT, thread_id TEXT NOT NULL, run_id TEXT, node_id TEXT, role TEXT NOT NULL,
      streaming INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload_json TEXT NOT NULL,
      search_text TEXT
    );
    INSERT INTO orchestration_v2_projection_messages SELECT * FROM old_messages;
    DROP TABLE old_messages;`;
  const cases = {
    'gap.sqlite': { mutate: 'DELETE FROM effect_sql_migrations WHERE migration_id = 50' },
    'renamed-50.sqlite': { rename: { id: 50, name: 'ProjectionThreadPullRequestz' } },
    'view.sqlite': {
      mutate: `ALTER TABLE orchestration_v2_projection_messages RENAME TO real_messages;
        CREATE VIEW orchestration_v2_projection_messages AS SELECT * FROM real_messages;`,
    },
    'no-key.sqlite': { mutate: messagesWithoutKey },
    'retyped.sqlite': {
      mutate: `ALTER TABLE orchestration_v2_projection_provider_threads RENAME COLUMN driver TO old_driver;
        ALTER TABLE orchestration_v2_projection_provider_threads ADD COLUMN driver BLOB;`,
    },
  };
  for (const [name, options] of Object.entries(cases)) {
    const path = buildCopy(join(directory, name), [thread('thread-1', { messages: conversation })], options);
    assert.throws(() => openT3Copy(path), { message: layout }, name);
  }
  const good = buildCopy(join(directory, 'good.sqlite'), [thread('thread-1', { messages: conversation })]);
  openT3Copy(good).close();
});

test('reading leaves only empty SQLite side files beside the copy, and a copy with a pending -wal is refused', t => {
  const directory = workspace(t);
  const copy = buildCopy(join(directory, 'copy.sqlite'), [thread('thread-1', { messages: conversation })]);
  const before = readFileSync(copy);
  requestsFor(copy);
  requestsFor(copy);
  assert.deepEqual(readFileSync(copy), before);
  const entries = readdirSync(directory).sort();
  assert.ok(entries.every(entry => ['copy.sqlite', 'copy.sqlite-shm', 'copy.sqlite-wal'].includes(entry)), entries.join(','));
  if (entries.includes('copy.sqlite-wal')) assert.equal(statSync(join(directory, 'copy.sqlite-wal')).size, 0);

  const pending = buildCopy(join(directory, 'pending.sqlite'), [thread('thread-1', { messages: conversation })]);
  writeFileSync(pending + '-wal', 'synthetic unsaved frames');
  assert.throws(() => openT3Copy(pending), { message: 'This copy has unsaved changes in a -wal file beside it. Quit T3 Code, then copy statev2.sqlite again.' });
});

test('the 8 MiB limit is counted on the encoded request, with multibyte text and escapes, before any request', t => {
  const directory = workspace(t);
  const prefix = 'Synthetic ' + String.fromCodePoint(0xe9, 0x4e2d, 0x1f600) + ' "quoted" \\ ' + String.fromCodePoint(7) + ' ';
  const build = (name, fill) => buildCopy(join(directory, name), [
    thread('thread-big', { messages: [{ role: 'user', text: prefix + 'a'.repeat(fill) }] }),
  ]);
  const [{ id: smallId, ...small }] = requestsFor(build('small.sqlite', 0));
  const room = 8 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(small));
  const [{ id: exactId, ...exact }] = requestsFor(build('exact.sqlite', room));
  assert.equal(Buffer.byteLength(JSON.stringify(exact)), 8 * 1024 * 1024);
  assert.deepEqual([smallId, exactId, exact.provider], ['thread-big', 'thread-big', 'claude']);
  const over = build('over.sqlite', room + 1);
  assert.deepEqual(requestsFor(over), [{ id: 'thread-big', refusal: 'This T3 thread is larger than the 8 MiB import limit.' }]);
  const copy = openT3Copy(over);
  try {
    assert.deepEqual(copy.threads().map(item => copy.summary(item)), [{
      thread: 'thread-big', agent: 'claude', models: ['claude-synthetic'],
      refused: 'This T3 thread is larger than the 8 MiB import limit.', title: 'Synthetic thread-big',
    }]);
  } finally {
    copy.close();
  }

  const store = openStore(':memory:');
  t.after(() => store.close());
  assert.equal(store.get(store.importTranscript(exact).id).messages[0].text, prefix + 'a'.repeat(room));
});

test('a subagent thread is refused and a fork imports only its own messages', t => {
  const path = buildCopy(join(workspace(t), 'copy.sqlite'), [
    thread('thread-child', {
      messages: conversation, minute: 1,
      lineage: { parentThreadId: 'thread-parent', relationshipToParent: 'subagent', rootThreadId: 'thread-parent' },
    }),
    thread('thread-fork', {
      messages: conversation.slice(2), minute: 2,
      lineage: { parentThreadId: 'thread-parent', relationshipToParent: 'fork', rootThreadId: 'thread-parent' },
    }),
  ]);
  const [child, fork] = requestsFor(path);
  assert.deepEqual(child, { id: 'thread-child', refusal: 'This T3 thread is a subagent\'s. Import the thread that started it.' });
  const store = openStore(':memory:');
  t.after(() => store.close());
  assert.deepEqual(importInto(store, fork).messages.map(message => message.line), [1, 2]);
});

test('a later snapshot of a thread is a new session whose earlier lines are unchanged', t => {
  const directory = workspace(t);
  const first = buildCopy(join(directory, 'first.sqlite'), [thread('thread-1', { messages: conversation })]);
  const second = buildCopy(join(directory, 'second.sqlite'), [thread('thread-1', { messages: [...conversation, { role: 'user', text: 'One more.' }] })]);
  const store = openStore(':memory:');
  t.after(() => store.close());
  const before = importInto(store, requestsFor(first)[0]);
  const after = importInto(store, requestsFor(second)[0]);
  assert.notEqual(after.id, before.id);
  assert.deepEqual(after.messages.slice(0, before.messages.length), before.messages);
});

/** A loopback stand-in for the ledger that answers each import with the next reply. */
async function fakeLedger(t, replies) {
  const seen = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    seen.push(body);
    // P1e: every import carries the ledger's token.
    assert.equal(request.headers.authorization, `Bearer ${'T'.repeat(43)}`);
    const reply = replies[seen.length - 1];
    if (reply === 'drop') return request.socket.destroy();
    if (reply === 'drop-body') {
      // The headers say success, then the connection ends inside the body.
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '1000' });
      response.write('{"session":');
      return setTimeout(() => request.socket.destroy(), 50);
    }
    response.writeHead(reply.status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(typeof reply.body === 'function' ? reply.body(body) : reply.body));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const directory = workspace(t);
  const database = join(directory, 'ledger.sqlite');
  const tokenFile = tokenFileFor(database, port);
  writeFileSync(tokenFile, JSON.stringify({ port, token: 'T'.repeat(43) }) + '\n', { mode: 0o600 });
  restrictToOwner(tokenFile);
  ledgerDatabases.set(port, database);
  return { port, seen };
}

// What the store answers: the session ID is the hash of provider and transcript (src/store.mjs).
const sessionFor = body => ({
  session: {
    id: createHash('sha256').update(`${body.provider}\0`).update(body.transcript).digest('hex'),
    provider: body.provider, source: body.source, title: 'x', messageCount: 1,
  },
});

test('the CLI prints only its own sentences for server errors and checks what the server returns', async t => {
  const path = buildCopy(join(workspace(t), 'copy.sqlite'), [thread('thread-1', { messages: conversation })]);
  const echo = 'C:\\Users\\someone\\secret\\statev2.sqlite thread-1' + String.fromCodePoint(0x2028) + 'text';
  const cases = [
    [{ status: 400, body: { error: echo } }, 'Context Ledger refused this T3 thread.'],
    [{ status: 400, body: { error: 'No supported conversation messages found.' } }, 'No supported conversation messages found.'],
    [{ status: 413, body: { error: echo } }, 'This T3 thread is larger than the 8 MiB import limit.'],
    [{ status: 500, body: { error: echo } }, 'Context Ledger returned HTTP 500.'],
    [{ status: 200, body: { session: { id: 'not-an-id', provider: 'claude', source: 't3-thread-1.jsonl' } } }, 'Context Ledger returned an unexpected response.'],
    [{ status: 200, body: body => ({ session: { ...sessionFor(body).session, provider: 'codex' } }) }, 'Context Ledger returned an unexpected response.'],
    [{ status: 200, body: body => ({ session: { ...sessionFor(body).session, id: 'c'.repeat(64) } }) }, 'Context Ledger returned an unexpected response.'],
  ];
  for (const [reply, message] of cases) {
    const { port } = await fakeLedger(t, [reply]);
    const error = await cli(port, path, '--thread', 'thread-1').then(() => assert.fail('expected exit 1'), failure => failure);
    assert.equal(error.code, 1);
    assert.equal(error.stderr.trim(), message);
    assert.equal(error.stdout, '');
  }
});

test('a dropped connection keeps the imports already confirmed and marks the rest unknown', async t => {
  const path = buildCopy(join(workspace(t), 'copy.sqlite'), [
    thread('thread-a', { messages: conversation, minute: 1 }),
    thread('thread-b', { messages: conversation, minute: 2 }),
    thread('thread-c', { messages: conversation, minute: 3 }),
  ]);
  const { port, seen } = await fakeLedger(t, [{ status: 200, body: sessionFor }, 'drop']);
  const error = await cli(port, path).then(() => assert.fail('expected exit 1'), failure => failure);
  assert.equal(error.code, 1);
  assert.equal(seen.length, 2);
  assert.match(error.stderr, /^Cannot reach Context Ledger on port \d+\. Start it with npm start\. Run the same import again/u);
  const output = JSON.parse(error.stdout);
  assert.deepEqual(output.imported.map(item => item.thread), ['thread-a']);
  assert.deepEqual(output.refused, []);
  assert.deepEqual(output.unknown, [
    { thread: 'thread-b', unknown: 'The connection to Context Ledger was lost; this thread may not be imported.' },
    { thread: 'thread-c', unknown: 'Not tried after the connection was lost.' },
  ]);
});

// Review round 2 (Codex, of b039917).

test('an unimported assistant row without a run does not block an attributable thread', t => {
  const path = buildCopy(join(workspace(t), 'copy.sqlite'), [thread('thread-1', {
    messages: [
      ...conversation,
      { role: 'assistant', text: 'still typing', streaming: true, run: null },
      { role: 'assistant', text: '  ', run: null },
    ],
  })]);
  const [request] = requestsFor(path);
  assert.equal(request.provider, 'claude');
});

test('a primary key over more than the pinned column is refused', t => {
  const path = buildCopy(join(workspace(t), 'copy.sqlite'), [thread('thread-1', { messages: conversation })], {
    mutate: `
      ALTER TABLE orchestration_v2_projection_messages RENAME TO old_messages;
      CREATE TABLE orchestration_v2_projection_messages (
        message_id TEXT, thread_id TEXT NOT NULL, run_id TEXT, node_id TEXT, role TEXT NOT NULL,
        streaming INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload_json TEXT NOT NULL,
        search_text TEXT, PRIMARY KEY (message_id, thread_id)
      );
      INSERT INTO orchestration_v2_projection_messages SELECT * FROM old_messages;
      DROP TABLE old_messages;`,
  });
  assert.throws(() => openT3Copy(path), { message: /layout is not supported/u });
});

test('a session the store already held under another source name is accepted', async t => {
  const path = buildCopy(join(workspace(t), 'copy.sqlite'), [thread('thread-1', { messages: conversation })]);
  const { port } = await fakeLedger(t, [{ status: 200, body: body => ({ session: { ...sessionFor(body).session, source: 'renamed.jsonl' } }) }]);
  const result = await cli(port, path, '--thread', 'thread-1');
  assert.deepEqual(JSON.parse(result.stdout).imported.map(item => item.session.source), ['renamed.jsonl']);
});

test('a connection that drops inside a success body is unknown, not refused', async t => {
  const path = buildCopy(join(workspace(t), 'copy.sqlite'), [
    thread('thread-a', { messages: conversation, minute: 1 }),
    thread('thread-b', { messages: conversation, minute: 2 }),
  ]);
  const { port, seen } = await fakeLedger(t, ['drop-body']);
  const error = await cli(port, path).then(() => assert.fail('expected exit 1'), failure => failure);
  assert.equal(error.code, 1);
  assert.equal(seen.length, 1);
  const output = JSON.parse(error.stdout);
  assert.deepEqual(output.imported, []);
  assert.deepEqual(output.refused, []);
  assert.deepEqual(output.unknown.map(item => item.thread), ['thread-a', 'thread-b']);
});
