# Ledger Handover v1: target architecture

Status: proposed, 2026-11-06. Inputs: [product plan](https://github.com/PricePepel/context-ledger/blob/product/v1/docs/strategy/product-plan.md), [engineering gaps](https://github.com/PricePepel/context-ledger/blob/product/v1/docs/strategy/research-engineering-gaps.md) (both on `product/v1`), [handoff](handoff.md), [evals](evals.md).

> **Landed on `main` 2026-11-17 (card P1, design part).** The text below is the 2026-11-06 design from `product/v1`, unchanged except for these links. It stays a proposal: "accepted" in section 9 means accepted once P1's owner approves the pull request that lands it. Until ADR-003 is decided (card P1a), no new runtime dependency is added. Section 11 lists where `main` has moved since the design was written. **P1a proposes revising ADR-003 (§5.1).** Every mention of better-sqlite3 below (the §3 diagram, the §5 table and its mitigations, the supply-chain row in §6, the §7 store row and the §10 driver gate) is the original 2026-11-06 plan. While P1a is pending, the original stands. Once the user approves P1a, §5.1 supersedes those passages: they stay only as the record of the earlier plan, better-sqlite3 is not a dependency, and FTS5-only behaviour in §§4, 6 and 7 applies only where FTS5 is present. If P1a is rejected, §5.1 is removed, ADR-003 in §9 goes back to its original entry, and the lifecycle text that refers to §5.1 (this note, the sentence on newer builds in the paragraph below it, §4's store-managed index block and `fts_pending`, and the FTS5 clauses in §6) returns to the original design.

Checked locally on 2026-11-06: Node 22.14.0's `node:sqlite` bundles SQLite 3.47.2 built without FTS3, FTS4, FTS5 or R-Tree. `CREATE VIRTUAL TABLE t USING fts5(x)` fails with `no such module: fts5`. That result was the reason for the original ADR-003; §5.1 records newer builds that do have FTS5.

## 1. Constraints

- Transcripts are client IP and may hold credentials. v1 sends nothing over the network; only the agency-delivered export bundle leaves the machine.
- Every claim cites a stored message or repo artifact and is approved by a named human.
- Vendor formats are undocumented. Parsers detect the format version and fail closed on anything unknown.
- `npx` install on Windows, macOS and Linux with minimal, prebuilt dependencies.
- Team and hosted interfaces are fixed now; implementations come later.

## 2. System context

```mermaid
flowchart LR
  dev[Agency developer] -->|runs| agents[Claude Code / Codex]
  agents -->|writes JSONL| files[(local transcript files)]
  files -.->|read only on explicit import| L[Ledger Handover, local]
  agents <-->|stdio MCP| L
  reviewer[Agency reviewer] -->|loopback UI: approve, edit, redact| L
  L -->|signed bundle, delivered by agency| client[Client]
  client -->|ledger verify or openssl| bundle[(bundle + manifest.sig)]
  L -.->|stage 2+: event sync| relay[Relay / hosted tier]
  vendor[Vendor] -.->|offline signed license| L
```

## 3. Components

```mermaid
flowchart TB
  subgraph Interfaces
    CLI[CLI] --- HTTP[Loopback HTTP + UI] --- MCP[stdio MCP]
  end
  subgraph Core[createLedger application service]
    ING[Ingest pipeline] --> AD[Adapters per provider x format version]
    PKT[Packet engine: graph v2]
    APR[Approval: event fold + export gate]
    RED[Redaction + excerpt clearance]
    EXP[Export bundle] --> SIG[Ed25519 sign / verify]
    LIC[License check, Pro]
  end
  subgraph Ports[Storage ports]
    REPO[(Repos + EventLog)]
    IDX[(SearchIndex)]
    BLOB[(BlobStore)]
  end
  Interfaces --> Core --> Ports
  REPO --- DB[(better-sqlite3, WAL)]
  IDX --- FTS[(FTS5)]
  BLOB --- FS[(data dir)]
```

**Ingest adapters.** An adapter is `{ provider, detect(headLines) -> formatVersion | null, parse(lineStream) -> AsyncIterable<Record> }`, registered by `(provider, formatVersion)`.
- Detection fingerprints the first records (Claude `version`/`uuid`, Codex `session_meta.payload.cli_version`). An unknown fingerprint raises `UnsupportedFormatError` and writes nothing.
- Parsing streams through `readline` with a 16 MiB line cap, so disk import skips the 8 MiB HTTP limit (gap 3).
- Today's `messageAt` and Codex filters become the `v1` adapters. Each format version gets a contract fixture.

**Incremental import.** `sources` stores `bytes_read` and the `prefix_sha256` of those bytes. On re-import, a matching prefix means only the tail is parsed. A mismatch means the file was rewritten, and the import fails with `TranscriptRewrittenError` instead of remapping IDs.

**Ledger core.** `createLedger({ dataDir, driver })` is the only code that touches storage. The CLI, HTTP and MCP call it in-process. The CLI no longer needs a server (gap 7), and the server becomes `createServer(ledger)` (gap 6).

**Packet engine.** Graph v2 is project-scoped. Node IDs are stable slugs. A citation is either `{ session, message, range? }` or `{ artifact }`. Validation runs cheapest first:
1. Ajv schema.
2. Referential: every citation resolves, and sidechain or compact-summary messages are never primary evidence.
3. Structural: the existing edge and cycle checks.
4. Derived: ready actions and current decisions.

Version ID = SHA-256 of canonical JSON (idempotent retries). Each node has a `node_sha256` over kind, label, status and citations.

**Approval workflow.** Review state is a fold over the append-only `events` table: `node.approved`, `node.edited`, `node.rejected`, `excerpt.cleared`, `packet.exported` and `key.rotated`.
- Approvals bind to a `node_sha256`. On re-publish, unchanged nodes keep approval and changed nodes reset.
- Export is allowed only when every node's latest decision approves its current hash, and every excerpt has a hash-matched `excerpt.cleared`.

**Redaction** works on cited excerpts, never on whole sessions.
- Detectors: regex for cloud keys, GitHub, Slack, Stripe and JWT tokens, PEM blocks, connection strings, emails, IPs and home paths, plus an entropy check (20 or more characters at 4.0 or more bits per character).
- The reviewer sees a diff, adjusts it and clears each excerpt.
- Any unresolved hit blocks export.

**Export bundle.** The builder accepts only cleared excerpts and approved nodes and has no handle on the message repository, so uncited text cannot reach the bundle. Output is a deterministic directory and stored-mode zip:
- `index.html`: no JavaScript, and a CSP meta tag of `default-src 'none'` with hashed styles.
- `packet.md` and `packet.json`
- `manifest.json`, `manifest.sig` and `VERIFY.txt`

**Signing.** `manifest.json` holds each file's SHA-256 and size, the packet and version IDs, the event-log head hash, the reviewers, the key ID and the time. It is serialized with RFC 8785 (JCS) and signed with raw Ed25519 from `node:crypto`, so signing adds no dependency.
- `ledger verify <bundle> --key <fingerprint>` checks the signature and every file hash. `VERIFY.txt` gives the OpenSSL 3 equivalent (`pkeyutl -verify -rawin`).
- The trust anchor is the key fingerprint, published out of band (in the SOW or `/.well-known/ledger-keys.json`).
- A signature proves authorship and integrity, not completeness.

**Interfaces.**
- **CLI:** everything, plus `serve`, `open` and `doctor`.
- **HTTP and UI:** browse and review.
- **stdio MCP:** `ledger_search`, `ledger_handoff` and `ledger_graph_read` are read-only. `ledger_import` ingests only paths the user names, and `ledger_graph_publish` writes drafts. No MCP tool can approve, clear, sign or export.

## 4. Data model

**Identity.**
- **Session:** `<provider>:<provider session UUID>`. From Claude `sessionId` or Codex `session_meta.payload.id`; fallback `h:` plus SHA-256 of the first non-empty line, which appends never change.
- **Message key:** `u:<record uuid>` where one exists (Claude). Otherwise (Codex `response_item`s) it is `h:` plus 32 hex characters of `sha256(sessionId \0 line \0 rawLineBytes)`. The line is part of the hash so identical "ok" turns stay distinct.
- **Duplicate UUIDs:** if the bytes are identical (a resumed session), the record is skipped. If the bytes differ, the import fails with `ConflictingRecordError`.
- **Citation ID:** `<sessionId>/<key>`. `messages.id` is only the FTS rowid and is never exported. File and line stay on every message, so v1 line citations still resolve.

```sql
-- migrations/0001_init.sql: one transaction, then PRAGMA user_version = 1
-- also: schema_migrations(version, name, sha256, applied_at); settings(key, value) for token hash, license, max_seen_time
CREATE TABLE projects (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  client TEXT, retention_days INTEGER, created_at TEXT NOT NULL) STRICT;
CREATE TABLE sources (id INTEGER PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects ON DELETE CASCADE,
  provider TEXT NOT NULL, format_version TEXT NOT NULL, file_name TEXT NOT NULL,
  bytes_read INTEGER NOT NULL, prefix_sha256 TEXT NOT NULL, imported_at TEXT NOT NULL) STRICT;
CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects ON DELETE CASCADE,
  provider TEXT NOT NULL, provider_session_id TEXT NOT NULL, legacy_id TEXT UNIQUE, title TEXT NOT NULL,
  started_at TEXT, message_count INTEGER NOT NULL DEFAULT 0, UNIQUE (provider, provider_session_id)) STRICT;
CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions ON DELETE CASCADE,
  key TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  text TEXT NOT NULL, source_id INTEGER NOT NULL REFERENCES sources ON DELETE CASCADE,
  source_line INTEGER NOT NULL, record_sha256 TEXT NOT NULL, flags INTEGER NOT NULL DEFAULT 0, -- 1 sidechain, 2 compact
  ts TEXT, UNIQUE (session_id, key), UNIQUE (session_id, seq)) STRICT;
CREATE TABLE fts_pending (message_id INTEGER PRIMARY KEY) STRICT; -- §5.1: rows written while the FTS5 index could not be updated
CREATE TABLE artifacts (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('commit','pr','file')), repo TEXT NOT NULL, ref TEXT NOT NULL,
  UNIQUE (project_id, kind, repo, ref)) STRICT;
CREATE TABLE actors (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('human','agent')),
  display_name TEXT NOT NULL, public_key TEXT) STRICT;
CREATE TABLE packets (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects ON DELETE CASCADE,
  title TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
CREATE TABLE packet_versions (id TEXT PRIMARY KEY, packet_id TEXT NOT NULL REFERENCES packets ON DELETE CASCADE,
  seq INTEGER NOT NULL, schema_version INTEGER NOT NULL, payload TEXT NOT NULL,
  published_by TEXT NOT NULL REFERENCES actors, created_at TEXT NOT NULL, UNIQUE (packet_id, seq)) STRICT;
CREATE TABLE nodes (version_id TEXT NOT NULL REFERENCES packet_versions ON DELETE CASCADE, node_id TEXT NOT NULL,
  kind TEXT NOT NULL, label TEXT NOT NULL, node_sha256 TEXT NOT NULL, PRIMARY KEY (version_id, node_id)) STRICT, WITHOUT ROWID;
CREATE TABLE citations (version_id TEXT NOT NULL, node_id TEXT NOT NULL,
  message_id INTEGER REFERENCES messages, artifact_id TEXT REFERENCES artifacts,
  char_start INTEGER, char_end INTEGER, is_primary INTEGER NOT NULL,
  FOREIGN KEY (version_id, node_id) REFERENCES nodes ON DELETE CASCADE,
  CHECK ((message_id IS NULL) <> (artifact_id IS NULL))) STRICT;
CREATE TABLE events (seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE,
  packet_id TEXT NOT NULL REFERENCES packets ON DELETE CASCADE, actor_id TEXT NOT NULL REFERENCES actors,
  type TEXT NOT NULL, target TEXT, payload TEXT NOT NULL, prev_hash TEXT, hash TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
CREATE TABLE purge_guard (project_id TEXT PRIMARY KEY) STRICT; -- non-empty only inside a purge transaction
CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events WHEN NOT EXISTS (SELECT 1 FROM purge_guard)
  BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TABLE signing_keys (id TEXT PRIMARY KEY, label TEXT NOT NULL, public_key_pem TEXT NOT NULL,
  private_key_pem_enc TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT) STRICT;
CREATE TABLE exports (id TEXT PRIMARY KEY, packet_id TEXT NOT NULL REFERENCES packets ON DELETE CASCADE,
  version_id TEXT NOT NULL REFERENCES packet_versions, key_id TEXT NOT NULL REFERENCES signing_keys,
  bundle_sha256 TEXT NOT NULL, manifest TEXT NOT NULL, signature TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
```

Under §5.1 the full-text index is not part of this migration. The store creates it, only where FTS5 is available, and keeps it in sync itself:

```sql
-- store-managed, created on an open that finds FTS5 (§5.1); never in a migration, no triggers
CREATE VIRTUAL TABLE messages_fts USING fts5(text, content='messages', content_rowid='id',
  tokenize='unicode61 remove_diacritics 2');
INSERT INTO messages_fts(messages_fts, rank) VALUES ('secure-delete', 1);
```

**What the schema enforces:**
- `citations.message_id` has no cascade, so retention cannot remove a cited message.
- Events are immutable. Each one stores `hash = sha256(prev_hash ‖ JCS(event))`. This catches partial or accidental tampering, though not a determined owner of the file, and the signed manifest freezes the head hash.
- `provider` has no `CHECK` constraint. The adapter registry validates it, so a new provider doesn't need a table rebuild (gap 4).

**Migrations.**
- Forward-only numbered SQL files ship in the package. Each runs in one transaction, records its checksum and bumps `PRAGMA user_version`.
- `VACUUM INTO 'backups/ledger-v<N>.sqlite'` runs before migrating. Backups expire after 7 days or on purge.
- A database newer than the code fails with `SchemaTooNewError`. Constraint changes use SQLite's 12-step rebuild.
- `0002_import_v0` turns today's `sessions` and `graphs` into legacy sessions. `legacy_id` keeps the existing `sessions.id` unchanged, which is `sha256(provider, a NUL, the decoded transcript text)` (the design first wrote `sha256(provider \0 file)`; corrected by P1a), and keys become `l:<line>`, so v1 packets still validate. Re-importing the same bytes reproduces that hash and links the legacy session to its UUID session.
- Postgres migrations live in `migrations/pg/`. One repository contract suite runs against both databases.

## 5. Storage decision and interface

| Option | FTS5 | Install | Verdict |
|---|---|---|---|
| `node:sqlite` (Node 22.14) | No (checked) | Zero deps; experimental | Rejected for v1 |
| `better-sqlite3` | Compiled in | Prebuilt binaries for Node LTS on win-x64, darwin-x64/arm64, linux-x64/arm64 | **Chosen.** Stable synchronous API close to `DatabaseSync`; `better-sqlite3-multiple-ciphers` is the SQLCipher path |
| Our own inverted index on `node:sqlite` | Hand-rolled | Zero deps | Rejected: ~70M posting rows at 1.2M messages, far larger than FTS5 doclists |
| sql.js (wasm) | Yes | Zero native | Rejected: whole database in memory, no WAL |
| Require a newer Node whose SQLite has FTS5 | Not confirmed | Forces a Node upgrade | Revisit once `node:sqlite` is stable |

Search is a v1 feature, and without FTS5 it has no ranking, snippets or acceptable latency at the §7 target. The native-binary risk is contained three ways:
- `ledger doctor` names the platform on a load failure.
- The wave-5 clean-VM install eval on 3 OSes is the gate.
- A `node:sqlite` test driver stays in CI with `LIKE` search and a named "degraded search" warning, so the port is tested on two engines.

Open sets WAL, `busy_timeout = 5000`, `foreign_keys = ON` and `secure_delete = ON`; CLI and server share the file through short single-writer transactions.

### 5.1 Storage engine decision, revisited (card P1a, 2026-11-17)

**Proposed: stay on `node:sqlite`.** ADR-003 chose better-sqlite3 because Node 22.14's `node:sqlite` had no FTS5. That reason no longer holds for current Node 22 builds:

| Build | SQLite | FTS5 | Source |
| --- | --- | --- | --- |
| Node 22.14.0, win32-x64 (local) | 3.47.2 | no | `tests/sqlite-fts5-probe.test.mjs` |
| Node 22.23.4, linux-x64 (CI, `setup-node` 22) | 3.53.4 | yes | the same probe, [CI run 44253667145](https://github.com/PricePepel/context-ledger/actions/runs/44253667145), 2026-11-17 |
| Node 22.19.0, linux-x64 | — | no | public report: colbymchenry/codegraph#1532 (not checked here) |
| Node 22.22.2, platform not stated | — | yes | public report: openclaw/openclaw#62328 (not checked here) |

These are capability checks of particular builds. They suggest, but do not prove, that FTS5 arrived in a 22.x release after 22.19, so the code must probe rather than trust a version number.

- **Decision:** keep `node:sqlite` and add no runtime dependency. At open, probe FTS5 with `CREATE VIRTUAL TABLE … USING fts5` on an in-memory database.
- **FTS5 is an optional index, never part of the canonical schema** (review round 1, high), so one database stays readable and writable on builds with and without FTS5:
  - Migrations never create it. The store creates `messages_fts` only when the probe finds FTS5, and no trigger on `messages` refers to it, since a trigger naming a missing module would break every write on a build without FTS5.
  - The store indexes message rows itself, with no watermark over `messages.id`: that is a plain `INTEGER PRIMARY KEY`, and SQLite can reuse a deleted row's ID (review round 2, medium). Instead, every message insert made while the index cannot be updated (no FTS5 in this build, but an index exists from an earlier one) also adds the row's ID to an ordinary `fts_pending` table, in the same transaction as the insert.
  - A process with FTS5 drains `fts_pending` whenever it may be behind, not only at open (review round 3, medium): at open; for each indexed search, inside one write transaction that drains and then runs the `MATCH` query, so the search sees one snapshot that includes every message committed before it began (review round 4, medium); and inside the transaction of each delete or purge, before it issues FTS5 `delete` commands. Draining indexes those rows from `messages` and removes them from `fts_pending` in one transaction, so index changes and their bookkeeping commit together. This covers a module-free CLI appending while an FTS5 server has the same file open. The check is one indexed lookup when the table is empty. Because a delete drains first, the FTS5 `delete` command is only ever issued for rows that are indexed, with the text they were indexed with (messages are never edited in place). Deletes are refused on a build without FTS5 while an index exists (below), so a pending ID cannot be deleted and reused before it is drained.
  - When no index exists yet, nothing is logged. The first open with FTS5 builds the whole index from `messages` and empties `fts_pending` in the same transaction. A missing or damaged index is dropped and rebuilt the same way.
  - Deletion and purge with FTS5 (review round 2, high): with no triggers, nothing cascades into the index. In the same transaction as the canonical delete, and before the message rows go, the store removes each one from the index with FTS5's `delete` command and the row's original text (`INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', id, text)`), as an external-content table requires. FTS5 `optimize` runs afterwards only when an index exists.
  - Deletion and purge on a build without FTS5, when an index exists from an earlier build: the index still holds tokens of the deleted text, and it cannot be edited without the module. Such a delete is refused with a message naming the fix (open on an FTS5 build, or rebuild without the index). With no index, a delete needs nothing more.
  - The same applies to the automatic deletes in §6 (review round 3, medium). A scheduled retention run that is blocked this way deletes nothing, records a "blocked" run with its reason and the number of messages it would have removed, and the server, CLI and `ledger doctor` show that until a run succeeds. An evidence-only export still writes its bundle, but reports that the cleanup after it did not run, and why. It also records the export's pending cleanup (its project and the cited messages to keep) in `settings`, and every later retention run that can update the index carries out recorded cleanups before its own `retention_days` pass, clearing each record in the same transaction as its deletes (review round 4, medium).
  - Tests, in the card that builds this (P1c and its follow-up): a forced-fallback switch covers the application's branches, but it cannot prove downgrade compatibility, because SQLite still has the module registered (review round 2, medium). So the same database must also be reopened on a genuinely module-free build (Node 22.14.0, which CI can pin in its own job): search it, append to it, and check that delete and purge are refused; then reopen on an FTS5 build and check that the pending rows were indexed and nothing was missed. Fresh opens, upgrades, and purge in both modes are covered too.
- **The fallback search contract** (review rounds 1 and 2) is today's, unchanged: a session matches when every distinct whitespace-separated term, lowercased, appears somewhere in the session's lowercased title or message text (across messages, not within one); results are sessions in descending session `rowid` order (most recently imported first), paged by the same cursor of the last ID shown; the optional provider filter applies as today; an empty or whitespace-only query matches every session the filter allows; and there is no ranking or snippet. §7's latency targets apply only with FTS5. With FTS5, search returns ranked message hits with snippets.
- The server, CLI and `ledger doctor` name the "degraded search" mode. `doctor` tells the user to rerun its capability check after upgrading Node, rather than naming a version. CI keeps a switch that forces the fallback, so both paths stay tested.
- **Why not better-sqlite3:** it is a native addon per platform and Node ABI. Prebuilt binaries cover the common targets, but where none fits, `npm install` falls back to compiling from source, which is the riskiest part of an `npx` install on three systems (the wave-5 gate). It would also be a second runtime dependency, which AGENTS.md allows only with an approved ADR. Its synchronous API is close to `node:sqlite`'s, so switching later stays cheap if `node:sqlite` proves unstable or too slow.
- **Still open:** the same probe on Windows and macOS CI runners (P5a, #38, runs Node suites on all three, so its first run after this lands records them); and whether `package.json` should require a minimum Node 22.x once the first release with FTS5 is known.
- **Accepted when:** P1's owner (the user, who approved the P1 takeover) approves the pull request that lands this section. Until then, ADR-003 stands as written and no dependency is added either way.

**Storage port.** Every method is async, so a Postgres implementation needs no caller changes.

```ts
interface LedgerStorage { tx<T>(scope: { workspaceId: string }, fn: (r: Repos) => Promise<T>): Promise<T> } // 'local' in v1
interface Repos {
  projects; sources; sessions; messages; artifacts; packets; actors; keys; exports;
  search: SearchIndex; // query({ q, projectId, provider, before, after, limit }) -> hits with snippets
  events: EventLog;    // append(events, expectedHeadHash), since(cursor), head(packetId)
  blobs: BlobStore;    // put(bytes) -> sha256, get, delete
}
```

Locally, blobs are files in the data directory. The hosted implementation maps the repos to Postgres with row-level security on `workspace_id`, search to `tsvector` with a GIN index, and blobs to S3-compatible storage. Domain code never sees SQL.

## 6. Security and privacy

**Authentication.**
- First run writes a 256-bit token to `<dataDir>/auth-token` (0600) in the OS data directory (0700). Only `sha256(token)` is stored; comparison is timing-safe.
- Every `/api` route, GET included, requires the bearer token or session cookie, else 401.
- The token never reaches the browser. `ledger open` mints a single-use nonce valid for 60 seconds. `/auth/<nonce>` exchanges it for an `HttpOnly; SameSite=Strict` cookie.
- stdio MCP has no listener, and whoever can spawn it can already read the file, so it trusts the OS user.

**Browser boundary.** Today's protections stay: the Host allowlist (which blocks DNS rebinding), the exact Origin check on writes, JSON-only bodies, the streamed body cap, CSP, `nosniff`, `no-store`, no CORS, and binding to 127.0.0.1 only.

**Data at rest.** v1 relies on OS account isolation, the 0700 directory and full-disk encryption, which `ledger doctor` checks where the OS reports it. The signing key is passphrase-encrypted PKCS#8 (AES-256 via `node:crypto`). SQLCipher is deferred to Enterprise, because key recovery for a local tool costs more than it protects once full-disk encryption is on.

**Purge and retention.**
- Purge is one transaction: set `purge_guard`, remove the project's messages from the FTS5 index with the `delete` command when an index exists (§5.1; a build without FTS5 refuses while an index exists), delete the project (cascading to sessions, messages, packets, events), clear the guard. Then FTS5 `optimize` (only when an index exists), `wal_checkpoint(TRUNCATE)`, `VACUUM`, and backup deletion.
- The eval scans raw `.sqlite`, `-wal` and `backups/` bytes for fixture text.
- Retention removes uncited messages older than `retention_days` (startup and hourly). "Evidence-only" mode keeps only cited messages after export.

| Threat | Control | Residual |
|---|---|---|
| Another local process reads the API | Token or cookie on every route; token file mode 0600 | Same-user malware reads the file directly |
| Website attacks 127.0.0.1 (CSRF, DNS rebinding) | Host allowlist, exact Origin, SameSite=Strict, JSON only, no CORS | Low |
| Prompt injection makes the agent draft false nodes | MCP cannot approve or sign; referential validation; human approves each node hash beside its evidence | Reviewer approves a wrong claim |
| XSS from transcript text | `textContent` only, strict CSP, no JS in the bundle, bidi and control escaping | Low |
| Secrets leak to the client | Allowlisted excerpts, detectors, per-excerpt sign-off, fail closed, a seeded 200-secret eval | Novel secret formats |
| Bundle altered after delivery | Ed25519 over a manifest of file hashes; verifiable with OpenSSL | None, if the fingerprint is pinned out of band |
| Signing key stolen | Passphrase encryption, `key.rotated` events, published revocation list | Bundles signed before revocation |
| Reviewer denies approving | Named actor, hash-chained events, head hash in the signed manifest | Identity is self-asserted until stage 2 |
| Format drift drops or leaks turns | Version detection, fail closed, fixture per version, 3-OS CI | Blocked until an adapter ships |
| Supply chain | Two runtime deps (`ajv`, `better-sqlite3`), lockfile, npm provenance | Medium |

## 7. Scaling path

**Capacity per agency per year.** Assumptions: 15 developers, 220 working days, 3 client sessions per developer per day, which gives about 10k sessions. Each session averages about 120 text messages of about 700 bytes (tool output excluded).

| Case | Volume | Text | FTS5 index | DB size per year |
|---|---|---|---|---|
| Import everything | 1.2M messages | ~0.85 GB | ~0.6 GB | ~1.8 GB |
| Realistic v1 (20 projects × 100 sessions) | 240k messages | — | — | ~0.35 GB |
| Review events (50 packets × 100 nodes × 6) | ~30k events | — | — | negligible |

**Targets** (laptop SSD, 1.5M-message ceiling, ~3 GB): FTS5 bm25 search with 50 snippets p95 < 50 ms (< 150 ms filtered); import ≥ 20 MB/s; validating 100 nodes and 1,000 citations < 100 ms; 1,000-excerpt export < 2 s.

| | Stage 1: local (v1) | Stage 2: team, self-hosted relay | Stage 3: hosted SaaS and enterprise self-host |
|---|---|---|---|
| Ingest | Local, explicit | Local on each machine | Still local. The cloud never pulls transcripts |
| Store | better-sqlite3 + FTS5 | Local store plus a relay (small Node service, SQLite or Postgres) | Postgres with RLS and hash-partitioned events, S3 blobs, Postgres FTS; OpenSearch only past ~100M messages |
| Sync | None | Push/pull events since a cursor: packets, events and cleared excerpts; transcripts opt-in. Optional E2E encryption to a project X25519 key | The same protocol, multi-tenant |
| Identity | Self-asserted name | Per-reviewer Ed25519 keys sign their events; approval policies such as "2 approvals, one lead" | OIDC SSO and SCIM, roles, audit export |
| Signing | Local key with passphrase | Lead's key, or per-reviewer co-signatures | KMS/HSM where Ed25519 is available, otherwise a local signer |
| Ops | npx | Docker image for the relay | Region pinning; self-host on the same images suits data-residency rules such as Uzbekistan's personal-data localization law |

**Merging without a CRDT library.** Messages and packet versions are immutable and content-addressed, so their union is conflict-free. Review decisions are events with a ULID, device ID and hybrid logical clock. Every replica folds the same events in `(hlc, id)` order and reaches the same state. Concurrent edits to one node are never auto-merged: the node becomes `conflicted` until a human resolves it. Yjs or Automerge would merge silently and break "a named human approved exactly this".

**Stays the same at every stage:** the graph v2 contract, event types and fold, adapters, manifest format, `ledger verify`, the MCP tools and the storage port. **Changes:** the storage implementation, identity, key custody and the sync layer.

## 8. Open-core boundary

| Apache-2.0 core | Commercial Pro (source-available) |
|---|---|
| Adapters, import, incremental import, FTS search | Reviewer UI and export gate |
| Projects, delete, retention, token auth | Redaction detectors, diff and excerpt clearance |
| stdio MCP server, drafting skill | Signed HTML and Markdown bundle builder |
| Graph v2 schema, validator, Markdown handoff | White-label branding |
| `ledger verify` and the open manifest and bundle spec | Stage 2+: relay, multi-reviewer policies, SSO |

Verification stays free, so a client never needs a license to check a packet. Agencies pay for the workflow that produces it.

**Offline licenses.**
- A license is a JCS JSON document `{ licenseId, customer, plan, maxReviewers, features, issuedAt, expiresAt, graceDays: 30 }` signed with the vendor's Ed25519 key. The public key is embedded in Pro, and there is no phone-home.
- For a per-packet purchase, checkout receives only the random packet ULID. The returned token is bound to that ID, so it cannot be reused for another packet.
- If the license expires or is missing, everything stays readable and only signed export is blocked.
- A monotonic `max_seen_time` blunts clock rollback.
- A fork can strip the checks. The license serves honest agencies, not DRM. Stripe payment links trigger a vendor webhook that emails keys.

## 9. ADRs

Each is accepted once P1's owner approves this design (see the note at the top). Rejected alternatives in brackets.

1. Local-first, no egress in v1 [cloud ingest, day-one sync].
2. One in-process `createLedger` core behind CLI, HTTP and MCP [CLI as HTTP client, MCP daemon].
3. ~~better-sqlite3 with FTS5, §5 [`node:sqlite`, custom index, wasm].~~ **Proposed revision (P1a, 2026-11-17), accepted only when the user approves the P1a pull request; until then the original stands:** `node:sqlite`, with FTS5 when the running Node has it and `instr` search with a named "degraded search" warning when it does not; see §5.1 [better-sqlite3, custom index, wasm].
4. Session is `provider:uuid`; message key is the record UUID or a line-and-bytes hash [whole-file hash breaks on append; line-only misses rewrites].
5. Forward-only migrations with backups; refuse newer schemas [`IF NOT EXISTS` drift, untested down-migrations].
6. Append-only, hash-chained review events; state is a fold [mutable status columns].
7. Content-addressed versions; approval bound to node hash [per-version approval forces full re-review].
8. Allowlist export from cleared excerpts [blocklist redaction].
9. Raw Ed25519 over a JCS manifest, fingerprint out of band [PGP for UX; Sigstore, whose public log exposes client relationships; PAdES for CA cost].
10. Loopback token exchanged for a cookie; stdio trusts the OS user [token in the URL fragment].
11. Fail closed on unknown formats [best-effort parsing].
12. Team sync by event-log replication [CRDT libraries merge silently; a central database means cloud custody].
13. Apache-2.0 core plus Pro; offline signed licenses and packet-bound tokens [AGPL, online activation].
14. Hosted tier on Postgres and object storage behind the same port, ingest stays local [SQLite per tenant].

## 10. Wave mapping

Wave 1: ADRs 2–6 and 11, migrations 0001–0002, token auth, purge. Wave 2: graph v2 (ADR 7), MCP, artifact anchors. Wave 3: event fold and reviewer UI. Wave 4: ADRs 8–9. Wave 5: driver install gate and licensing (ADR 13). Stages 2–3 start only after product-plan gate G2.

## 11. Where `main` stands against this design (2026-11-17)

This records the `main` baseline (at the time this design landed) that the wave-1 cards start from. Where it differs from sections 1–10, this section is the current state.

- **Schema versions.** The current schema is version 1, kept in `PRAGMA user_version` by `src/migrate.mjs`. It adds `created_at` and `party` to graphs and `created_at` to rooms, and an unversioned file is upgraded to it when a store opens it. Section 4's `0001_init` therefore cannot be version 1: the migration sequence must be renumbered from version 2 (P1b's projects first) and must accept a version-1 file as its legacy input.
- **Storage engine.** `main` uses `node:sqlite` and searches `search_text` with `instr`; it has no FTS5 index. Section 5 calls better-sqlite3 "chosen", but that choice (ADR-003) is still open: card P1a decides between keeping `node:sqlite` and adopting better-sqlite3 with FTS5.
- **Wave 2 is partly built.** The stdio MCP server (`src/mcp/*`) and graph v2 with parties, links and rooms (`src/graph.mjs`, `src/rooms.mjs`) exist. Citations are still file line numbers, not message keys, and there are no projects.
- **Import.** On `main`, import happens only on the user's request, through `POST /api/import`. The browser takes a selected file under 8 MiB, the server caps the whole JSON request at 8 MiB, and one malformed line rejects the import. In open PRs: I2 (#33) skips and reports malformed lines; I1 (#35, on top of I2) adds `ledger import --provider claude|codex <file>`, which streams a file into SQLite without the server; I3 (#34) keeps plain-text Codex messages between agents and never stores encrypted content. A session is still one row holding all its messages as JSON, which is what P1c replaces.
- **Not started:** projects, per-message rows and stable keys, delete and retention, the loopback token, review events, redaction, signing and licensing.

## 12. Wave 2 decisions (P2, 2026-11-21)

The user approved these on 2026-11-21, when P2 was split into P2a–P2c. Where they differ from sections 3–4, they are the current plan.

- **ADR-7a, project scope (P2a).** A graph belongs to the project of the session it cites (P1b); the packet does not name a project. A link must point at a graph in the same project, and a room needs two graphs from one project; both are refused otherwise. `session_search`, `graph_list` and `room_list` take an optional `project` slug and, without one, cover every project as before; there is no default project setting. The HTTP list routes take the same `project` parameter, and their rows name the project.
- **ADR-7b, citations (P2b).** A new packet version 3 cites evidence as `evidence: [{ message: "<P1c key>" } | { artifact: "<artifact ID>" }]` instead of `evidenceLines`. Versions 1 and 2 stay valid and keep their line citations. Artifacts (a commit, a pull request or a file in a repository) are rows of a new per-project table, registered only through the CLI or the HTTP API, never found automatically. This is schema version 4.
- **ADR-7c, approval bound to a node hash (P2c).** Each version 3 node has a `nodeSha256`, SHA-256 of the JCS form of its kind, label, status, recipient and citations. A person approves or rejects a node hash in the browser, through a POST route with the API token or session cookie; no MCP tool can. When a graph is published again, a node whose hash is unchanged keeps its decision and a changed one has none. Decisions are plain rows for now; P3 turns them into the hash-chained events of ADR-6.
- **ADR-7d, who decides.** The ledger has no identities yet, so a decision records a reviewer name the person types. Like room parties, it is self-asserted, and the browser says so.

## 13. Packaging decisions (P5, 2026-11-21)

The user's answers of 2026-11-21, and the defaults taken under their standing instruction to use the recommended choices. ADR-13 (licensing) is not part of these.

- **ADR-15a, the package.** The package is publishable but not published: the user publishes it. Its name is `@pricepepel/context-ledger` (published with `--access public`), because `context-ledger` is taken on npm by an unrelated package; the command is `context-ledger`. A `files` allowlist ships `bin/`, `src/`, `public/`, `schemas/` and the latent rules, and nothing else. No new runtime dependency.
- **ADR-15b, one command.** `context-ledger start`, `context-ledger mcp`, and every `ledger` subcommand. Under the command an unset `CONTEXT_LEDGER_DB` is `~/.context-ledger/ledger.sqlite` (`USERPROFILE` on Windows), so the server, the CLI and the MCP adapter share one database and token file from any folder. A checkout keeps its own defaults.
- **ADR-15c, agents through npx.** Run through `npx`, `install` registers `npx -y --package <spec> context-ledger mcp` (through `cmd /c` on Windows). The spec must be a plain package name, a path or a host shorthand such as `github:owner/repo`, written with characters no shell treats specially; a URL (it can carry credentials) or a spec with a space or a shell character is refused, with the advice to install globally instead. A local path is made absolute. From a checkout or a global install, `node <path>/src/mcp.mjs` as before.

