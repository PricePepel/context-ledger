// Schema versions of ledger.sqlite, kept in PRAGMA user_version. A file written before
// versions existed is version 0 and is upgraded in place when a store opens it.
export const schemaVersion = 1;

const userVersion = database => database.prepare('PRAGMA user_version').get().user_version;
const columns = (database, table) => new Set(database.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name));

// The packet's own party, or null for v1 packets and payloads that are not JSON.
const packetParty = payload => `CASE WHEN json_valid(${payload}) THEN
    CASE WHEN json_type(${payload}, '$.packet.party') = 'text' THEN json_extract(${payload}, '$.packet.party') END END`;
const now = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/**
 * Version 1 adds created_at and party to graphs and created_at to rooms, with indexes
 * for listing. Every step checks the schema itself, so it is safe to repeat and does
 * not depend on the order in which other branches add their own steps.
 *
 * The triggers stamp new rows from any insert path, including an older build that
 * opens a migrated file. Recreate them if graphs or rooms is ever rebuilt.
 */
export function migrate(database) {
  const refuseNewer = version => {
    if (version > schemaVersion) {
      throw new Error(`This ledger database was written by a newer Context Ledger (schema ${version}). ` +
        'Use that version or another CONTEXT_LEDGER_DB.');
    }
  };
  refuseNewer(userVersion(database));
  if (userVersion(database) === schemaVersion) return;

  database.exec('BEGIN IMMEDIATE');
  try {
    // Another process may have migrated while this one waited for the lock.
    const version = userVersion(database);
    refuseNewer(version);
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
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
