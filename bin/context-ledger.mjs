#!/usr/bin/env node
// Card P5c: the one command a package install gives, for `npx` or a global install.
//   context-ledger start          the loopback server (as `npm start`)
//   context-ledger mcp            the stdio MCP adapter (as `node src/mcp.mjs`)
//   context-ledger <anything>     the ledger CLI (as `npm run ledger -- <anything>`)
// Under this command an unset CONTEXT_LEDGER_DB is the per-user database in the home
// folder, so the server, the CLI and the MCP adapter find one database and one token
// file whatever folder each starts in (a package folder under npx is a throwaway cache).
// A checkout's `npm start` and `npm run ledger` keep their own defaults.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homeOf } from '../src/install.mjs';

if (!process.env.CONTEXT_LEDGER_DB) process.env.CONTEXT_LEDGER_DB = join(homeOf(), '.context-ledger', 'ledger.sqlite');

// Card U9: Node prints "ExperimentalWarning: SQLite is an experimental feature" above every
// command. Under the installed command that one warning is not shown (the ledger chose
// node:sqlite on purpose); every other warning still is, and NODE_OPTIONS still applies.
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type;
  if (type === 'ExperimentalWarning' && /SQLite/u.test(String(warning))) return undefined;
  return emitWarning.call(this, warning, ...rest);
};

const [command, ...rest] = process.argv.slice(2);
if (command === 'start' && rest.length === 0) {
  await import('../src/server.mjs');
} else if (command === 'mcp' && rest.length === 0) {
  await import('../src/mcp.mjs');
} else {
  // The CLI reads its arguments from process.argv, after the script path.
  process.argv = [process.argv[0], fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), ...process.argv.slice(2)];
  await import('../src/cli.mjs');
}
