import { closeSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Reads T3 Code threads from a copy of T3's database (statev2.sqlite) that the person
// made. The layout is pinned to one release, learned from its public source:
// pingdotgg/t3code v0.1.10, commit 7d32075e3757ded707914e2450c3e392a9665765, whose
// schema head is migration 96. Any other layout is refused (docs/evals.md, D3).

/** A refusal the person can act on. Its message is a fixed sentence with no input in it. */
export class T3ImportError extends Error {}

export const t3Release = Object.freeze({
  version: 'v0.1.10',
  commit: '7d32075e3757ded707914e2450c3e392a9665765',
  schemaHead: 96,
});

/** The ledger's import request limit (src/server.mjs), checked here before any request is sent. */
export const maxImportBytes = 8 * 1024 * 1024;

const unsupportedLayout = 'This T3 Code database layout is not supported. The importer reads copies made by T3 Code v0.1.10 (schema 96) only.';
const unreadable = 'Cannot read the T3 Code database copy.';

// apps/server/src/persistence/Migrations.ts at the pinned commit: migration n is entry n - 1.
// A copy must record exactly these, so a build with a different history is refused.
const migrationManifest = [
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

// Every column read below with its declared type, and the primary key it must be, as
// created by migrations 055, OrchestrationV2/Foundation and 081. Each must be a table.
const requiredColumns = {
  effect_sql_migrations: { migration_id: ['INTEGER', 1], name: ['VARCHAR(255)'] },
  orchestration_v2_projection_threads: {
    thread_id: ['TEXT', 1], title: ['TEXT'], created_at: ['TEXT'], deleted_at: ['TEXT'], payload_json: ['TEXT'],
  },
  orchestration_v2_projection_runs: { run_id: ['TEXT', 1], thread_id: ['TEXT'], provider_thread_id: ['TEXT'], payload_json: ['TEXT'] },
  orchestration_v2_projection_run_attempts: { attempt_id: ['TEXT', 1], thread_id: ['TEXT'], run_id: ['TEXT'], provider_thread_id: ['TEXT'] },
  orchestration_v2_projection_provider_threads: { provider_thread_id: ['TEXT', 1], driver: ['TEXT'] },
  orchestration_v2_projection_messages: {
    message_id: ['TEXT', 1], thread_id: ['TEXT'], run_id: ['TEXT'], role: ['TEXT'], streaming: ['INTEGER'],
    created_at: ['TEXT'], payload_json: ['TEXT'],
  },
};

// T3 driver kinds (packages/contracts/src/model.ts) for the two agents the ledger stores.
const providerForDriver = new Map([['claudeAgent', 'claude'], ['codex', 'codex']]);

export const threadIdPattern = /^[A-Za-z0-9_-]{1,128}$/u;

const refusals = {
  noRun: 'This T3 thread has no recorded agent run, so its agent is unknown.',
  unknownAgent: 'This T3 thread has a run whose agent is not recorded.',
  manyAgents: 'This T3 thread was run by more than one agent. Only threads run by one agent are imported.',
  otherAgent: 'This T3 thread was run by an agent other than Claude Code or Codex.',
  subagent: 'This T3 thread is a subagent\'s. Import the thread that started it.',
  badMessage: 'A message in this T3 thread could not be read.',
  noMessages: 'This T3 thread has no finished user or assistant messages.',
  tooLarge: 'This T3 thread is larger than the 8 MiB import limit.',
};

function isLiveStore(path) {
  // A name check only: T3 keeps its database at <base-dir>/userdata/statev2.sqlite
  // (apps/server/src/config.ts). A link to it under another name is not caught.
  let real = path;
  try {
    real = realpathSync(path);
  } catch {
    // Checked again by the open below.
  }
  return [path, real].some(candidate => basename(candidate).toLowerCase() === 'statev2.sqlite'
    && basename(dirname(candidate)).toLowerCase() === 'userdata');
}

function hasSqliteHeader(path) {
  const header = Buffer.alloc(16);
  const descriptor = openSync(path, 'r');
  try {
    return readSync(descriptor, header, 0, 16, 0) === 16 && header.toString('latin1') === 'SQLite format 3\0';
  } finally {
    closeSync(descriptor);
  }
}

// A -wal file with content beside the copy means T3 (or a copy of its files) was still
// writing: the copy is then not one snapshot. An empty one is left by an earlier read.
function hasPendingWal(path) {
  try {
    return statSync(path + '-wal').size > 0;
  } catch (error) {
    // Only a missing file means no -wal; any other error is reported as an unreadable copy.
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function checkLayout(database) {
  const kind = database.prepare('SELECT type FROM sqlite_schema WHERE name = ?');
  const info = database.prepare('SELECT name, type, pk FROM pragma_table_info(?)');
  for (const [table, columns] of Object.entries(requiredColumns)) {
    if (kind.get(table)?.type !== 'table') throw new T3ImportError(unsupportedLayout);
    const rows = info.all(table);
    const present = new Map(rows.map(row => [row.name, row]));
    for (const [column, [type]] of Object.entries(columns)) {
      const row = present.get(column);
      if (!row || row.type.toUpperCase() !== type) throw new T3ImportError(unsupportedLayout);
    }
    // The whole primary key must be the one pinned column, so its values are unique.
    const key = rows.filter(row => row.pk > 0).map(row => row.name);
    const pinnedKey = Object.entries(columns).filter(([, [, pk]]) => pk === 1).map(([column]) => column);
    if (key.length !== 1 || key[0] !== pinnedKey[0]) throw new T3ImportError(unsupportedLayout);
  }
  const recorded = database.prepare('SELECT migration_id AS id, name FROM effect_sql_migrations ORDER BY migration_id').all();
  if (recorded.length !== migrationManifest.length
    || recorded.some((row, index) => row.id !== index + 1 || row.name !== migrationManifest[index])) {
    throw new T3ImportError(unsupportedLayout);
  }
}

/** Opens a copy of T3's database read-only and checks its layout. Throws T3ImportError. */
export function openT3Copy(path) {
  if (typeof path !== 'string' || path.length === 0) throw new T3ImportError('Choose a copy of the T3 Code database.');
  const absolute = resolve(path);
  if (isLiveStore(absolute)) {
    throw new T3ImportError('This looks like T3 Code\'s own database. Quit T3 Code, copy statev2.sqlite to another folder, and import the copy.');
  }
  let database;
  try {
    if (!statSync(absolute).isFile()) throw new T3ImportError(unreadable);
    if (!hasSqliteHeader(absolute)) throw new T3ImportError('This file is not a SQLite database.');
    if (hasPendingWal(absolute)) {
      throw new T3ImportError('This copy has unsaved changes in a -wal file beside it. Quit T3 Code, then copy statev2.sqlite again.');
    }
    database = new DatabaseSync(absolute, { readOnly: true });
    database.exec('PRAGMA query_only = ON');
    checkLayout(database);
  } catch (error) {
    database?.close();
    if (error instanceof T3ImportError) throw error;
    throw new T3ImportError(unreadable);
  }
  return reader(database);
}

// One JSONL line per message, in the mapped provider's format, so the existing parser imports it.
function messageLine(provider, role, text) {
  if (provider === 'claude') return JSON.stringify({ type: role, message: { role, content: text } });
  const blockType = role === 'user' ? 'input_text' : 'output_text';
  return JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'message',
      role,
      content: [{ type: blockType, text }],
      // A user.* kind tells the Codex parser this block is the person's text, not injected context.
      ...(role === 'user' ? { internal_chat_message_metadata_passthrough: { content_item_kinds: ['user.t3_message'] } } : {}),
    },
  });
}

// T3's own rule for a conversation message (apps/server/src/orchestration-v2/messageSearchIndex.ts):
// finished, and either the assistant's or a user-role message the person wrote (createdBy user or absent).
function isConversation(row, payload) {
  if (row.streaming !== 0) return false;
  if (typeof payload?.text !== 'string' || !payload.text.trim()) return false;
  if (row.role === 'assistant') return true;
  return row.role === 'user' && (payload.createdBy === undefined || payload.createdBy === 'user');
}

// Bytes a string adds inside the JSON-encoded transcript field of the import request.
const encodedBytes = text => Buffer.byteLength(JSON.stringify(text)) - 2;

function reader(database) {
  const listThreads = database.prepare(`
    SELECT thread_id AS id, title, payload_json AS payload FROM orchestration_v2_projection_threads
    WHERE deleted_at IS NULL ORDER BY created_at ASC, thread_id ASC
  `);
  const findThread = database.prepare(`
    SELECT thread_id AS id, title, payload_json AS payload FROM orchestration_v2_projection_threads
    WHERE thread_id = ? AND deleted_at IS NULL
  `);
  const runs = database.prepare('SELECT run_id AS id, provider_thread_id AS providerThreadId FROM orchestration_v2_projection_runs WHERE thread_id = ?');
  const attempts = database.prepare(`
    SELECT run_id AS runId, provider_thread_id AS providerThreadId FROM orchestration_v2_projection_run_attempts
    WHERE thread_id = ?
  `);
  const providerThread = database.prepare('SELECT driver FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id = ?');
  const assistantRows = database.prepare(`
    SELECT run_id AS runId, role, streaming, payload_json AS payload FROM orchestration_v2_projection_messages
    WHERE thread_id = ? AND role = 'assistant'
  `);
  const models = database.prepare(`
    SELECT DISTINCT json_extract(payload_json, '$.modelSelection.model') AS model
    FROM orchestration_v2_projection_runs
    WHERE thread_id = ? AND json_valid(payload_json)
      AND json_type(payload_json, '$.modelSelection.model') = 'text'
    ORDER BY model
  `);
  // T3 reads a thread's messages in this order (ProjectionStore.ts). message_id is the key.
  const messages = database.prepare(`
    SELECT role, streaming, payload_json AS payload FROM orchestration_v2_projection_messages
    WHERE thread_id = ? ORDER BY created_at ASC, message_id ASC
  `);

  // Attribution is per run: every provider thread a run or its attempts used must name a
  // driver, and every assistant message must belong to a run with one. Else unknown.
  const agentOf = threadId => {
    const providerThreadsByRun = new Map();
    for (const run of runs.all(threadId)) {
      providerThreadsByRun.set(run.id, new Set(run.providerThreadId === null ? [] : [run.providerThreadId]));
    }
    for (const attempt of attempts.all(threadId)) {
      if (!providerThreadsByRun.has(attempt.runId)) providerThreadsByRun.set(attempt.runId, new Set());
      if (attempt.providerThreadId !== null) providerThreadsByRun.get(attempt.runId).add(attempt.providerThreadId);
    }
    const drivers = new Set();
    let unknown = false;
    for (const ids of providerThreadsByRun.values()) {
      for (const id of ids) {
        const driver = providerThread.get(id)?.driver;
        if (typeof driver === 'string') drivers.add(driver);
        else unknown = true;
      }
    }
    // Only answers that are imported need an agent; one that cannot be parsed counts, and
    // refuses the thread later anyway.
    for (const row of assistantRows.iterate(threadId)) {
      let payload;
      try {
        payload = JSON.parse(row.payload);
      } catch {
        payload = { text: 'unreadable' };
      }
      if (!isConversation(row, payload)) continue;
      if (row.runId === null || !(providerThreadsByRun.get(row.runId)?.size > 0)) unknown = true;
    }
    if (providerThreadsByRun.size === 0) return { refusal: refusals.noRun };
    if (unknown) return { refusal: refusals.unknownAgent };
    if (drivers.size === 0) return { refusal: refusals.noRun };
    if (drivers.size > 1) return { refusal: refusals.manyAgents };
    const provider = providerForDriver.get([...drivers][0]);
    return provider ? { provider } : { refusal: refusals.otherAgent };
  };

  const describe = ({ id, title, payload }) => {
    if (typeof id !== 'string' || !threadIdPattern.test(id)) {
      return { id: null, refusal: 'This T3 thread ID has an unsupported form.' };
    }
    let thread;
    try {
      thread = JSON.parse(payload);
    } catch {
      return { id, refusal: unreadable };
    }
    // Subagent threads live inside their parent's view in T3 (orchestrationV2.ts, isListedThreadLineage).
    if (thread?.lineage?.relationshipToParent === 'subagent') return { id, refusal: refusals.subagent };
    return { id, title: typeof title === 'string' ? title : '', ...agentOf(id) };
  };

  const transcript = thread => {
    const source = `t3-${thread.id}.jsonl`;
    const marker = JSON.stringify({ t3: { threadId: thread.id } });
    // The request is {"provider":…,"source":…,"transcript":…}; count it as the lines are added.
    let bytes = Buffer.byteLength(JSON.stringify({ provider: thread.provider, source, transcript: '' })) + encodedBytes(marker + '\n');
    const lines = [];
    let count = 0;
    for (const row of messages.iterate(thread.id)) {
      let payload;
      try {
        payload = JSON.parse(row.payload);
      } catch {
        return { refusal: refusals.badMessage };
      }
      // A placeholder keeps line n on the thread's message n.
      const line = isConversation(row, payload) ? messageLine(thread.provider, row.role, payload.text) : '{}';
      if (line !== '{}') count += 1;
      bytes += encodedBytes(line + '\n');
      if (bytes > maxImportBytes) return { refusal: refusals.tooLarge };
      lines.push(line);
    }
    if (count === 0) return { refusal: refusals.noMessages };
    // The thread ID keeps two threads with the same text apart; the parser skips this line.
    lines.push(marker);
    return { messageCount: count, source, transcript: lines.join('\n') + '\n' };
  };

  // A SQLite error mid-read (a damaged copy) becomes the fixed sentence, never its own text.
  const guarded = read => (...args) => {
    try {
      return read(...args);
    } catch (error) {
      if (error instanceof T3ImportError) throw error;
      throw new T3ImportError(unreadable);
    }
  };

  return {
    /** Threads in the copy, or the one named, with their agent or the reason they are refused. */
    threads: guarded(threadId => {
      if (threadId === undefined) return listThreads.all().map(describe);
      const row = findThread.get(threadId);
      if (!row) throw new T3ImportError('T3 thread not found in this copy.');
      return [describe(row)];
    }),

    /** What --list prints for one described thread. */
    summary: guarded(thread => {
      if (thread.refusal) return { thread: thread.id, refused: thread.refusal };
      const built = transcript(thread);
      return {
        thread: thread.id,
        agent: thread.provider,
        models: models.all(thread.id).map(row => row.model),
        ...(built.refusal ? { refused: built.refusal } : { messages: built.messageCount }),
        title: thread.title,
      };
    }),

    /** The import request for one described thread: { provider, source, transcript } or { refusal }. */
    importRequest: guarded(thread => {
      if (thread.refusal) return { refusal: thread.refusal };
      const built = transcript(thread);
      if (built.refusal) return built;
      return { provider: thread.provider, source: built.source, transcript: built.transcript };
    }),

    close() {
      database.close();
    },
  };
}
