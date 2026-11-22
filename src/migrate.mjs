// Schema versions of ledger.sqlite, kept in PRAGMA user_version. A file written before
// versions existed is version 0 and is upgraded in place when a store opens it.
export const schemaVersion = 6;

const userVersion = database => database.prepare('PRAGMA user_version').get().user_version;
const columns = (database, table) => new Set(database.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name));

// The packet's own party, or null for v1 packets and payloads that are not JSON.
const packetParty = payload => `CASE WHEN json_valid(${payload}) THEN
    CASE WHEN json_type(${payload}, '$.packet.party') = 'text' THEN json_extract(${payload}, '$.packet.party') END END`;
const now = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/** The slug of the project that sessions without one belong to. */
export const defaultProject = 'default';

// Rows for one session's stored JSON messages, keyed by line: the JSON keeps neither raw
// lines nor record UUIDs, so u: and h: keys cannot be derived from it (docs/evals.md, P1c).
// The sessions_messages trigger uses it for a session that an older build inserts.
// text_json is the turn's JSON string literal as stored (->, not ->>), because a round trip
// through SQLite text loses a NUL and everything after it, and lone surrogates.
const legacyRows = (sessionId, messages) => `
  SELECT ${sessionId}, m.key, m.value ->> '$.line', m.value ->> '$.role', m.value -> '$.text',
    'l:' || (m.value ->> '$.line')
  FROM json_each(${messages}) m`;
const insertRows = 'INSERT INTO messages (session_id, seq, line, role, text_json, key)';

// What is wrong with a stored session that version 3 cannot copy, in fixed words that
// quote none of its content. A line is an integer token from 1 to the largest integer
// JavaScript reads exactly (Number.MAX_SAFE_INTEGER), so 1.0 or 1e0 is refused as before.
const notAnArray = 'its stored messages are not a JSON array';
const notAMessage = 'a stored message is not an object with a user or assistant role, a string text and a line from 1 to 2^53 - 1';
const repeatedField = 'a stored message has the same field twice';
const nulName = 'a stored message has a role, text or line field name followed by a NUL character';
const readFields = new Set(['role', 'text', 'line']);
const tooDeep = 'its stored messages are nested more than 1,000 levels deep';
const maxDepth = 1000;
const sameLine = 'two stored messages have the same line';
const migrationFailed = (id, rowid, reason) => `${id ? `Session ${id}` : `The session in row ${rowid}`} ` +
  `cannot be moved to schema version 3: ${reason}. The migration rolled back, so the file was not changed.`;
const isMessage = message => message !== null && typeof message === 'object' && !Array.isArray(message)
  && (message.role === 'user' || message.role === 'assistant') && typeof message.text === 'string'
  && Number.isSafeInteger(message.line) && message.line >= 1;
const lineToken = /^[1-9][0-9]*$/u;
const quote = 34;
const backslash = 92;
const colon = 58;
const isSpace = code => code === 32 || code === 9 || code === 10 || code === 13;
const parseArray = (decoder, bytes) => {
  try {
    const source = decoder.decode(bytes);
    const value = JSON.parse(source);
    return Array.isArray(value) ? { source, messages: value } : null;
  } catch {
    return null;
  }
};

/**
 * For each object in a JSON array that JSON.parse has accepted: whether a member name
 * appears twice, and the raw token of its line member. JSON.parse keeps the last of two
 * members with one name, while SQLite (the old copy, and the trigger for older builds)
 * reads the first, so a repeat is refused rather than resolved either way. The raw token
 * shows a line such as 1.0 or 1.00000000000000001 that JavaScript would read as 1
 * (Codex review of 5a80f16). Only members of the array's own elements are looked at.
 * A name that holds a NUL is flagged too when its part before the NUL is a field the copy
 * reads (role, text or line): SQLite compares names only up to a NUL, so "line\u0000x"
 * would be its line. Any other such name is an extra field and is ignored, as before
 * (Codex review of ed38502). The deepest nesting is returned as well, since SQLite
 * refuses JSON nested more than 1,000 levels deep and JSON.parse does not (Codex review
 * of 2f44b8a).
 */
function scanMembers(source) {
  const elements = [];
  let depth = 0;
  let deepest = 0;
  let element = null;
  for (let at = 0; at < source.length; at += 1) {
    const code = source.charCodeAt(at);
    if (code === quote) {
      let close = source.indexOf('"', at + 1);
      for (;;) {
        let slashes = 0;
        while (source.charCodeAt(close - 1 - slashes) === backslash) slashes += 1;
        if (slashes % 2 === 0) break;
        close = source.indexOf('"', close + 1);
      }
      let next = close + 1;
      while (isSpace(source.charCodeAt(next))) next += 1;
      if (depth === 2 && element && source.charCodeAt(next) === colon) {
        const literal = source.slice(at, close + 1);
        const name = literal.includes('\\') ? JSON.parse(literal) : literal.slice(1, -1);
        if (element.names.has(name)) element.repeated = true;
        const nul = name.indexOf(String.fromCodePoint(0));
        if (nul >= 0 && readFields.has(name.slice(0, nul))) element.nulName = true;
        element.names.add(name);
        if (name === 'line') {
          let from = next + 1;
          while (isSpace(source.charCodeAt(from))) from += 1;
          let to = from;
          while (to < source.length && !isSpace(source.charCodeAt(to)) && !',}]'.includes(source[to])) to += 1;
          element.line = source.slice(from, to);
        }
      }
      at = close;
    } else if (code === 123 || code === 91) {
      depth += 1;
      if (depth > deepest) deepest = depth;
      if (depth === 2) {
        element = code === 123 ? { names: new Set(), repeated: false, nulName: false, line: '' } : null;
        elements.push(element);
      }
    } else if (code === 125 || code === 93) {
      depth -= 1;
    }
  }
  return { elements, deepest };
}

/**
 * Copies every stored session's JSON messages into rows, in array order with l:<line>
 * keys, in one pass: each array is read once as its exact bytes (node:sqlite cuts text at
 * a NUL when it reads it), decoded in the file's own text encoding, parsed once and
 * checked, and each text is written as a JSON string literal. The first session that
 * cannot be copied throws, naming the session; the caller rolls the step back. (Review of
 * PR #45: the SQL copy parsed every turn several times and checked its own copy again,
 * and its error named no session.)
 */
function copyStoredMessages(database) {
  const encoding = database.prepare('PRAGMA encoding').get().encoding.toLowerCase();
  // ignoreBOM keeps a leading byte order mark in the text, so JSON.parse refuses it as
  // SQLite did. A 64-character ID is 64 bytes in UTF-8 and 128 in UTF-16.
  const decoder = new TextDecoder(encoding, { fatal: true, ignoreBOM: true });
  const idBytes = encoding === 'utf-8' ? 64 : 128;
  const insert = database.prepare(`${insertRows} VALUES (?, ?, ?, ?, ?, ?)`);
  // For an ID that is not 64 hex characters (none that this project writes), SQL copies
  // the ID by rowid, so one that JavaScript would read inexactly is still copied exactly.
  // It is slower, so the usual IDs are bound directly.
  const insertByRow = database.prepare(`${insertRows} SELECT id, ?, ?, ?, ?, ? FROM sessions WHERE rowid = ?`);
  const select = database.prepare(`SELECT rowid, CASE WHEN length(CAST(id AS BLOB)) = ? THEN id END AS id,
    CAST(messages AS BLOB) AS messages FROM sessions ORDER BY rowid`);
  // A rowid can be any 64-bit integer, beyond what a JavaScript number holds exactly.
  select.setReadBigInts(true);
  for (const { rowid, id: stored, messages: bytes } of select.iterate(idBytes)) {
    // An error names a session by its ID when that is 64 lowercase hex characters, and
    // otherwise by its row, so it prints no stored text.
    const id = /^[0-9a-f]{64}$/u.test(stored) ? stored : null;
    const parsed = bytes instanceof Uint8Array ? parseArray(decoder, bytes) : null;
    if (!parsed) throw new Error(migrationFailed(id, rowid, notAnArray));
    const { source, messages } = parsed;
    if (!messages.every(isMessage)) throw new Error(migrationFailed(id, rowid, notAMessage));
    const { elements: members, deepest } = scanMembers(source);
    if (deepest > maxDepth) throw new Error(migrationFailed(id, rowid, tooDeep));
    if (members.some(element => element.repeated)) throw new Error(migrationFailed(id, rowid, repeatedField));
    if (members.some(element => element.nulName)) throw new Error(migrationFailed(id, rowid, nulName));
    if (!members.every(element => lineToken.test(element.line))) throw new Error(migrationFailed(id, rowid, notAMessage));
    const lines = new Set();
    for (let seq = 0; seq < messages.length; seq += 1) {
      const message = messages[seq];
      if (lines.has(message.line)) throw new Error(migrationFailed(id, rowid, sameLine));
      lines.add(message.line);
      const textJson = JSON.stringify(message.text);
      const key = `l:${message.line}`;
      if (id) insert.run(id, seq, message.line, message.role, textJson, key);
      else insertByRow.run(seq, message.line, message.role, textJson, key, rowid);
    }
  }
}

const leftoverFailed = 'This ledger already has a messages table or trigger that schema version 3 did not create. ' +
  'The file was not changed.';
// Objects version 3 creates, or that would act on what it creates, already in the file.
// The step is one transaction, so a file below version 3 never holds its own: these come
// from elsewhere, and none of them is reused, replaced or dropped (review rounds 3 and 4).
const leftovers = `
  SELECT count(*) AS n FROM sqlite_master
  WHERE lower(name) IN ('messages', 'sessions_messages') OR lower(tbl_name) = 'messages'`;

const refuseNewer = version => {
  if (version > schemaVersion) {
    throw new Error(`This ledger database was written by a newer Context Ledger (schema ${version}). ` +
      'Use that version or another CONTEXT_LEDGER_DB.');
  }
};

/** Throws when the file now has a newer schema than this build; writes nothing. */
export function refuseNewerSchema(database) {
  refuseNewer(userVersion(database));
}

/**
 * Version 1 adds created_at and party to graphs and created_at to rooms, with indexes
 * for listing. Version 2 adds projects and puts every session in one: existing
 * sessions go to the default project, which the step creates. Version 3 adds one
 * messages row per turn: each session's JSON messages are copied in order with l:<line>
 * keys (copyStoredMessages), and one session that cannot be copied fails the whole step,
 * with an error that names it. A file that already has a messages table or a
 * sessions_messages trigger is refused. A turn's text is kept as a JSON string literal
 * (text_json), which is lossless.
 * Every step checks the schema itself, so it is safe to repeat and does not depend on
 * the order in which other branches add their own steps.
 *
 * The triggers stamp new rows from any insert path, including an older build that
 * opens a migrated file: graphs and rooms get created_at, and a session inserted
 * without a project joins the default one. SQLite cannot add a NOT NULL column with a
 * foreign key, so sessions.project_id stays nullable and the trigger fills it.
 * sessions.messages stays as a copy that this build writes; sessions are read from rows,
 * and only the version 3 step and the sessions_messages trigger read the column. A build
 * from before versions (which never reads user_version) keeps working on the file; the
 * sessions_messages trigger gives a session it inserts its rows. The import writes its
 * rows before the session, which is why messages.session_id is a deferred foreign key.
 * Recreate the triggers if graphs, rooms or sessions is ever rebuilt.
 *
 * bootstrap creates the tables of the oldest schema (CREATE TABLE IF NOT EXISTS). It
 * runs only under the write lock, after the version is read again, so a file that a
 * newer build upgrades while this one opens it is refused before any DDL touches it.
 * A file already at this version is opened with no lock and no DDL.
 */
export function migrate(database, bootstrap = () => {}) {
  const current = userVersion(database);
  refuseNewer(current);
  if (current === schemaVersion) return;

  database.exec('BEGIN IMMEDIATE');
  try {
    // Another process may have migrated while this one waited for the lock.
    const version = userVersion(database);
    refuseNewer(version);
    if (version < schemaVersion) bootstrap();
    if (version < 1) {
      const graphColumns = columns(database, 'graphs');
      if (!graphColumns.has('created_at')) database.exec('ALTER TABLE graphs ADD COLUMN created_at TEXT');
      if (!graphColumns.has('party')) database.exec('ALTER TABLE graphs ADD COLUMN party TEXT');
      database.exec(`UPDATE graphs SET party = ${packetParty('payload')} WHERE party IS NULL`);
      if (!columns(database, 'rooms').has('created_at')) database.exec('ALTER TABLE rooms ADD COLUMN created_at TEXT');
      database.exec(`
        CREATE INDEX IF NOT EXISTS graphs_session_id ON graphs(session_id);
        CREATE INDEX IF NOT EXISTS graphs_party ON graphs(party);
        CREATE INDEX IF NOT EXISTS rooms_graph_a ON rooms(graph_a);
        CREATE INDEX IF NOT EXISTS rooms_graph_b ON rooms(graph_b);
        CREATE TRIGGER IF NOT EXISTS graphs_stamp AFTER INSERT ON graphs BEGIN
          UPDATE graphs SET created_at = ${now}, party = ${packetParty('NEW.payload')} WHERE rowid = NEW.rowid;
        END;
        CREATE TRIGGER IF NOT EXISTS rooms_stamp AFTER INSERT ON rooms BEGIN
          UPDATE rooms SET created_at = ${now} WHERE rowid = NEW.rowid;
        END;
        PRAGMA user_version = 1;
      `);
    }
    if (version < 2) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          slug TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          created_at TEXT NOT NULL
        ) STRICT;
        INSERT INTO projects (id, slug, name, created_at)
          VALUES (lower(hex(randomblob(16))), '${defaultProject}', 'Default', ${now})
          ON CONFLICT (slug) DO NOTHING;
      `);
      if (!columns(database, 'sessions').has('project_id')) {
        database.exec('ALTER TABLE sessions ADD COLUMN project_id TEXT REFERENCES projects(id)');
      }
      const defaultId = `(SELECT id FROM projects WHERE slug = '${defaultProject}')`;
      database.exec(`
        UPDATE sessions SET project_id = ${defaultId} WHERE project_id IS NULL;
        CREATE INDEX IF NOT EXISTS sessions_project_id ON sessions(project_id);
        CREATE TRIGGER IF NOT EXISTS sessions_project AFTER INSERT ON sessions WHEN NEW.project_id IS NULL BEGIN
          UPDATE sessions SET project_id = ${defaultId} WHERE rowid = NEW.rowid;
        END;
        PRAGMA user_version = 2;
      `);
    }
    if (version < 3) {
      if (database.prepare(leftovers).get().n > 0) throw new Error(leftoverFailed);
      database.exec(`
        CREATE TABLE messages (
          id INTEGER PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
          seq INTEGER NOT NULL,
          line INTEGER NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
          text_json TEXT NOT NULL,
          key TEXT NOT NULL,
          UNIQUE (session_id, key),
          UNIQUE (session_id, seq)
        ) STRICT;
      `);
      // Every row is new, so the deferred key checks all of them at commit.
      copyStoredMessages(database);
      database.exec(`
        CREATE TRIGGER sessions_messages AFTER INSERT ON sessions
        WHEN NOT EXISTS (SELECT 1 FROM messages WHERE session_id = NEW.id) BEGIN
          ${insertRows} ${legacyRows('NEW.id', 'NEW.messages')} ORDER BY m.key;
        END;
        PRAGMA user_version = 3;
      `);
    }
    if (version < 4) {
      // Card P2b (ADR-7b): artifacts a version 3 graph can cite, per project.
      database.exec(`
        CREATE TABLE artifacts (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id),
          kind TEXT NOT NULL CHECK (kind IN ('commit', 'pr', 'file')),
          repo TEXT NOT NULL,
          ref TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE (project_id, kind, repo, ref)
        ) STRICT;
        PRAGMA user_version = 4;
      `);
    }
    if (version < 5) {
      // Card P2c (ADR-7c): a person's decision on one version 3 node, by its hash.
      database.exec(`
        CREATE TABLE node_reviews (
          session_id TEXT NOT NULL,
          party TEXT NOT NULL,
          node_id TEXT NOT NULL,
          node_sha256 TEXT NOT NULL,
          decision TEXT NOT NULL CHECK (decision IN ('approve', 'reject')),
          reviewer TEXT NOT NULL,
          decided_at TEXT NOT NULL,
          PRIMARY KEY (session_id, party, node_id, node_sha256)
        ) STRICT;
        PRAGMA user_version = 5;
      `);
    }
    if (version < 6) {
      // Card I3: a Codex message between two agents is a turn of its own, with the paths
      // of the agent that sent it and the one it went to. SQLite cannot change a CHECK, so
      // the table is rebuilt with the same rows, and the trigger that names it is recreated.
      if (!columns(database, 'messages').has('author')) {
        database.exec(`
          DROP TRIGGER IF EXISTS sessions_messages;
          CREATE TABLE messages_v6 (
            id INTEGER PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
            seq INTEGER NOT NULL,
            line INTEGER NOT NULL,
            role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'agent')),
            text_json TEXT NOT NULL,
            key TEXT NOT NULL,
            author TEXT,
            recipient TEXT,
            CHECK ((role = 'agent') = (author IS NOT NULL AND recipient IS NOT NULL)),
            UNIQUE (session_id, key),
            UNIQUE (session_id, seq)
          ) STRICT;
          INSERT INTO messages_v6 (id, session_id, seq, line, role, text_json, key)
            SELECT id, session_id, seq, line, role, text_json, key FROM messages;
          DROP TABLE messages;
          ALTER TABLE messages_v6 RENAME TO messages;
          CREATE TRIGGER sessions_messages AFTER INSERT ON sessions
          WHEN NOT EXISTS (SELECT 1 FROM messages WHERE session_id = NEW.id) BEGIN
            ${insertRows} ${legacyRows('NEW.id', 'NEW.messages')} ORDER BY m.key;
          END;
        `);
      }
      database.exec('PRAGMA user_version = 6;');
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
