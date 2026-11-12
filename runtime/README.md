# Warm latent pool runtime (M2a, Ali side)

This service implements the runtime half of [the latent read contract](../docs/latent-read.md). One local open model reads a set of files once. vLLM keeps the KV cache for that prefix warm. A planner, parallel workers and a synthesizer then answer from the cached prefix, and the service returns a short slice of cited findings.

It uses only the Python standard library. It runs on Python 3.12 (WSL venv `~/venvs/latent`) and 3.13 (Windows, for tests).

## Start it (WSL Ubuntu)

Terminal 1 starts vLLM. The first run downloads the model.

```bash
cd /mnt/c/Users/Asus/Desktop/context-ledger-ali
bash runtime/serve-vllm.sh
```

Terminal 2 starts the pool once vLLM logs that it is serving on port 8000:

```bash
cd /mnt/c/Users/Asus/Desktop/context-ledger-ali/runtime
LATENT_ROOT=/mnt/c/Users/Asus/Desktop/context-ledger-ali/evals/latent/fixture \
  ~/venvs/latent/bin/python -m latent_pool.server
```

Smoke test:

```bash
curl -s http://127.0.0.1:4320/latent/read -H 'Content-Type: application/json' \
  -d '{"paths":["src/config.js","src/session.js"],"question":"How long does a session last?","budgetTokens":600,"workers":3}'
```

WSL2 forwards localhost by default, so a ledger running on Windows reaches the pool at `http://127.0.0.1:4320`.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `LATENT_ROOT` | required | The only directory the service reads. |
| `VLLM_URL` | `http://127.0.0.1:8000/v1` | vLLM's OpenAI-compatible base URL. |
| `LATENT_MODEL` | `Qwen/Qwen2.5-7B-Instruct-AWQ` | Model id sent to vLLM and reported in receipts. |
| `LATENT_PORT` | `4320` | Port, bound on 127.0.0.1 only. |
| `LATENT_STRICT_CITATIONS` | `0` | `1` limits quotes to real file lines and asks for constants' literal values (cycle 9). Measured best with `LATENT_MODEL=Qwen/Qwen2.5-14B-Instruct-AWQ` and `VLLM_MAX_MODEL_LEN=8192`, at about 2.8× the 7B model's time per question. |

`serve-vllm.sh` also reads `VLLM_VENV`, `VLLM_PORT`, `VLLM_MAX_MODEL_LEN` and `VLLM_GPU_UTIL`. Extra arguments are passed to `vllm serve`.

## Endpoints

| Route | Body | Result |
| --- | --- | --- |
| `POST /latent/warm` | `{paths}` | `{prefixId, prefixTokens, receipt}` after one `max_tokens: 1` reader call. |
| `POST /latent/read` | `{paths, question, budgetTokens?, workers?}` | `{graph, receipt, stats}`, as in the contract. `budgetTokens` is 64–2048 (default 600) and `workers` is 1–4 (default 3). |
| `GET /latent/mappers` | none | `{pairs: []}`. This is the M2b registry, keyed by sha256 of the sender and receiver model ids. |
| `POST /latent/transfer` | `{sender, receiver, ...}` | 501 `{"error": "No trained mapper for this model pair."}` unless a pair is registered. None is. |

Errors are `{"error": string}`:

- 400: bad input or an unsafe path.
- 403: wrong Host, or an Origin header is present.
- 413: more than 32 paths, more than 512 KiB of files, a request body over 64 KiB, or a prefix too long for the model's context.
- 501: no mapper for the pair.
- 502: the model's reply was invalid twice, or vLLM failed.
- 503: `Model server is not ready.`, or `The latent pool is busy. Try again shortly.` when all 4 pipeline slots stay taken for 2 s.
- 504: `The latent read ran out of time.` Each request has 150 s, under the ledger's 180 s. The deadline is checked before every model call and caps each vLLM call's timeout.

The request line, headers and body must arrive within 10 s in total. Paths naming secret files (`.env*`, `.git/`, keys) are refused, but keep `LATENT_ROOT` to a curated code directory anyway. The full rules are in the contract.

## How a read runs

1. Paths are checked before any file is opened. Each path must be a relative POSIX path with no `..`, `.` or empty segment. It must not contain a backslash, drive letter, colon or control character, and no segment may start with a space or end with a dot or space. Its realpath, after symlinks are resolved, must lie inside `realpath(LATENT_ROOT)`, and two names for one file count as a duplicate. Files must be UTF-8.
2. The prefix is rendered exactly as the contract shows: files in request order, `=== FILE: <path> ===`, then `N| line` for each line. CRLF becomes LF, and only `\n` splits lines. `prefixId` is the sha256 of the rendered prefix.
3. The system message is a fixed preamble, a blank line, then the prefix. It is byte-identical for the reader, planner, workers and synthesizer. Only the user message differs, and it starts with `ROLE: <role>`.
4. The calls run in this order: the reader (`max_tokens: 1`), then the planner (exactly `workers` sub-questions), then the workers in parallel, then the synthesizer (`max_tokens = budgetTokens`). Every call uses temperature 0. The planner, workers and synthesizer use vLLM structured output (`response_format: json_schema`), and the evidence `path` is an enum of the requested non-empty files.
5. Model JSON is parsed strictly. A reply with the wrong shape is retried once, then the read fails with 502. Evidence spans are clamped to the file's real line count. A span with an unknown path or no overlap with the file is dropped, and a finding left with no span is dropped and counted in `receipt.droppedFindings`. A slice with no valid finding counts as invalid.
6. `prefixTokens` is the reader call's `prompt_tokens`, which also covers the preamble, the chat template and the short reader message. `cachedShare` is the sum of cached tokens over the sum of prompt tokens across all calls, retries included. `sliceTokensEstimate` is ceil(UTF-16 length of the compact graph JSON / 4).

## Local-only guard

The service binds 127.0.0.1. It accepts a request only when `Host` is `127.0.0.1:<port>` or `localhost:<port>`, which blocks DNS rebinding. It refuses any request that carries an `Origin` header. Browsers send Origin on every cross-origin request and every POST, and the ledger calls this service server to server without one, so no web page can drive the pool. POST bodies must be `Content-Type: application/json` with a `Content-Length` of at most 64 KiB.

## Tests

From the repository root:

```bash
python -m unittest discover -s runtime/tests -t runtime
```

The tests run against a fake vLLM (`tests/helpers.py`) that answers per role, records requests and reports `cached_tokens`. `test_fixture_e2e.py` runs the eight eval questions on `evals/latent/fixture` through the whole service and grades the canned slices with a Python port of `evals/latent/grade.mjs`. On Windows, the symlink tests are skipped unless the user may create symlinks. They run under WSL.

## Not verified yet

- These checks need the live model (`docs/evals.md`, cycle 5): warm-cache numbers against real vLLM (`cachedTokens` of at least 90% of the prefix after the reader), answer quality, and whether a 64-token budget is enough for a structured slice. A small budget can cut the synthesizer off, which returns 502.
- The guard against a symlink swapped in between the check and the read assumes a single local user.
