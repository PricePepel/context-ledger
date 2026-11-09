// Start the ledger on demand, so an agent client (the MCP adapter) works without a
// separate `npm start`. The ledger runs detached and outlives the client that started it.
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverPath = fileURLToPath(new URL('./server.mjs', import.meta.url));
const appRoot = fileURLToPath(new URL('..', import.meta.url));

/** A started ledger keeps its data here, not in whatever folder the client runs from. */
export const defaultDatabase = () => join(homedir(), '.context-ledger', 'ledger.sqlite');

export const autostartEnabled = (env = process.env) => env.CONTEXT_LEDGER_AUTOSTART !== '0';

/** 'ledger' when Context Ledger answers on the port, 'none' when nothing listens, 'other' otherwise. */
export async function probeLedger(port, timeoutMs = 1000) {
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/api/health`, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    return error?.cause?.code === 'ECONNREFUSED' ? 'none' : 'other';
  }
  const body = await response.json().catch(() => null);
  return response.ok && body?.name === 'context-ledger' ? 'ledger' : 'other';
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Make sure a ledger answers on `port`, starting one if nothing listens there.
 * Resolves { started: false } when one was already running, or { started: true, database, log }.
 */
export async function ensureLedger({ port, database, env = process.env, startTimeoutMs = 10_000 } = {}) {
  const state = await probeLedger(port);
  if (state === 'ledger') return { started: false };
  if (state === 'other') {
    throw new Error(`Port ${port} is used by another service, not Context Ledger. Set PORT to a free port.`);
  }

  const db = database ?? env.CONTEXT_LEDGER_DB ?? defaultDatabase();
  const dataDir = dirname(db);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const log = join(dataDir, 'ledger.log');
  const logFd = openSync(log, 'a', 0o600);
  let exited = false;
  try {
    const child = spawn(process.execPath, [serverPath], {
      cwd: appRoot,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...env, PORT: String(port), CONTEXT_LEDGER_DB: db, CONTEXT_LEDGER_PID_FILE: join(dataDir, 'ledger.pid') },
    });
    child.on('exit', () => { exited = true; });
    child.on('error', () => { exited = true; });
    child.unref();
  } finally {
    closeSync(logFd);
  }

  // Another client may start a ledger at the same moment. The loser exits on EADDRINUSE,
  // and both callers then find the winner on the port.
  const deadline = Date.now() + startTimeoutMs;
  while (Date.now() < deadline) {
    await pause(100);
    const now = await probeLedger(port);
    if (now === 'ledger') return { started: true, database: db, log };
    if (now === 'other') throw new Error(`Port ${port} is used by another service, not Context Ledger. Set PORT to a free port.`);
    if (exited) break;
  }
  throw new Error(`Context Ledger did not start on port ${port}. See ${log}.`);
}
