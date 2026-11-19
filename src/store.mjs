import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { basename, dirname, win32 } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { graphContext } from './context.mjs';
import { InputError } from './errors.mjs';
import { canonicalPacket, validateGraph } from './graph.mjs';
import { defaultProject, migrate, refuseNewerSchema } from './migrate.mjs';
import { mountRooms, roomsSchema } from './rooms.mjs';

export { InputError };

// A summary names its project by slug; project IDs stay inside the database.
const summaryColumns = 's.id, s.provider, s.source, s.title, s.message_count AS messageCount, p.slug AS project';
const sessionRows = 'sessions s LEFT JOIN projects p ON p.id = s.project_id';
const projectPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
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

function messageAt(record, provider, line) {
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

function parseTranscript(transcript, provider) {
  const messages = [];
  for (const [index, rawLine] of transcript.split('\n').entries()) {
    const line = index + 1;
    const value = rawLine.trim();
    if (!value) continue;

    let record;
    try {
      record = JSON.parse(value);
    } catch {
      throw new InputError(`Invalid JSONL at line ${line}.`);
    }
    const message = messageAt(record, provider, line);
    if (message) messages.push(message);
  }

  if (messages.length === 0) throw new InputError('No supported conversation messages found.');
  return messages;
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
  // Cut by code point so a title never ends in half of a surrogate pair.
  return Array.from(first.text.trim().replace(/\s+/gu, ' ')).slice(0, 120).join('');
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

export function openStore(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(path);
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
    migrate(database, bootstrap);
  } catch (error) {
    database.close();
    throw error;
  }

  const insertGraph = database.prepare(`
    INSERT INTO graphs (id, session_id, payload)
    VALUES (?, ?, ?)
    ON CONFLICT (id) DO NOTHING
  `);
  const getGraph = database.prepare('SELECT payload FROM graphs WHERE id = ?');
  const readGraph = id => {
    const row = getGraph.get(id);
    if (row) return { id, ...JSON.parse(row.payload) };
  };
  // Schema version 1 adds the listing columns. Its triggers stamp created_at and party
  // on every new graph and room row, whichever build inserts it (src/migrate.mjs).
  const rooms = mountRooms(database, readGraph);

  // Version 2 adds projects and sessions.project_id.
  const insert = database.prepare(`
    INSERT INTO sessions (id, provider, source, title, message_count, messages, search_text, project_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO NOTHING
  `);
  const getSummary = database.prepare(`SELECT ${summaryColumns} FROM ${sessionRows} WHERE s.id = ?`);
  const listProjects = database.prepare(`
    SELECT p.slug, COUNT(s.id) AS sessions FROM projects p LEFT JOIN sessions s ON s.project_id = p.id
    GROUP BY p.id ORDER BY p.slug`);
  const getDetail = database.prepare(`SELECT ${summaryColumns}, s.messages FROM ${sessionRows} WHERE s.id = ?`);
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
    SELECT g.id, g.session_id AS sessionId, s.title AS sessionTitle, g.party,
      CASE WHEN json_valid(g.payload) THEN json_extract(g.payload, '$.packet.version') END AS version,
      g.created_at AS createdAt,
      CASE WHEN json_valid(g.payload) THEN json_array_length(g.payload, '$.packet.nodes') END AS nodes,
      CASE WHEN json_valid(g.payload) THEN json_array_length(g.payload, '$.packet.edges') END AS edges,
      CASE WHEN json_valid(g.payload) THEN coalesce(json_array_length(g.payload, '$.packet.links'), 0) END AS links
    FROM graphs g LEFT JOIN sessions s ON s.id = g.session_id
    WHERE ($sessionId IS NULL OR g.session_id = $sessionId)
      AND ($party IS NULL OR g.party = $party)
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
      const existing = getSummary.get(id);
      if (existing) return existing;

      const messages = parseTranscript(transcript, provider);
      const title = titleFor(messages);
      const searchText = [title, ...messages.map(message => message.text)].join('\n').toLowerCase();
      database.exec('BEGIN IMMEDIATE');
      let open = true;
      try {
        // Another process may have stored the same bytes since the check above.
        const stored = getSummary.get(id);
        if (stored) return stored;
        insertProject.run(randomBytes(16).toString('hex'), project, project);
        insert.run(id, provider, name, title, messages.length, JSON.stringify(messages), searchText, projectId.get(project).id);
        database.exec('COMMIT');
        open = false;
      } finally {
        if (open) database.exec('ROLLBACK');
      }
      return getSummary.get(id);
    },

    /** Card U5: every project by slug, with how many sessions it holds. */
    listProjects() {
      return listProjects.all();
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

    /** Published graphs, newest first, optionally for one session and/or one party. */
    listGraphs({ sessionId = null, party = null, limit, after }) {
      const rows = selectGraphs.all({ $sessionId: sessionId, $party: party, $before: before('graphs', after), $n: limit + 1 });
      const { rows: graphs, next } = page(rows, limit);
      return { graphs, next };
    },

    get(id) {
      const row = getDetail.get(id);
      if (row) return { ...row, messages: JSON.parse(row.messages) };
    },

    publishGraph(packet) {
      const sessionId = packet?.sessionId;
      if (typeof sessionId !== 'string' || !/^[a-f0-9]{64}$/u.test(sessionId)) {
        throw new InputError('Graph requires a valid transcript session ID.');
      }
      const session = getDetail.get(sessionId);
      if (!session) throw new InputError('Graph transcript session not found.');

      const sourceLines = JSON.parse(session.messages).map(message => message.line);
      const options = { lookupGraph: id => readGraph(id) };
      validateGraph(packet, sourceLines, options);
      // Derive from the canonical form so derived ID lists follow its order.
      const ordered = canonicalPacket(packet);
      const derived = validateGraph(ordered, sourceLines, options);
      const canonical = serializeGraphPacket(ordered);
      const id = createHash('sha256').update(canonical).digest('hex');
      const payload = { packet: JSON.parse(canonical), ...derived };
      insertGraph.run(id, sessionId, JSON.stringify(payload));
      return { id, ...JSON.parse(getGraph.get(id).payload) };
    },

    getGraph: readGraph,

    ...rooms,

    close() {
      database.close();
    },

    getGraphContext(id) {
      const graph = readGraph(id);
      if (!graph) return;
      const row = getDetail.get(graph.packet.sessionId);
      return graphContext(graph, { ...row, messages: JSON.parse(row.messages) }, { lookupGraph: readGraph });
    },
  };
}
