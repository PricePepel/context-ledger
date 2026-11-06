# Context Ledger: productization audit (2026-11-06)

I read every tracked file and ran `npm run -s test:graph`: 9 of 9 pass on Node 22.14.0. There are about 2,100 lines in total. Nine commits, no LICENSE file, and `package.json` is still `"private": true`.

## 1. What is production quality and what is still prototype

**Production quality (keep it):**
- **Request hardening** (`src/server.mjs`):
  - Host allowlist, which also blocks DNS rebinding.
  - Same-origin check on every POST, plus a JSON content-type check.
  - Streamed 8 MiB limit, strict UTF-8 decoding.
  - CSP, nosniff and no-store headers.
- **Safe output** (`src/cli.mjs` `visibleText`/`terminalJson`): terminal and bidi escaping. `public/app.js` renders with `textContent` only.
- **Graph contract** (`src/graph.mjs`, `schemas/semantic-graph.schema.json`): strict Ajv validation, then checks for edge kinds, cycles and evidence lines, and derives ready actions and current decisions. This is the most reusable code in the repo.
- **Idempotent imports**: content-addressed and atomic (`src/store.mjs` `importTranscript`).
- **Test discipline**: synthetic fixtures, node tests and Playwright, run in CI (`.github/workflows/e2e.yml`).

**Prototype (rebuild or extend):**
- **Storage**: one row per transcript, with every message in a single JSON column (`sessions.messages`).
- **Search**: `instr()` over lowercased text. It scans every session, has no ranking, no snippets and no date or project filters.
- **UI**: `public/app.js` (163 lines) does import and search only. There is no graph view.
- **Parsers** handle two formats through reverse-engineered heuristics (`codexContextKinds`, envelope regexes).
- **Graphs are written by hand.** Nothing extracts them from a transcript.
- **No delete, retention or migrations.** There is no `created_at`, project or cwd metadata.
- **CI runs on Linux only.** No release pipeline.

## 2. Gaps to a product a stranger installs and pays for

Sizes are in engineer-weeks: S is 1 or less, M is 1–3, L is more than 3.

| Gap | Size | Reuse |
|---|---|---|
| **npx/global CLI**: `bin` entry, `ledger serve`, OS data dir instead of cwd `.context-ledger/`, Windows/macOS CI matrix | S | `cli.mjs`, `server.mjs` |
| **MCP server** (stdio): `search_sessions`, `get_handoff`, `publish_graph`, `read_graph` | S–M | Store and validator as-is. Move `handoff()` out of `cli.mjs` into a shared module. |
| **Auto-discovery with consent**: scan `~/.claude/projects/**/*.jsonl` and `~/.codex/sessions/**/rollout-*.jsonl`; per-project opt-in list; preview before ingesting | M (2) | `parseTranscript`, `messageAt` |
| **Incremental/live ingestion**: watch files, resume from a byte offset, one row per message | M–L (3) | `messageAt`. Needs the identity redesign in section 4. |
| **More formats** (provider adapter interface) | Gemini CLI and Aider: S each. Cursor: M. | `messageAt` pattern. The provider `CHECK` constraint must go. |
| **LLM graph extraction**: draft graph nodes from a transcript, then validate citations | M (2–3) | `validateGraph` as the guardrail. This is where most of the paid value is. |
| **Search**: FTS5, snippets, recency, project filter | S–M | Store API shape |
| **Secret/PII redaction** before storing and before sharing | M (2) | Ingest pipeline hook |
| **Delete, retention and schema migrations** | S | — |
| **Local auth**: per-install bearer token for the HTTP API and MCP. Today any local process can read every transcript. | S | Server middleware |
| **Team sync and sharing**: hosted API, Postgres, workspaces, ACLs, share links for handoff and graph packets | L (6–10) | Graph schema as the wire format. Content-addressed IDs make deduplication easy. |
| **Hosted auth** (OIDC via a provider such as WorkOS or Clerk), seats, roles | M (2–3) | — |
| **Encryption**: at rest locally (SQLCipher or OS keychain plus field encryption); end-to-end for sync | M local, L E2E | — |
| **Licensing and billing**: Stripe, license key with offline grace, open-core split, LICENSE file | M (2) | — |
| **Updates**: npm is free; a desktop auto-updater with signing and notarization costs more | S npm, M desktop | — |
| **Telemetry**: opt-in, counts only, never content, documented | S | — |
| **VS Code extension**: sidebar search, "hand off to agent" | M (2–3) | Store, handoff, MCP |
| **Desktop app** (Tauri or Electron) | L (3–5) | `public/` UI |
| **Docs, site, onboarding, privacy policy** | M (2) | README, schema |

**Smallest sellable single-user product:** npx package, MCP server, consented discovery, incremental ingestion, FTS search, delete, redaction, LLM graph extraction and licensing. That is about 12–16 engineer-weeks. The team tier is roughly another 10–15.

## 3. Architectural risks

1. **Session identity is `sha256(provider + whole file)`** (`store.mjs` `importTranscript`). Each appended line creates a new session, which rules out live ingestion and leaves near-duplicate copies. Identity should come from the provider's own session UUID, with messages stored per row and keyed by `(session, line)`.
2. **Whole transcripts are stored as one JSON value.** `get` parses the entire transcript. `publishGraph` parses it as well, only to read the line numbers. Combined with `instr` search, memory use and latency grow linearly with library size.
3. **The 8 MiB HTTP import limit, and the browser reading the whole file** (`app.js:131,144`). Real Claude and Codex logs often exceed 8 MiB. Ingestion should read the disk directly in a streaming way rather than pass through the HTTP API.
4. **There is no migration system.** `CREATE TABLE IF NOT EXISTS` together with `CHECK (provider IN ('claude','codex'))` means adding a provider requires rebuilding the table. The first schema change after real users arrive will corrupt or block their data unless versioned migrations exist first.
5. **`node:sqlite` status.** On Node 22 it is still experimental: it prints an ExperimentalWarning, its API may change, and it does not support SQLCipher or loadable extensions. The options are to pin and bundle a Node runtime (SEA or desktop shell) or to switch to `better-sqlite3`, which needs native builds for each platform. Decide before packaging.
6. **The server is not embeddable.** `server.mjs` opens the store and starts listening at import time and exports nothing. MCP, a VS Code extension and a desktop app all need a `createLedger({ dbPath })` factory first.
7. **The CLI depends on a running server** (`cli.mjs` `main`). Agents launched by MCP should not need a second process listening on a port.
8. **Loopback is trusted with no token.** Any local user process can read every transcript, which is acceptable for a demo but not once the ledger holds months of history.
9. **The parsers depend on undocumented vendor formats.** There is no format-version detection, and the fixtures are synthetic only. Each Claude or Codex release can silently drop or leak turns. This needs a corpus of redacted real-format samples and a contract test for each format version. Unresolved items (`isSidechain`, `isCompactSummary`, Greek sigma) are already noted in `docs/evals.md`.
10. **Graph limits.** A graph covers one session and cannot be edited, and reordering its arrays produces a separate graph (README). Teams will want graphs that span sessions and change over time, so plan a v2 schema with stable node identity and revision history.
11. **Distribution blockers.** There is no LICENSE, and the package is `private`. The design is publicly modelled on Nessie: keep interfaces original and get a quick legal review before selling.

**First step:** extract `createLedger` and a migrations table, and move session identity to the provider's session UUID with per-message rows. Do this before MCP, discovery or packaging, because all three depend on it.
