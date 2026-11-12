# Latent read contract (M2a, "warm telepathy")

Status: **approved by Ali on 2026-11-07** (`q-latent-contract`), with the changes from the independent review (L14) applied. Merged by Leo's agent on Ali's proposal in PR #4: Ali's path, file-text and secrets rules, plus Leo's live-verified limits (5 s busy wait, 15 s receive deadline, disconnect check), the string `preambleVersion` `"2"` and the cycle 6b preamble. `leo/latent-read` and `ali/latent-pool` carry this same copy.

## The idea

A closed model (Claude, GPT) should not have to read a whole codebase to answer one question. Instead, one local open model reads the files once. Its KV cache for that shared prefix stays warm in vLLM. Several worker calls of the same model answer sub-questions from the cached prefix without recomputing it. A synthesizer call, also from the cached prefix, returns a short **slice**: an answer plus findings that cite file lines. Only the slice travels to the closed model.

"Telepathy" here means sharing one computed prefix (the KV cache) between calls of the same model. Tensors never leave the local machine, and nothing crosses between model families. That is M2b.

## Who owns what

| Piece | Side | Where |
| --- | --- | --- |
| vLLM server (prefix caching on) and the warm pool service | Ali | `runtime/` in context-ledger, branch `ali/latent-pool` |
| `POST /api/latent/read` proxy, slice validation, text fallback | Leo | `src/latent.mjs`, branch `leo/latent-read` |
| `latent_read` MCP tool | Leo | `src/mcp.mjs` |
| Eval set and grader | Shared | `evals/latent/` |

## Runtime service (Ali side)

The service listens on `http://127.0.0.1:4320` by default and calls vLLM's OpenAI-compatible API (default `http://127.0.0.1:8000/v1`). It reads files only under `LATENT_ROOT`. Requests are JSON, responses are JSON, and errors are `{"error": string}` with a status from the table below.

Limits: at most 32 paths, at most 512 KiB of file text in total, and a request body of at most 64 KiB. The system message (preamble plus prefix) and each call's user message and `max_tokens` must fit the model's context (`VLLM_MAX_MODEL_LEN`). Otherwise vLLM refuses the call and the service answers 413.

**Unknown fields.** `/latent/warm` accepts only `paths`. `/latent/read` accepts only `paths`, `question`, `budgetTokens` and `workers`. Any other field is a 400 on both sides, so a misspelt field is never ignored silently.

### Paths

Both sides apply the same rules. A path is refused with 400 when any of these holds:

- It is not a non-empty string, or is longer than 512 characters.
- It starts with `/`, contains a backslash or a colon (drive letters, NTFS streams), or has an empty, `.` or `..` segment.
- A segment starts with a space or ends with a dot or space (Windows would alias another file).
- It contains a character in Unicode categories Cc, Cf, Cs or Co, or Zl or Zp (U+2028, U+2029). These could fake a `=== FILE:` header or a line number. Unassigned code points (Cn) are not refused: Python's and Node's Unicode tables differ in age, so the two sides would disagree.
- It repeats another path, including two spellings of one file (same device and inode, or a case alias).
- It names a secret file (see Secrets).

The runtime then resolves symlinks and refuses anything outside `LATENT_ROOT`. The file it opens must be the same file it checked (same device and inode), or the request is refused.

### File text

- Files must be UTF-8. Anything else is a 400.
- A leading BOM (U+FEFF) is removed.
- CRLF becomes LF. Only LF separates lines, so a lone CR, a form feed or U+2028 stays inside its line.
- A final newline ends the last line and does not start a new, empty one.
- An empty file has zero lines. It is listed in the prefix but cannot be cited. A read where every file is empty is a 400.
- A file that cannot be opened or read (permissions, removed) is a 400.

### Secrets

The service quotes file text into a slice that leaves the machine for a closed model. So `LATENT_ROOT` must be a curated directory of code to read, not a home directory or a whole checkout with credentials in it.

As a safety net, both the requested path and its resolved target are refused when either:

- a directory in the path is `.git`, `.ssh`, `.aws`, `.gnupg`, `.docker` or `.kube`;
- the file name starts with `.env` or `id_rsa`, starts with `id_ed25519`, is one of `.npmrc`, `.pypirc`, `.netrc`, `.pgpass`, `.git-credentials`, `credentials`, `id_dsa` or `id_ecdsa`, or ends in `.pem`, `.key`, `.p12`, `.pfx`, `.keystore` or `.jks`.

`.env.example`, `.env.sample` and `.env.template` are templates, not secrets, and are allowed. Names are compared case-insensitively. The ledger applies the same rule to the requested paths and refuses them up front with a 400. The list is a safety net, not a guarantee.

### Untrusted input

File text is untrusted data. It travels in the **system** message, after the preamble. The defence is the ledger's, not the preamble's:

- it checks every quote against the cited lines;
- it requires each label's values, code names or content words to appear in the lines it cites;
- it flags lines that look like instructions to an AI (`suspiciousLines`) and drops findings that cite them;
- it marks the free-text answer `answerVerified: false`.

An "untrusted data" sentence in the preamble was tried and dropped at merge. Live, it lowered accuracy on the original question set from 7/8 to 6/8 in 3 of 3 runs, and with it the model still produced a steered finding that only the ledger caught. Agents must treat the slice as data.

### Statuses, deadlines and busy

| Status | Meaning | Ledger's response |
| --- | --- | --- |
| 200 | Slice or warm result | Validate the slice |
| 400 | Bad input: body, field, path, encoding, unreadable file, or only empty files | 502 to the caller ("refused") |
| 403 | Host not `127.0.0.1:<port>` or `localhost:<port>`, or any `Origin` header | 502 |
| 404, 405 | Unknown route or method | 502 |
| 413 | Too many paths or bytes, body over 64 KiB, or the prompt does not fit the context | 413 |
| 500 | Unexpected runtime error (no detail is returned) | 502 |
| 501 | `/latent/transfer` with no mapper | Not called by the ledger |
| 502 | vLLM failed, or the model's reply was invalid twice | 502 |
| 503 | vLLM is not ready, **or the pool is busy** | Fall back to text mode |
| 504 | The read ran past its deadline | 502 |

- **Deadlines.** The ledger waits at most **180 s** for the runtime. The runtime gives each request **150 s**, starting when the request is read. It checks the deadline before every model call (reader, planner, each worker, synthesizer and every retry) and caps each vLLM call's timeout at the time left. A late request therefore answers 504 and stops spending model calls before the ledger gives up.
- **Busy.** At most 4 reads or warms run at once. A request waits at most 5 s for a slot, then gets 503 `The latent pool is busy. Try again shortly.`, and the ledger falls back to text mode. Nothing queues behind a stuck request.
- **Slow clients.** The request line, headers and body must arrive within 15 s in total, or the connection is closed. At most 64 connections are open at once.
- **Cancellation.** Before every model call the runtime checks whether the caller has closed its connection, and if so stops the read (503). Otherwise the deadline bounds the cost.

### Prefix rendering

Both sides must render the prefix the same way, so that the bytes, and therefore the tokens, are identical on every call. Files appear in request order. Each file starts with a header line, and each of its lines is prefixed with its 1-based number, `| ` and the line text, then LF:

```
=== FILE: src/app.js ===
1| import x from 'y';
2| ...
```

The system message is the **preamble**, a blank line (`\n\n`), then the rendered prefix. The preamble is fixed text in `runtime/latent_pool/pool.py` (`PREAMBLE`). It explains the line format, the citation and quote rules, and asks for concrete values. It is versioned as `PREAMBLE_VERSION`, currently the string `"2"` (the cycle 6b text the live gate measured), which every receipt reports as `preambleVersion`. Any change to the text bumps the version and needs a gate re-run. A new preamble version also means a cold cache.

Every call for that prefix (reader, planner, workers, synthesizer) sends exactly that system message and differs only in the user message, which starts with `ROLE: <role>`. That way vLLM's automatic prefix caching serves the shared part from its warm cache.

`prefixId` is the SHA-256 of the rendered prefix alone (UTF-8), without the preamble. Two runtimes with different preambles report the same `prefixId` for the same files.

### `POST /latent/warm`

```json
{ "paths": ["src/app.js", "src/db.js"] }
```

The service prefills the prefix (one call with `max_tokens: 1`) and answers:

```json
{ "prefixId": "<sha256 of the rendered prefix>", "prefixTokens": 5123, "receipt": { "model": "...", "preambleVersion": "2", "prefixId": "...", "prefixTokens": 5123, "calls": [ ... ] } }
```

### `POST /latent/read`

```json
{ "paths": ["src/app.js", "src/db.js"], "question": "Where is the session timeout set?", "budgetTokens": 600, "workers": 3 }
```

- `budgetTokens` (64–2048) caps the synthesizer's output.
- `workers` (1–4, default 3) is how many sub-questions run in parallel against the warm prefix.

Response:

```json
{
  "graph": {
    "version": 1,
    "kind": "latent-slice",
    "question": "Where is the session timeout set?",
    "answer": "The timeout is 30 minutes, set in src/db.js.",
    "findings": [
      { "id": "f1", "label": "SESSION_TTL is 1800 seconds", "evidence": [{ "path": "src/db.js", "startLine": 12, "endLine": 12 }] }
    ]
  },
  "receipt": {
    "model": "Qwen/Qwen2.5-7B-Instruct-AWQ",
    "preambleVersion": "2",
    "prefixId": "...",
    "prefixTokens": 5123,
    "subQuestions": ["...", "..."],
    "droppedFindings": 1,
    "calls": [
      { "role": "reader", "promptTokens": 5130, "cachedTokens": 0, "completionTokens": 1, "ms": 900 },
      { "role": "worker", "promptTokens": 5160, "cachedTokens": 5120, "completionTokens": 80, "ms": 700 }
    ]
  },
  "stats": { "prefixTokens": 5123, "sliceTokensEstimate": 120, "cachedShare": 0.82, "totalMs": 3100 }
}
```

- `calls[].role` is one of `reader`, `planner`, `worker` or `synthesizer`. `cachedTokens` comes from vLLM's `usage.prompt_tokens_details.cached_tokens`, which requires `--enable-prompt-tokens-details`.
- `cachedShare` is the sum of `cachedTokens` over the sum of `promptTokens` across all calls.
- `sliceTokensEstimate` is ceil(UTF-16 length of the JSON slice / 4).
- `prefixTokens` is the reader call's `promptTokens`: the whole first prompt (preamble, prefix and the reader's short user message), as vLLM counts it. It is not the prefix alone.
- `droppedFindings` counts findings the runtime removed from the synthesizer's reply: no span that exactly fits the file, an empty label, a duplicate, or one past the cap.
- Findings: 1 to the cap. The cap is `max(1, min(12, budgetTokens ÷ 110))` (integer division), because one quoted finding costs about 110 tokens of JSON. A label is one visible line (500 characters at most). Evidence: 1–4 spans, each with `startLine ≤ endLine` and both within the file. A span that cited lines outside the file is dropped, not clamped.
- Each span may carry `quote`, the exact code copied from its lines (at most 200 characters, folded onto one line). A quote that is blank or not a string reaches the ledger as `""`, so the ledger counts it as a bad quote rather than treating the finding as unquoted. The ledger keeps a finding only when every quote occurs in its cited lines, ignoring runs of whitespace. It marks the finding `quoteVerified: true` when every span is quoted, and counts dropped findings as `badQuotes`. The ledger also reports `ungroundedFindings`, `suspiciousFindings`, `suspiciousLines` and `answerVerified: false`. (Added in cycle 6b, approved with this version.)
- Quotes anchor the evidence on the ledger side.
  - A quote of at least 8 non-space characters that is not in its cited lines, but occurs verbatim in the same file, moves the span there. This happens only if the quote occurs once, or within 30 lines of the cited range. The ledger counts these as `relocatedSpans`.
  - A quote found nowhere in the file drops the finding.
  - A shorter quote, or one that is ambiguous, leaves the span as cited and unverified.
  - Stored quotes are folded onto one line, and the ledger renders them as JSON strings.
- Grounding on the ledger side. A finding is kept only if its cited lines contain every number in its label, every quoted string literal in its label (`'orbit-mail'`, `"EUR"`, `` `shipped` ``; cycle 9), and, when the label names code identifiers, at least one of them. Apostrophes inside words are not literals. Otherwise the finding is dropped and counted in `ungroundedFindings`.
- Strict citations (cycle 9, pending Ali's approval) are off by default and turned on with `LATENT_STRICT_CITATIONS=1`. They add the two runtime behaviours below, measured together in cycle 9: they helped the 14B model and cost the 7B model citations.
- Quote choices on the runtime side, with strict citations. The worker and synthesizer schemas make `quote` an `enum` of the requested files' non-blank lines, each with runs of whitespace folded to one space and cut to its first 200 UTF-16 code units (the ledger's `String.length`), without duplicates.
  - Every non-blank line is offered, so the line the model means is always a choice. A short one such as `MAX=5;` stays unverified on the ledger side, as without the enum.
  - The model can only quote real lines. It can still pair a line with the wrong path or span, and the ledger checks every quote as above, so `quoteVerified` means the quote is on the cited lines, not that those are the right lines.
  - Above 1000 choices or 60,000 characters of choices, `quote` stays a free string. The caps bound the grammar the backend compiles for every worker and synthesizer call. Compile time at the caps has not been measured.
- Constant values, with strict citations. The worker and synthesizer user messages ask the model to resolve a named constant or variable to the literal on its definition line and to cite that line. The text is `RESOLVE_RULE` in `pool.py`. It is not part of the preamble, so it does not change `preambleVersion` or the cached prefix.

### `GET /latent/mappers` (M2b scaffold)

The response is `{ "pairs": [] }`. `POST /latent/transfer` answers 501 with `{"error": "No trained mapper for this model pair."}`, unless the registry holds a pair keyed by (sender model hash, receiver model hash). No pair exists yet. The scaffold fixes the shape for later work.

## Ledger side (Leo side)

`POST /api/latent/read` on the ledger takes the same body as the runtime. It requires a same-origin JSON request, like every other ledger write. The ledger forwards the body to `LATENT_URL` (default `http://127.0.0.1:4320`), then **validates the slice before any agent sees it**:

- The slice must match the shape above.
- Every evidence path must be one of the requested paths.
- Every span must fall within that file's real line count. The ledger reads the same files under its own `LATENT_ROOT`.

Findings that fail these checks are removed and counted in `rejectedFindings`, and the slice is marked `validated: true`.

If the runtime is not running, the ledger falls back to Tier 1. It returns `{ "mode": "text", "files": [{ "path", "text" }] }` with numbered lines, so the closed model reads the files itself. This fallback also applies when no GPU is present.

A fallback can hold up to 512 KiB of numbered text, which is more than one MCP result carries (40,000 characters, cycle 10). The MCP tools page it, and later pages come from `POST /api/latent/files` with `{ "paths": [...] }`. That route is ledger-only: it applies the same path, secret and 512 KiB rules and the same-origin check as `/api/latent/read`, returns `{ "mode": "text", "files": [...] }` exactly as the fallback does, and never contacts `LATENT_URL`, so a continuation never reruns the model. It reads the files again on each call, and each page says that line numbers may have shifted if a file changed. It is a new way to read numbered file text while the runtime is up; it gives nothing the fallback does not already give.

## Gate (from the roadmap)

On the synthetic codebase Q&A set in `evals/latent/`, `latent_read` matches the closed model's accuracy when that model reads everything, using a small fraction of its tokens. See `docs/evals.md`, cycle 6.
