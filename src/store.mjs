import { createHash, randomBytes } from 'node:crypto';
import { constants, mkdirSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { basename, dirname, win32 } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { graphContext } from './context.mjs';
import { ConflictError, InputError } from './errors.mjs';
import { diffGraphs } from './diff.mjs';
import { graphPrefixLength, nodeLinkBundle } from './export.mjs';
import { mountArtifacts } from './artifacts.mjs';
import { mountReviews, nodeHashes } from './reviews.mjs';
import { canonicalPacket, isPartyGraph, resolveCitations, validateGraph } from './graph.mjs';
import { groundNodes } from './grounding.mjs';
import { defaultProject, migrate, refuseNewerSchema, schemaVersion } from './migrate.mjs';
import { mountRooms, roomsSchema } from './rooms.mjs';

export { ConflictError, InputError };

const secureDeleteModes = ['OFF', 'ON', 'FAST'];
// Journal modes in which a committed delete leaves no copy of the old pages behind.
// WAL keeps them in the main file until a checkpoint and in older frames, and PERSIST
// keeps the journal file, so a delete is refused there. The ledger never sets either.
const deleteJournalModes = new Set(['delete', 'truncate', 'memory', 'off']);

// A summary names its project by slug; project IDs stay inside the database.
const summaryColumns = 's.id, s.provider, s.source, s.title, s.message_count AS messageCount, p.slug AS project';
const sessionRows = 'sessions s LEFT JOIN projects p ON p.id = s.project_id';
const projectPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
// A record UUID as Claude Code writes it. Anything else gets a line-hash key.
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const codexContextKinds = new Set([
  'agents_md.instructions',
  'environments.environment_context',
  'additional_content.codex_apps_open_page',
  'skills.selected_skill_instructions',
]);


export function isProvider(value) {
  return value === 'claude' || value === 'codex';
}

/** A project slug: at most 64 lowercase letters, digits and single inner hyphens. */
export function isProjectSlug(value) {
  return typeof value === 'string' && value.length <= 64 && projectPattern.test(value);
}

export const projectSlugRule = 'project must be a slug of at most 64 lowercase letters, digits and single hyphens.';

function isCodexContext(text, kind) {
  if (codexContextKinds.has(kind)) return true;
  if (typeof kind === 'string' && kind.startsWith('user.')) return false;

  // Older rollouts omit per-block metadata, so check complete reserved envelopes.
  const value = text.trim();
  return /^<(environment_context|user_instructions|turn_aborted)>[\s\S]*<\/\1>$/u.test(value)
    || /^# AGENTS\.md instructions(?: for [^\r\n]+)?\r?\n\r?\n<INSTRUCTIONS>[\s\S]*<\/INSTRUCTIONS>$/u.test(value);
}

// Card I3: an agent path is short; anything else is shown as unknown.
const agentPath = value => (typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : 'unknown');

/**
 * A Codex multi-agent message between two agents, such as /root and /root/worker. Codex
 * writes it in two forms: the model-facing response_item of type agent_message, with
 * input_text and encrypted_content blocks, and the rollout's own inter_agent_communication
 * record, with plain content and an optional encrypted_content. Only plain text is kept;
 * encrypted content is never imported. null means the record is neither form.
 */
function agentMessageAt(record, line) {
  const payload = record?.payload;
  let text;
  if (record?.type === 'response_item' && payload?.type === 'agent_message' && Array.isArray(payload.content)) {
    text = payload.content.filter(block => block?.type === 'input_text' && typeof block.text === 'string')
      .map(block => block.text).join('\n');
  } else if (record?.type === 'inter_agent_communication' && typeof payload?.content === 'string') {
    text = payload.content;
  } else {
    return null;
  }
  if (!text.trim()) return undefined;
  return { role: 'agent', author: agentPath(payload.author), recipient: agentPath(payload.recipient), text, line };
}

/**
 * The same delivery written in both Codex forms on adjacent records: opposite forms, and
 * the same original paths and text. Two records of one form are two deliveries.
 */
const bothForms = (previous, record, message) => previous?.message.text === message.text
  && previous.record.type !== record.type
  && previous.record.payload.author === record.payload.author
  && previous.record.payload.recipient === record.payload.recipient;

function messageAt(record, provider, line) {
  if (provider === 'codex') {
    const agent = agentMessageAt(record, line);
    if (agent !== null) return agent;
  }
  const message = provider === 'claude' ? record?.message : record?.payload;
  const role = message?.role;
  if (role !== 'user' && role !== 'assistant') return;

  if (provider === 'claude' && (record.type !== role || record.isMeta === true)) return;
  if (provider === 'codex' && (record.type !== 'response_item' || message.type !== 'message')) return;

  const content = message.content;
  const blockType = provider === 'claude' ? 'text' : role === 'user' ? 'input_text' : 'output_text';
  let text;
  if (provider === 'claude' && typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    const codexUser = provider === 'codex' && role === 'user';
    const contentKinds = message.internal_chat_message_metadata_passthrough?.content_item_kinds;
    const kinds = Array.isArray(contentKinds) && contentKinds.length === content.length ? contentKinds : [];
    text = content
      .filter((block, index) => block?.type === blockType && typeof block.text === 'string'
        && (!codexUser || !isCodexContext(block.text, kinds[index])))
      .map(block => block.text)
      .join('\n');
  }

  if (text?.trim()) return { role, text, line };
}

// How many skipped line numbers an import reports; the count covers all of them.
const skippedLinesShown = 10;

/** h: and 32 hex characters of sha256(session ID NUL line NUL the raw line), per docs/architecture.md section 4. */
function lineKey(sessionId, line, rawLine) {
  return 'h:' + createHash('sha256').update(`${sessionId}\0${line}\0`).update(rawLine).digest('hex').slice(0, 32);
}

// Card I1: what one session may hold, in UTF-8 bytes. The message budget counts each
// message as stored (text, role, line and JSON syntax), so it bounds many small messages
// as well as a few large ones. A line longer than the line limit is skipped like an
// unreadable one, before it is ever joined.
export const maxMessageBytes = 64 * 1024 * 1024;
export const maxLineBytes = 64 * 1024 * 1024;

/**
 * The supported messages of a transcript, each with its stable key (P1c): u:<uuid> for the
 * first Claude record with a given UUID, otherwise a line-hash key, so a turn without a
 * UUID, or one that repeats a UUID, keeps its line and gets a key of its own.
 *
 * Card I2: a line that is not JSON (often a last line cut off while the agent was still
 * writing) is skipped and counted instead of rejecting the whole file. Messages keep their
 * line numbers in the file, so citations stay true. A file with no readable line at all is
 * still refused, since it is not JSONL.
 *
 * Card I1: the parser takes one line at a time, so a file can be read as a stream. A file's
 * session ID is its hash, known only at the end, so until then a message that needs a
 * line-hash key keeps its raw line, and finish() computes the keys.
 */
function transcriptParser(provider) {
  const messages = [];
  // The count covers every skipped line; only the first few line numbers are kept.
  const skipped = { count: 0, lines: [] };
  // Card I3: the agent message on the previous readable record, if there was one.
  let previousAgent = null;
  const skip = line => {
    // Card I3: records on either side of a skipped line are not adjacent.
    previousAgent = null;
    skipped.count += 1;
    if (skipped.lines.length < skippedLinesShown) skipped.lines.push(line);
  };
  const uuids = new Set();
  let readable = 0;
  let line = 0;
  let bytes = 0;
  return {
    /** One line of the file, in order, without its line break. */
    add(rawLine) {
      line += 1;
      const value = rawLine.trim();
      if (!value) {
        // Card I3: only records on adjacent lines can be one delivery in two forms.
        previousAgent = null;
        return;
      }

      let record;
      try {
        record = JSON.parse(value);
      } catch {
        skip(line);
        return;
      }
      readable += 1;
      const message = messageAt(record, provider, line);
      const agent = message?.role === 'agent' ? { record, message } : null;
      const repeat = agent && bothForms(previousAgent, record, message);
      // A dropped repeat ends its pair: the record after it starts a new delivery.
      previousAgent = repeat ? null : agent;
      // A delivery written in both Codex forms, one right after the other, is kept once.
      if (!message || repeat) return;
      bytes += Buffer.byteLength(JSON.stringify(message), 'utf8') + 1;
      if (bytes > maxMessageBytes) {
        throw new InputError('This transcript has more than 64 MiB of messages, more than one session can hold.');
      }
      const uuid = provider === 'claude' ? record.uuid : undefined;
      // UUIDs compare without case, so a repeat in another spelling is still a repeat.
      const fresh = typeof uuid === 'string' && uuidPattern.test(uuid) && !uuids.has(uuid.toLowerCase());
      if (fresh) uuids.add(uuid.toLowerCase());
      messages.push(fresh ? { ...message, key: 'u:' + uuid } : { ...message, rawLine });
    },
    /** A line too long to read; it counts as unreadable. */
    skipLine() {
      line += 1;
      skip(line);
    },
    /** The messages with their keys, once the session ID is known. */
    finish(sessionId) {
      if (readable === 0 && skipped.count) throw new InputError(`Invalid JSONL at line ${skipped.lines[0]}.`);
      if (messages.length === 0) throw new InputError('No supported conversation messages found.');
      const keyed = messages.map(({ rawLine, ...message }) => (
        rawLine === undefined ? message : { ...message, key: lineKey(sessionId, message.line, rawLine) }
      ));
      return { messages: keyed, skipped };
    },
  };
}

function parseTranscript(transcript, provider, sessionId) {
  const parser = transcriptParser(provider);
  for (const rawLine of transcript.split('\n')) parser.add(rawLine);
  return parser.finish(sessionId);
}

/**
 * Card I1: parse a transcript file as a stream, so a file far larger than the 8 MiB HTTP
 * limit never sits in memory whole. The text is decoded the way a browser File.text()
 * decodes it (UTF-8, a leading byte-order mark dropped, bad bytes replaced), so the
 * session ID matches a browser import of the same file.
 */
async function parseTranscriptFile(path, provider, { lineLimit = maxLineBytes } = {}) {
  const unreadable = () => new InputError('Cannot read the transcript file.');
  const notAFile = () => new InputError('The transcript must be a regular file.');
  // The path is checked before it is opened, so a FIFO or device is never opened; the
  // descriptor is checked again in case the path was swapped in between.
  let info;
  try {
    info = await stat(path);
  } catch {
    throw unreadable();
  }
  if (!info.isFile()) throw notAFile();

  let file;
  try {
    file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch {
    throw unreadable();
  }
  const closeQuietly = () => file.close().catch(() => {});

  const hash = createHash('sha256').update(`${provider}\0`);
  const parser = transcriptParser(provider);
  const decoder = new TextDecoder('utf-8');
  // The current line, as fragments joined once it ends; dropped if it passes the limit.
  let fragments = [];
  let length = 0;
  let tooLong = false;
  const append = piece => {
    if (tooLong || !piece) return;
    length += Buffer.byteLength(piece, 'utf8');
    if (length > lineLimit) {
      tooLong = true;
      fragments = [];
    } else {
      fragments.push(piece);
    }
  };
  const endLine = () => {
    if (tooLong) parser.skipLine();
    else parser.add(fragments.join(''));
    fragments = [];
    length = 0;
    tooLong = false;
  };
  const take = text => {
    hash.update(text);
    let start = 0;
    for (let end = text.indexOf('\n'); end !== -1; end = text.indexOf('\n', start)) {
      append(text.slice(start, end));
      endLine();
      start = end + 1;
    }
    append(text.slice(start));
  };
  try {
    if (!(await file.stat()).isFile()) throw notAFile();
    try {
      for await (const chunk of file.createReadStream({ autoClose: false })) take(decoder.decode(chunk, { stream: true }));
    } catch (error) {
      throw error instanceof InputError ? error : unreadable();
    }
  } catch (error) {
    throw error instanceof InputError ? error : unreadable();
  } finally {
    await closeQuietly();
  }
  take(decoder.decode());
  endLine();
  const id = hash.digest('hex');
  return { id, ...parser.finish(id) };
}

function withSkipped(summary, skipped) {
  if (!skipped.count) return summary;
  return { ...summary, skipped: { count: skipped.count, lines: skipped.lines } };
}

function sourceName(source) {
  if (typeof source !== 'string') throw new InputError('Choose a transcript file.');
  const name = basename(win32.basename(source)).trim();
  if (!name || name === '.' || name === '..' || name.length > 255 || /\p{Cc}/u.test(name)) {
    throw new InputError('Invalid transcript file name.');
  }
  return name;
}

function sessionFilter(query, provider, project) {
  const tokens = [...new Set(query.toLowerCase().split(/\s+/u).filter(Boolean))];
  const conditions = tokens.map(() => 'instr(s.search_text, ?) > 0');
  const values = [...tokens];
  if (provider) {
    conditions.push('s.provider = ?');
    values.push(provider);
  }
  if (project) {
    conditions.push('p.slug = ?');
    values.push(project);
  }
  return { conditions, values };
}

const whereClause = conditions => (conditions.length ? `WHERE ${conditions.join(' AND ')}` : '');

function titleFor(messages) {
  const first = messages.find(message => message.role === 'user') ?? messages[0];
  // The first 120 code points with runs of white space as one space, read only as far as
  // needed, so a title never ends in half of a surrogate pair and a huge message is not copied.
  const title = [];
  let space = false;
  for (const character of first.text.trim()) {
    if (/\s/u.test(character)) {
      space = true;
      continue;
    }
    if (space) title.push(' ');
    space = false;
    if (title.length >= 120) break;
    title.push(character);
    if (title.length >= 120) break;
  }
  return title.join('');
}

function serializeGraphPacket(packet) {
  // JSON object key order is insignificant. Array order remains part of the packet.
  return JSON.stringify(packet, (_key, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]));
    }
    return value;
  });
}

/**
 * Opens the ledger. With readOnly (card P3c), the file must already exist at this build's
 * schema: the connection cannot create, migrate or write it, and an older or newer file is
 * refused with an error whose code is LEDGER_SCHEMA and whose version is the file's.
 */
export function openStore(path, { readOnly = false } = {}) {
  if (!readOnly && path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const database = readOnly ? new DatabaseSync(path, { readOnly: true }) : new DatabaseSync(path);
  database.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  // The version 0 tables, created under the migration's lock after its version check,
  // so a newer file is refused before any DDL. The migration then upgrades them.
  const bootstrap = () => database.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex')),
      source TEXT NOT NULL,
      title TEXT NOT NULL,
      message_count INTEGER NOT NULL,
      messages TEXT NOT NULL,
      search_text TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS graphs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      payload TEXT NOT NULL
    ) STRICT;
    ${roomsSchema}
  `);
  try {
    if (readOnly) {
      const version = database.prepare('PRAGMA user_version').get().user_version;
      if (version !== schemaVersion) {
        throw Object.assign(new Error(`Ledger schema ${version}, not ${schemaVersion}.`), { code: 'LEDGER_SCHEMA', version });
      }
    } else {
      migrate(database, bootstrap);
    }
  } catch (error) {
    database.close();
    throw error;
  }
  // Card P3c review: a statement that fails to prepare (a damaged file, say) must not
  // leave the connection open, which on Windows keeps the file from being replaced.
  try {
    return storeOn(database);
  } catch (error) {
    database.close();
    throw error;
  }
}

/** The store's methods over an open, current-schema connection. */
function storeOn(database) {
  // A graph stored before G7 has no quoted or inferred marks, and a version 3 graph
  // stored before P2c no node hashes; publishing the same packet again adds them. The ID,
  // row and created_at stay as they were.
  const insertGraph = database.prepare(`
    INSERT INTO graphs (id, session_id, payload)
    VALUES (?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET payload = excluded.payload
      WHERE json_valid(graphs.payload) AND (json_type(graphs.payload, '$.quotedNodeIds') IS NULL
        OR (json_extract(graphs.payload, '$.packet.version') = 3 AND json_type(graphs.payload, '$.nodeHashes') IS NULL))
  `);
  const getGraph = database.prepare('SELECT payload FROM graphs WHERE id = ?');
  const countCitingGraphs = database.prepare('SELECT count(*) AS graphs FROM graphs WHERE session_id = ?');
  const deleteSessionRow = database.prepare('DELETE FROM sessions WHERE id = ?');
  const readGraph = id => {
    const row = getGraph.get(id);
    if (row) return { id, ...JSON.parse(row.payload) };
  };
  // Schema version 1 adds the listing columns. Its triggers stamp created_at and party
  // on every new graph and room row, whichever build inserts it (src/migrate.mjs).
  // Card G11: two snapshots of one party's graph, older first.
  const diff = (id, fromId) => {
    const newer = readGraph(id);
    const older = readGraph(fromId);
    if (!newer || !older) return;
    if (!isPartyGraph(newer.packet) || !isPartyGraph(older.packet) || newer.packet.party !== older.packet.party) {
      throw new InputError('Both graphs must be version 2 or 3 graphs of the same party.');
    }
    return diffGraphs(older, newer);
  };
  // Card P2a (ADR-7a): a graph's project is the project of the session it cites.
  const selectGraphProject = database.prepare(`
    SELECT p.slug AS project FROM graphs g JOIN sessions s ON s.id = g.session_id LEFT JOIN projects p ON p.id = s.project_id
    WHERE g.id = ?
  `);
  const graphProject = id => selectGraphProject.get(id)?.project ?? null;
  const rooms = mountRooms(database, readGraph, graphProject);
  const artifacts = mountArtifacts(database, defaultProject);
  const reviews = mountReviews(database, readGraph);

  // Version 2 adds projects and sessions.project_id. Version 3 adds one messages row per
  // turn; sessions.messages is still written for builds from before versions. Sessions are
  // read from rows; only the version 3 step and the older-build trigger read the column.
  const insert = database.prepare(`
    INSERT INTO sessions (id, provider, source, title, message_count, messages, search_text, project_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO NOTHING
  `);
  const insertMessage = database.prepare(`
    INSERT INTO messages (session_id, seq, line, role, text_json, key, author_json, recipient_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const writeRows = (id, messages) => {
    for (const [seq, message] of messages.entries()) {
      // Paths are JSON string literals, like the text, because SQLite cuts a string at a NUL.
      insertMessage.run(id, seq, message.line, message.role, JSON.stringify(message.text), message.key,
        message.role === 'agent' ? JSON.stringify(message.author) : null,
        message.role === 'agent' ? JSON.stringify(message.recipient) : null);
    }
  };
  // Card I3: the copy in sessions.messages, for builds from before versions, leaves agent
  // turns out: those builds know only user and assistant turns.
  const legacyCopy = messages => JSON.stringify(messages.filter(message => message.role !== 'agent')
    .map(({ role, text, line }) => ({ role, text, line })));
  const deleteRows = database.prepare('DELETE FROM messages WHERE session_id = ?');
  const refreshSession = database.prepare('UPDATE sessions SET message_count = ?, messages = ?, search_text = ? WHERE id = ?');
  const getSummary = database.prepare(`SELECT ${summaryColumns} FROM ${sessionRows} WHERE s.id = ?`);
  const selectMessages = database.prepare('SELECT role, text_json, line, key, author_json, recipient_json FROM messages WHERE session_id = ? ORDER BY seq');
  // Plain objects, as the JSON column gave. The text is a JSON string literal, because
  // node:sqlite cuts a string at a NUL when reading and replaces lone surrogates when
  // binding; the JSON form keeps every turn exactly as imported.
  const readMessages = id => selectMessages.all(id).map(({ role, text_json: text, line, key, author_json: author, recipient_json: recipient }) => (
    role === 'agent'
      ? { role, author: JSON.parse(author), recipient: JSON.parse(recipient), text: JSON.parse(text), line, key }
      : { role, text: JSON.parse(text), line, key }));
  const readDetail = id => {
    const row = getSummary.get(id);
    if (row) return { ...row, messages: readMessages(id) };
  };
  const insertProject = database.prepare(`
    INSERT INTO projects (id, slug, name, created_at) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT (slug) DO NOTHING
  `);
  const projectId = database.prepare('SELECT id FROM projects WHERE slug = ?');

  // A list cursor is a row ID from an earlier page, resolved to its rowid at query time.
  const cursors = {
    sessions: database.prepare('SELECT rowid FROM sessions WHERE id = ?'),
    graphs: database.prepare('SELECT rowid FROM graphs WHERE id = ?'),
  };
  const before = (table, after) => {
    if (after === undefined || after === null) return null;
    const row = cursors[table].get(after);
    if (!row) throw new InputError('Unknown cursor.');
    return row.rowid;
  };
  const page = (rows, limit) => ({ rows: rows.slice(0, limit), next: rows.length > limit ? rows[limit - 1].id : null });
  const selectGraphs = database.prepare(`
    SELECT g.id, g.session_id AS sessionId, s.title AS sessionTitle, g.party, p.slug AS project,
      CASE WHEN json_valid(g.payload) THEN json_extract(g.payload, '$.packet.version') END AS version,
      g.created_at AS createdAt,
      CASE WHEN json_valid(g.payload) THEN json_array_length(g.payload, '$.packet.nodes') END AS nodes,
      CASE WHEN json_valid(g.payload) THEN json_array_length(g.payload, '$.packet.edges') END AS edges,
      CASE WHEN json_valid(g.payload) THEN coalesce(json_array_length(g.payload, '$.packet.links'), 0) END AS links
    FROM graphs g LEFT JOIN sessions s ON s.id = g.session_id LEFT JOIN projects p ON p.id = s.project_id
    WHERE ($sessionId IS NULL OR g.session_id = $sessionId)
      AND ($party IS NULL OR g.party = $party)
      AND ($project IS NULL OR p.slug = $project)
      AND ($before IS NULL OR g.rowid < $before)
    ORDER BY g.rowid DESC LIMIT $n
  `);
  // A current file opens without the lock, so a newer build may have upgraded it while
  // the statements above were prepared. Refuse it now rather than hand out the store.
  // (An upgrade after this point, while the store is open, is not detected.)
  try {
    refuseNewerSchema(database);
  } catch (error) {
    database.close();
    throw error;
  }

  /**
   * Card I3: a Codex file imported before agent messages were read gains them when it is
   * imported again. Its ID stays, and every turn it had is matched by line, role and text
   * and keeps its key, an l:<line> key from the version 3 copy included, so graphs that
   * cite it hold. A session whose turns would change in any other way is left as it is.
   * Returns the session's summary, read under the write lock, or undefined when the
   * session is gone.
   */
  function addAgentTurns(id, messages, searchText) {
    database.exec('BEGIN IMMEDIATE');
    let pending = true;
    try {
      if (!getSummary.get(id)) return undefined;
      const old = readMessages(id);
      const atLine = new Map(messages.map(message => [message.line, message]));
      const same = message => atLine.get(message.line)?.role === message.role && atLine.get(message.line).text === message.text;
      if (messages.some(message => message.role === 'agent') && !old.some(message => message.role === 'agent')
          && old.length < messages.length && old.every(same)) {
        const keyAt = new Map(old.map(message => [message.line, message.key]));
        const merged = messages.map(message => (keyAt.has(message.line) ? { ...message, key: keyAt.get(message.line) } : message));
        // A new turn's key could equal an old one only by a hash collision; leave the session as it is then.
        if (new Set(merged.map(message => message.key)).size === merged.length) {
          deleteRows.run(id);
          writeRows(id, merged);
          refreshSession.run(merged.length, legacyCopy(merged), searchText, id);
        }
      }
      const summary = getSummary.get(id);
      database.exec('COMMIT');
      pending = false;
      return summary;
    } finally {
      if (pending) database.exec('ROLLBACK');
    }
  }

  function save(id, provider, name, project, { messages, skipped }) {
    const title = titleFor(messages);
    const searchText = [title, ...messages.map(message => message.text)].join('\n').toLowerCase();
    const stored = getSummary.get(id) && addAgentTurns(id, messages, searchText);
    if (stored) return withSkipped(stored, skipped);

    database.exec('BEGIN IMMEDIATE');
    let pending = true;
    try {
      // Another process may have stored the same bytes since the check above.
      const stored = getSummary.get(id);
      if (stored) return withSkipped(stored, skipped);
      insertProject.run(randomBytes(16).toString('hex'), project, project);
      // Rows first: the foreign key is deferred, and a session inserted with rows
      // already in place is left alone by the trigger for older builds.
      writeRows(id, messages);
      insert.run(id, provider, name, title, messages.length, legacyCopy(messages), searchText, projectId.get(project).id);
      database.exec('COMMIT');
      pending = false;
    } finally {
      if (pending) database.exec('ROLLBACK');
    }
    return withSkipped(getSummary.get(id), skipped);
  }


  return {
    /**
     * Stores a transcript in a project (the default one when none is named), creating
     * the project on first use. The session ID depends only on the provider and the
     * bytes, so bytes already stored return the stored session, in the project it
     * already has; nothing is moved or created (docs/evals.md, P1b).
     */
    importTranscript(input) {
      const { provider, source, transcript } = input ?? {};
      const project = input?.project ?? defaultProject;
      if (!isProvider(provider)) throw new InputError('Choose Claude Code or Codex as the provider.');
      if (typeof transcript !== 'string') throw new InputError('Transcript must be JSONL text.');
      const name = sourceName(source);
      if (!isProjectSlug(project)) throw new InputError('P' + projectSlugRule.slice(1));
      const id = createHash('sha256').update(`${provider}\0`).update(transcript).digest('hex');
      // Parsed before the duplicate check, so a repeated import reports the same skipped lines.
      return save(id, provider, name, project, parseTranscript(transcript, provider, id));
    },

    /**
     * Card I1: import a transcript file by path, read as a stream; see parseTranscriptFile.
     * Like importTranscript, it stores into the named project or the default one.
     */
    async importTranscriptFile(input, options) {
      const { provider, path } = input ?? {};
      const project = input?.project ?? defaultProject;
      if (!isProvider(provider)) throw new InputError('Choose Claude Code or Codex as the provider.');
      const name = sourceName(path);
      if (!isProjectSlug(project)) throw new InputError('P' + projectSlugRule.slice(1));
      const { id, ...parsed } = await parseTranscriptFile(path, provider, options);
      return save(id, provider, name, project, parsed);
    },

    list(query, provider, project) {
      const { conditions, values } = sessionFilter(query, provider, project);
      return database.prepare(`SELECT ${summaryColumns} FROM ${sessionRows} ${whereClause(conditions)} ORDER BY s.rowid DESC`).all(...values);
    },

    /** One page of list(), newest first; next is the last ID shown when more rows match. */
    listSessionsPage({ query, provider, project, limit, after }) {
      const { conditions, values } = sessionFilter(query, provider, project);
      const rowid = before('sessions', after);
      if (rowid !== null) {
        conditions.push('s.rowid < ?');
        values.push(rowid);
      }
      const rows = database.prepare(`SELECT ${summaryColumns} FROM ${sessionRows} ${whereClause(conditions)} ORDER BY s.rowid DESC LIMIT ?`)
        .all(...values, limit + 1);
      const { rows: sessions, next } = page(rows, limit);
      return { sessions, next };
    },

    /** Published graphs, newest first, optionally for one session, party and/or project (P2a). */
    listGraphs({ sessionId = null, party = null, project = null, limit, after }) {
      const rows = selectGraphs.all({ $sessionId: sessionId, $party: party, $project: project, $before: before('graphs', after), $n: limit + 1 });
      const { rows: graphs, next } = page(rows, limit);
      return { graphs, next };
    },

    /** A summary and its messages in order, each with its stable key. */
    get(id) {
      return readDetail(id);
    },

    /**
     * Delete one imported session: true when it was deleted, false when there is no
     * such session. Refused with a ConflictError while any graph cites it; rooms refer
     * to graphs, so a session in a room is refused through its graph. The whole
     * transcript, its title and its search text are in this one row.
     */
    deleteSession(id) {
      // SQLite leaves deleted rows' bytes in free space unless secure_delete is on.
      // Turn it on for this delete only, so the transcript text is overwritten.
      const previous = database.prepare('PRAGMA secure_delete').get().secure_delete;
      database.exec('PRAGMA secure_delete = ON');
      try {
        // IMMEDIATE takes the write lock first, so no graph can cite the session
        // between the check and the delete.
        database.exec('BEGIN IMMEDIATE');
        let deleted = false;
        try {
          if (getSummary.get(id)) {
            const { graphs } = countCitingGraphs.get(id);
            if (graphs > 0) {
              throw new ConflictError(`This session is cited by ${graphs} ${graphs === 1 ? 'graph' : 'graphs'}, so it cannot be deleted.`, { graphs });
            }
            const { journal_mode: journalMode } = database.prepare('PRAGMA journal_mode').get();
            if (!deleteJournalModes.has(journalMode)) {
              throw new ConflictError(`This ledger database uses journal mode ${journalMode}, so a delete could leave copies of the transcript in the file. Deleting needs the default rollback journal.`, { journalMode });
            }
            deleted = deleteSessionRow.run(id).changes === 1;
          }
          database.exec('COMMIT');
        } catch (error) {
          database.exec('ROLLBACK');
          throw error;
        }
        return deleted;
      } finally {
        database.exec(`PRAGMA secure_delete = ${secureDeleteModes[previous] ?? 'OFF'}`);
      }
    },

    publishGraph(packet) {
      const sessionId = packet?.sessionId;
      if (typeof sessionId !== 'string' || !/^[a-f0-9]{64}$/u.test(sessionId)) {
        throw new InputError('Graph requires a valid transcript session ID.');
      }
      if (!getSummary.get(sessionId)) throw new InputError('Graph transcript session not found.');

      // P1c: the messages come from their rows; G7 grounds each node in them.
      const messages = readMessages(sessionId);
      const sourceLines = messages.map(message => message.line);
      // P2a: a link must stay in the project of the session this graph cites.
      // A session or graph without a resolved project matches nothing (P2a review).
      const project = getSummary.get(sessionId).project ?? null;
      // P2b: version 3 cites this session's messages by key and this project's artifacts.
      const options = {
        lookupGraph: id => readGraph(id),
        sameProject: id => project !== null && graphProject(id) === project,
        messageKeys: messages.map(message => message.key),
        hasArtifact: id => artifacts.artifactInProject(id, project),
      };
      validateGraph(packet, sourceLines, options);
      // Derive from the canonical form so derived ID lists follow its order.
      const ordered = canonicalPacket(packet);
      const derived = validateGraph(ordered, sourceLines, options);
      const canonical = serializeGraphPacket(ordered);
      const id = createHash('sha256').update(canonical).digest('hex');
      // P2b: a version 3 graph stores what its citations resolved to, so every reader
      // gets lines (and artifacts) without parsing keys again; G7 grounds on those lines.
      let citations;
      if (ordered.version === 3) {
        const lineAt = new Map(messages.map(message => [message.key, message.line]));
        citations = resolveCitations(ordered, key => lineAt.get(key), id => artifacts.getArtifact(id));
      }
      const linesOf = citations ? node => citations.find(entry => entry.id === node.id).lines : undefined;
      // P2c: and the hash a person approves or rejects, per node.
      const versionThree = citations ? { citations, nodeHashes: nodeHashes(ordered) } : {};
      const payload = { packet: JSON.parse(canonical), ...derived, ...versionThree, ...groundNodes(ordered, messages, linesOf) };
      try {
        insertGraph.run(id, sessionId, JSON.stringify(payload));
      } catch (error) {
        // Another connection deleted the session after it was read above.
        if (/FOREIGN KEY constraint failed/u.test(error?.message)) throw new InputError('Graph transcript session not found.');
        throw error;
      }
      return { id, ...JSON.parse(getGraph.get(id).payload) };
    },

    getGraph: readGraph,

    diffGraphs: diff,

    ...rooms,

    ...artifacts,

    ...reviews,

    close() {
      database.close();
    },

    /** Card G12: one or more graphs as one node-link file for code-graph tools; undefined if one is unknown. */
    exportGraphs(ids) {
      const graphs = ids.map(readGraph);
      if (graphs.some(graph => !graph)) return;
      const prefixes = new Set(graphs.map(graph => graph.id.slice(0, graphPrefixLength)));
      if (prefixes.size !== graphs.length && new Set(ids).size === ids.length) {
        throw new InputError('Two of these graphs share the first 16 characters of their IDs; export them apart.');
      }
      // Only the transcript's file name is needed, so the summary row, not its messages.
      return nodeLinkBundle(graphs, graph => getSummary.get(graph.packet.sessionId));
    },

    getGraphContext(id, { question, budget } = {}) {
      const graph = readGraph(id);
      if (!graph) return;
      return graphContext(graph, readDetail(graph.packet.sessionId), { lookupGraph: readGraph, question, budget });
    },
  };
}
