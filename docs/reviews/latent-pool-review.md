# Review: `ali/latent-pool` runtime and the latent read contract (L14)

*Independent review for Ali, the owner of the runtime side, on 2026-11-07, of `origin/ali/latent-pool` at 73609b9. Read-only: the reviewer did not write this code. Every code finding was confirmed with a probe against a stub vLLM (there was no GPU here), except where marked unconfirmed. Ali's agent re-checked findings 1 and 2 in the source.*

**Verdict: approve with changes.** There are no high-severity findings. The core checks hold:
- path confinement: `..`, absolute paths, symlinks leaving the root, aliases, and the 32-path and 512 KiB limits;
- request validation and the error statuses;
- mapping of vLLM failures;
- byte-identical prefixes across calls, which caching depends on.

Unit tests: `python3 -m unittest discover -s tests -t .` from `runtime/` passes 54 tests.

## Code findings

| # | Severity | Where | Finding | Suggested fix |
| --- | --- | --- | --- | --- |
| 1 | Medium | `pool.py:351`, `server.py:30` | An abandoned request is never cancelled. The ledger gives up at 180 s, but one read can make 7 sequential vLLM calls of up to 300 s each, and keeps 1 of only 4 slots. Later requests wait on a semaphore with no timeout. In the probe, 4 abandoned clients still cost 28 model calls, and a 5th request waited 6.8 s. | A per-request deadline below the ledger's 180 s; check between stages that the client is still connected; return 503 "busy" when no slot is free. |
| 2 | Medium (needs a local attacker) | `server.py:69`, `191–218` | 64 slow clients, each sending 1 byte every 6 s, lock every request out: there is only a 10 s per-receive timeout and no overall deadline. The ledger then silently falls back to text mode. | An overall deadline for headers and body. |
| 3 | Low–medium | `prefix.py:268` | A file name containing U+2028, U+0085 or U+202E can fake a `=== FILE:` header and line numbers in the prefix. The ledger's `\p{C}` check also lets U+2028 through. Needs write access under the root, the same threat model as planted instructions. | Reject `\p{C}`, `\p{Zl}` and `\p{Zp}` in paths on both sides. |
| 4 | Low | `prefix.py:302–343` | `.env` and `.git/config` under the root are readable, so they can be quoted into a slice sent to a closed model. | A denylist (`.env*`, `.git/`, key files) or a rule that the root must be curated (see contract gap 6). |
| 5 | Low | `pool.py:202–205` | A non-string `quote` is dropped silently, so the ledger treats the finding as unquoted instead of counting a bad quote. | Pass it through, as the 6b blank-quote fix does. |
| 6 | Low | `prefix.py:371` | An unreadable file (`PermissionError`) returns 500. | Return 400. |
| 7 | Low | Both sides | A BOM is kept by Python but stripped by the ledger's `TextDecoder`, so line 1 differs. Line counts still match. | Strip the BOM in the runtime, and say so in the contract. |
| 8 | Low | `server.py` | Unknown request fields are accepted, while the ledger rejects them. `prefixTokens` counts the whole prompt, not just the prefix. | Align both sides and define it in the contract. |
| 9 | Unconfirmed | `prefix.py:323` vs `371` | A check-then-open race could in theory escape the root through a swapped symlink. Not exploited. | Open with `O_NOFOLLOW` on each component, or re-check after opening. |
| 10 | Design note | `pool.py:18–28` | File text goes into the system message, and the preamble never says the files are data, not instructions. Injection defence rests on the ledger's grounding and tripwire checks, and the free-text answer (up to 4,000 characters) can still be steered. | Say in the preamble that the files are untrusted data. Keep the ledger's `answerVerified` warning prominent. |

## Contract gaps (`docs/latent-read.md`)

1. Leo's and Ali's copies differ. Ali's lacks the cycle 6b `quote` paragraph that the runtime already implements, and neither copy mentions `receipt.droppedFindings`.
2. "The rendered prefix is the system message" isn't what the code does: a fixed preamble comes first. Version the preamble, and state that `prefixId` hashes only the prefix.
3. Missing text rules: UTF-8 is required, BOM handling, CRLF becomes LF, a final newline starts no extra line, lone CR, empty files.
4. Missing path rules: colons, control and format characters, trailing dots or spaces, duplicates, aliases, resolving symlinks before confining. The two sides also use different length limits (runtime 1024, ledger 512).
5. Missing statuses: 403, 404, 405, 500, 502, 501. There's no busy status, no deadline or cancellation, and no agreed timeout between the sides (180 s vs up to 7 × 300 s).
6. No rule on secrets under `LATENT_ROOT`.
7. Doesn't say that file text is untrusted, or which message role carries it.
8. Undefined terms: "room for answers", `prefixTokens`, and the findings cap of budget ÷ 110.
9. Doesn't say whether unknown request fields are rejected or ignored.

## Recommendation to Ali

Approve the contract **once gaps 1, 2 and 5 are fixed**: copies reconciled, the preamble defined, a busy status and an agreed deadline. Merge the runtime once **findings 1 and 2** (resource exhaustion) are fixed. The low items can follow as issues. None of this blocks the demo: the runtime only runs locally on Ruslan's laptop.
