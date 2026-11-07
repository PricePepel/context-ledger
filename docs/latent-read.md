# Latent read contract (M2a, "warm telepathy")

Status: proposed 2026-11-07 by Leo's agent. Ali approves or changes it (question `q-latent-contract` in latent-ledger). Both sides build to this document.

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

The service listens on `http://127.0.0.1:4320` by default and calls vLLM's OpenAI-compatible API (default `http://127.0.0.1:8000/v1`). It reads files only under `LATENT_ROOT`. Every `paths` entry is a relative POSIX path under that root, with no `..`, no leading `/`, no drive letter and no backslash. Requests are JSON, responses are JSON, and errors are `{"error": string}` with status 400 (bad input), 413 (too large) or 503 (model not ready).

Limits: at most 32 paths, at most 512 KiB of file text in total, and the rendered prefix must fit within the model's context minus room for answers.

### Prefix rendering

Both sides must render the prefix the same way, so that the bytes, and therefore the tokens, are identical on every call. Files appear in request order. Each line is prefixed with its 1-based number:

```
=== FILE: src/app.js ===
1| import x from 'y';
2| ...
```

The rendered prefix is the system message. Every call for that prefix (reader, planner, workers, synthesizer) starts with exactly that system message and differs only in the user message. That way vLLM's automatic prefix caching serves the shared part from its warm cache.

### `POST /latent/warm`

```json
{ "paths": ["src/app.js", "src/db.js"] }
```

The service prefills the prefix (one call with `max_tokens: 1`) and answers:

```json
{ "prefixId": "<sha256 of the rendered prefix>", "prefixTokens": 5123, "receipt": { "model": "...", "calls": [ ... ] } }
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
    "prefixId": "...",
    "prefixTokens": 5123,
    "subQuestions": ["...", "..."],
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
- Findings: 1–12. A label is one visible line (500 characters at most). Evidence: 1–4 spans, each with `startLine ≤ endLine` and both within the file.
- Added in cycle 6b, proposed for Ali's approval: each span may carry `quote`, the exact code copied from its lines (at most 200 characters). The ledger keeps a finding only when every quote occurs in its cited lines, ignoring runs of whitespace. It marks the finding `quoteVerified: true` when every span is quoted, and counts dropped findings as `badQuotes`. The ledger also reports `ungroundedFindings`, `suspiciousFindings`, `suspiciousLines` and `answerVerified: false`. See the README section on latent reads.

### `GET /latent/mappers` (M2b scaffold)

The response is `{ "pairs": [] }`. `POST /latent/transfer` answers 501 with `{"error": "No trained mapper for this model pair."}`, unless the registry holds a pair keyed by (sender model hash, receiver model hash). No pair exists yet. The scaffold fixes the shape for later work.

## Ledger side (Leo side)

`POST /api/latent/read` on the ledger takes the same body as the runtime. It requires a same-origin JSON request, like every other ledger write. The ledger forwards the body to `LATENT_URL` (default `http://127.0.0.1:4320`), then **validates the slice before any agent sees it**:

- The slice must match the shape above.
- Every evidence path must be one of the requested paths.
- Every span must fall within that file's real line count. The ledger reads the same files under its own `LATENT_ROOT`.

Findings that fail these checks are removed and counted in `rejectedFindings`, and the slice is marked `validated: true`.

If the runtime is not running, the ledger falls back to Tier 1. It returns `{ "mode": "text", "files": [{ "path", "text" }] }` with numbered lines, so the closed model reads the files itself. This fallback also applies when no GPU is present.

## Gate (from the roadmap)

On the synthetic codebase Q&A set in `evals/latent/`, `latent_read` matches the closed model's accuracy when that model reads everything, using a small fraction of its tokens. See `docs/evals.md`, cycle 6.
