import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { basename, dirname, win32 } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { graphContext } from './context.mjs';
import { InputError } from './errors.mjs';
import { canonicalPacket, validateGraph } from './graph.mjs';
import { migrate } from './migrate.mjs';
import { mountRooms } from './rooms.mjs';

export { InputError };

const summaryColumns = 'id, provider, source, title, message_count AS messageCount';
const codexContextKinds = new Set([
  'agents_md.instructions',
  'environments.environment_context',
  'additional_content.codex_apps_open_page',
  'skills.selected_skill_instructions',
]);


export function isProvider(value) {
  return value === 'claude' || value === 'codex';
}

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
 * encrypted content is never imported.
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

function parseTranscript(transcript, provider) {
  const messages = [];
  // The agent message on the previous readable record, if there was one.
  let previousAgent = null;
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
    const agent = message?.role === 'agent' ? { record, message } : null;
    // A delivery written in both Codex forms, one right after the other, is kept once.
    if (message && !(agent && bothForms(previousAgent, record, message))) messages.push(message);
    previousAgent = agent;
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

function sessionFilter(query, provider) {
  const tokens = [...new Set(query.toLowerCase().split(/\s+/u).filter(Boolean))];
  const conditions = tokens.map(() => 'instr(search_text, ?) > 0');
  const values = [...tokens];
  if (provider) {
    conditions.push('provider = ?');
    values.push(provider);
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
  database.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
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
  `);

  const insert = database.prepare(`
    INSERT INTO sessions (id, provider, source, title, message_count, messages, search_text)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO NOTHING
  `);
  const getSummary = database.prepare(`SELECT ${summaryColumns} FROM sessions WHERE id = ?`);
  const refresh = database.prepare('UPDATE sessions SET title = ?, message_count = ?, messages = ?, search_text = ? WHERE id = ?');
  const getDetail = database.prepare(`SELECT ${summaryColumns}, messages FROM sessions WHERE id = ?`);
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
  try {
    migrate(database);
  } catch (error) {
    database.close();
    throw error;
  }

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

  return {
    importTranscript(input) {
      const { provider, source, transcript } = input ?? {};
      if (!isProvider(provider)) throw new InputError('Choose Claude Code or Codex as the provider.');
      if (typeof transcript !== 'string') throw new InputError('Transcript must be JSONL text.');
      const name = sourceName(source);
      const id = createHash('sha256').update(`${provider}\0`).update(transcript).digest('hex');
      const messages = parseTranscript(transcript, provider);
      const title = titleFor(messages);
      const stored = JSON.stringify(messages);
      const searchText = [title, ...messages.map(message => message.text)].join('\n').toLowerCase();
      const existing = getDetail.get(id);
      if (existing) {
        // Card I3: a file imported before agent messages were read gains them on a new
        // import. Its ID stays, and every line it had is kept, so graphs that cite it hold.
        const lines = new Set(messages.map(message => message.line));
        if (existing.messages !== stored && JSON.parse(existing.messages).every(message => lines.has(message.line))) {
          refresh.run(title, messages.length, stored, searchText, id);
        }
        return getSummary.get(id);
      }

      insert.run(id, provider, name, title, messages.length, stored, searchText);
      return getSummary.get(id);
    },

    list(query, provider) {
      const { conditions, values } = sessionFilter(query, provider);
      return database.prepare(`SELECT ${summaryColumns} FROM sessions ${whereClause(conditions)} ORDER BY rowid DESC`).all(...values);
    },

    /** One page of list(), newest first; next is the last ID shown when more rows match. */
    listSessionsPage({ query, provider, limit, after }) {
      const { conditions, values } = sessionFilter(query, provider);
      const rowid = before('sessions', after);
      if (rowid !== null) {
        conditions.push('rowid < ?');
        values.push(rowid);
      }
      const rows = database.prepare(`SELECT ${summaryColumns} FROM sessions ${whereClause(conditions)} ORDER BY rowid DESC LIMIT ?`)
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
