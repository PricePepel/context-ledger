import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { basename, dirname, win32 } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { validateGraph } from './graph.mjs';

const summaryColumns = 'id, provider, source, title, message_count AS messageCount';
const codexContextKinds = new Set([
  'agents_md.instructions',
  'environments.environment_context',
  'additional_content.codex_apps_open_page',
  'skills.selected_skill_instructions',
]);

export class InputError extends Error {}

export function isProvider(value) {
  return value === 'claude' || value === 'codex';
}

function isCodexContext(text, kind) {
  if (codexContextKinds.has(kind)) return true;
  if (typeof kind === 'string' && kind.startsWith('user.')) return false;

  // Older rollouts omit per-block metadata, so check complete reserved envelopes.
  const value = text.trim();
  return /^<environment_context>[\s\S]*<\/environment_context>$/u.test(value)
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

function titleFor(messages) {
  const first = messages.find(message => message.role === 'user') ?? messages[0];
  return first.text.trim().replace(/\s+/gu, ' ').slice(0, 120);
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
  const getDetail = database.prepare(`SELECT ${summaryColumns}, messages FROM sessions WHERE id = ?`);
  const insertGraph = database.prepare(`
    INSERT INTO graphs (id, session_id, payload)
    VALUES (?, ?, ?)
    ON CONFLICT (id) DO NOTHING
  `);
  const getGraph = database.prepare('SELECT payload FROM graphs WHERE id = ?');

  return {
    importTranscript(input) {
      const { provider, source, transcript } = input ?? {};
      if (!isProvider(provider)) throw new InputError('Choose Claude Code or Codex as the provider.');
      if (typeof transcript !== 'string') throw new InputError('Transcript must be JSONL text.');
      const name = sourceName(source);
      const id = createHash('sha256').update(`${provider}\0`).update(transcript).digest('hex');
      const existing = getSummary.get(id);
      if (existing) return existing;

      const messages = parseTranscript(transcript, provider);
      const title = titleFor(messages);
      const searchText = [title, ...messages.map(message => message.text)].join('\n').toLowerCase();
      insert.run(id, provider, name, title, messages.length, JSON.stringify(messages), searchText);
      return getSummary.get(id);
    },

    list(query, provider) {
      const tokens = [...new Set(query.toLowerCase().split(/\s+/u).filter(Boolean))];
      const conditions = tokens.map(() => 'instr(search_text, ?) > 0');
      const values = [...tokens];
      if (provider) {
        conditions.push('provider = ?');
        values.push(provider);
      }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      return database.prepare(`SELECT ${summaryColumns} FROM sessions ${where} ORDER BY rowid DESC`).all(...values);
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
      const derived = validateGraph(packet, sourceLines);
      const canonical = serializeGraphPacket(packet);
      const id = createHash('sha256').update(canonical).digest('hex');
      const payload = { packet: JSON.parse(canonical), ...derived };
      insertGraph.run(id, sessionId, JSON.stringify(payload));
      return { id, ...JSON.parse(getGraph.get(id).payload) };
    },

    getGraph(id) {
      const row = getGraph.get(id);
      if (row) return { id, ...JSON.parse(row.payload) };
    },
  };
}
