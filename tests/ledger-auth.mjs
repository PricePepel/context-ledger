// P1e: tests that start the real server read its access token from the file next to
// its temporary database, the way the CLI and the MCP adapter do. The file is per port.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { privateToOwner, readTokenFile, tokenFileFor } from '../src/token.mjs';

const system32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');

// P5a: icacls /inheritance:r keeps explicit entries, and a file an elevated administrator
// creates where nothing is inherited gets explicit ones from the token's default DACL
// (SYSTEM, Administrators) and the Administrators group as owner, as on GitHub's Windows
// runners. So the helper writes one whole descriptor: this user as owner and as the only
// entry, protected from inheritance. It then prints the SID, how SDDL spells it and the
// file's SDDL, so the helper can check its own work.
const restrictScript = [
  "$ErrorActionPreference = 'Stop'",
  '$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User',
  '$acl = New-Object System.Security.AccessControl.FileSecurity',
  '$acl.SetOwner($sid)',
  '$acl.SetAccessRuleProtection($true, $false)',
  "$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule $sid, 'FullControl', 'Allow'))",
  // Not Set-Acl, which also writes the SACL and so needs SeSecurityPrivilege.
  '[System.IO.File]::SetAccessControl($env:TEST_FILE, $acl)',
  '$sid.Value',
  "(New-Object System.Security.AccessControl.RawSecurityDescriptor ('O:' + $sid.Value)).GetSddlForm('Owner').Substring(2)",
  '(Get-Acl -LiteralPath $env:TEST_FILE).Sddl',
].join('; ');

/**
 * For token files a test writes by hand: on Windows, gives the file a descriptor with the
 * current user as owner and only entry, as clients require, and throws with the file's
 * SDDL if that did not take; elsewhere the test's mode 0600 is enough.
 */
export function restrictToOwner(path) {
  if (process.platform !== 'win32') return;
  const output = execFileSync(join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(restrictScript, 'utf16le').toString('base64')],
    { env: { ...process.env, TEST_FILE: path }, encoding: 'utf8', windowsHide: true });
  const [sid, alias, sddl] = output.trim().split(/\r?\n/u);
  if (!privateToOwner(sddl, sid, alias)) throw new Error(`restrictToOwner left ${sddl} for ${sid} (${alias}).`);
}

/** The token of a server started on this database and port. */
export async function ledgerToken(database, port) {
  const token = (await readTokenFile(tokenFileFor(database, port)))?.token;
  if (token === undefined) throw new Error('The test server wrote no readable token file.');
  return token;
}

/** The Authorization header for a token. */
export const bearer = token => ({ Authorization: `Bearer ${token}` });
