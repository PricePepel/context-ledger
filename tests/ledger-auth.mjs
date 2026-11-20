// P1e: tests that start the real server read its access token from the file next to
// its temporary database, the way the CLI and the MCP adapter do. The file is per port.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { readTokenFile, tokenFileFor } from '../src/token.mjs';

const system32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');

/**
 * For token files a test writes by hand: on Windows, replaces the file's ACL with one
 * entry for the current user (the owner, since the test created it), as clients
 * require; elsewhere the test's mode 0600 is enough.
 */
export function restrictToOwner(path) {
  if (process.platform !== 'win32') return;
  const user = execFileSync(join(system32, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' });
  const sid = /"(S-1-[0-9-]+)"\s*$/u.exec(user)[1];
  execFileSync(join(system32, 'icacls.exe'), [path, '/inheritance:r', '/grant:r', `*${sid}:F`], { stdio: 'ignore' });
}

/** The token of a server started on this database and port. */
export async function ledgerToken(database, port) {
  const token = (await readTokenFile(tokenFileFor(database, port)))?.token;
  if (token === undefined) throw new Error('The test server wrote no readable token file.');
  return token;
}

/** The Authorization header for a token. */
export const bearer = token => ({ Authorization: `Bearer ${token}` });
