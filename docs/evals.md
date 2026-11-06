# Evaluation log

## Cycle 1 — Transcript import and retrieval

Define the expected results before implementation. Run `npm test` against a fresh local SQLite file using synthetic transcripts only.

| Eval | Expected |
| --- | --- |
| Claude Code import | The browser displays user and assistant text with the original filename and JSONL line numbers. Tool output stays out of the imported conversation. |
| Codex import | A matching result is discoverable across providers. The provider filter narrows it and search matches case-insensitively. |
| Repeat and rejected imports | Importing the same data twice returns the same ID. Malformed JSONL and foreign origins add zero sessions. |
| Browser rendering | Imported text containing HTML is displayed literally. An unmatched query explains that there are no results. |

## Cycle 2 — Portable handoff

| Eval | Expected |
| --- | --- |
| CLI search | The same provider and query yield the same IDs in the CLI and browser. |
| CLI handoff | An exported Markdown packet includes provider, source, role and line for each turn. Retrieval of a missing session exits nonzero. |
| Regression | Cycle 1 passes against a fresh database. |

## Results — 2026-11-06

- Cycle 1 passed the browser import/search journey and the API integrity eval. Backend smoke checks also verified persistence after restart, Host rejection, and the streamed request limit. Review found that Codex synthetic user-role context could leak into the library. The parser now filters known context blocks while preserving neighboring user text. The browser also checks file size before reading and renders rows without a variadic call.
- Cycle 2 passed browser-to-CLI retrieval and handoff export, including missing IDs and literal rendering of transcript Markdown and terminal controls. Claude reviewed the CLI independently. The follow-up review verified the fixes in the backend, browser, and CLI.
- Final Windows Playwright run passed 3 of 3 tests. GitHub Actions runs the same suite on Linux.
- Live handoff smoke passed with Claude Haiku using a synthetic packet. Claude recovered the expected action, source filename, and original line 2 from the CLI output.
