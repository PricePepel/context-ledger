# Importing T3 Code threads

*Card D3. Written 2026-11-17 from T3 Code's public source at one pinned release. We have not run T3 Code ourselves; see "Not checked yet".*

The ledger can import threads from a **copy** of T3 Code's database. You make the copy and name it on the command line. The importer never looks for T3's files and opens the copy read-only.

## Steps

1. **Quit T3 Code**, so everything it has written is in the database file and not in its `-wal` file.
2. **Copy the database** to a folder of your own. It is `statev2.sqlite` in `~/.t3/userdata`, or in `<path>/userdata` for a server started with `--base-dir <path>` ([`apps/server/src/config.ts`](https://github.com/pingdotgg/t3code/blob/7d32075e3757ded707914e2450c3e392a9665765/apps/server/src/config.ts)). Copy only that file, after quitting T3: a copy with a non-empty `statev2.sqlite-wal` beside it is refused. The importer also refuses a file named `statev2.sqlite` inside a folder named `userdata`, so that it is not run on T3's own copy by mistake. That is a name check only.
3. **See what it holds**, without importing anything and without the ledger running:

   ```sh
   npm run --silent ledger -- import-t3 /path/to/copy/statev2.sqlite --list
   ```

   Each thread shows its ID, its agent (`claude` or `codex`), the models its runs used, how many messages would be imported and its title, or why it would be refused.
4. **Import** with the ledger running (`npm start`), either every thread or one:

   ```sh
   npm run --silent ledger -- import-t3 /path/to/copy/statev2.sqlite
   npm run --silent ledger -- import-t3 /path/to/copy/statev2.sqlite --thread THREAD_ID
   ```

   Each imported thread becomes a session with source `t3-THREAD_ID.jsonl`. Search, handoffs and graphs work on it as on any other session. The command exits with code 1 when any thread was refused. If the ledger stops answering part way, the threads already imported are listed and the others are marked unknown; run the same command again, since a thread that was already imported is not imported twice.

You can delete the copy afterwards. Opening it read-only can leave empty `-shm` and `-wal` files beside it; the copy itself is not changed.

## Which T3 release

The importer reads databases of **T3 Code v0.1.10** only: commit [`7d32075`](https://github.com/pingdotgg/t3code/tree/7d32075e3757ded707914e2450c3e392a9665765), schema head 96. T3 records its schema in the table `effect_sql_migrations`. A copy whose recorded migrations differ in any way from that release's 96, or whose tables differ in kind, column type or key, is refused, because a table it reads may have changed. Supporting a newer release means reading its migrations, adding its head and a test database for it.

## What it reads

| T3 table | What the importer takes |
| --- | --- |
| `orchestration_v2_projection_threads` | The thread ID and title; deleted threads are skipped |
| `orchestration_v2_projection_runs`, `…_run_attempts` | The provider thread each run used, and the model it ran |
| `orchestration_v2_projection_provider_threads` | `driver`, the agent: `claudeAgent` is Claude Code, `codex` is Codex |
| `orchestration_v2_projection_messages` | Role, text, author and whether the message is finished |

- **The agent.** A thread is imported when all its runs, and every attempt of each run, used one agent, Claude Code or Codex. A thread run by another agent (Cursor, OpenCode, Grok Build and the rest), by more than one agent, with an answer whose agent is not recorded, or with no recorded run, is refused. A subagent's thread is refused too; import the thread that started it. A fork brings only its own messages. Threads that T3 copied from its V1 database have no run records, so they are refused too. The T3 *instance* name is not used: it is a name you choose.
- **The messages.** Messages are taken in T3's order. The *n*th message of the thread is line *n* in the ledger, so a graph cites the same message every time. System messages, notices T3 or the agent wrote in the user's place, unfinished and empty messages are counted but not imported. Tool calls and attachments are not imported. A thread over the 8 MiB import limit is refused. Lines belong to one copy: a newer copy of a thread that has grown is a new session.

## Not checked yet

- We built the test database from T3's table definitions at the pinned commit, not by running T3. Someone with T3 Code v0.1.10 should make a few synthetic threads with Claude Code and Codex, quit T3, copy the database and run `--list` and an import on it.
- T3's own MCP endpoint can also read threads ([Outside agents](https://github.com/pingdotgg/t3code/blob/main/docs/user/outside-agents.md)). It is not used here.
