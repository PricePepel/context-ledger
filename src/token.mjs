// The loopback API token (ADR-10). The server writes a fresh random token next to its
// database at each start, together with the port it listens on; the CLI and the MCP
// adapter read it and send it as a bearer token, but only to that port; the browser
// signs in with a one-time code and then holds a session cookie. The server keeps
// only SHA-256 digests; the bearer check compares digests in constant time, and codes
// and sessions are looked up by their digests. Each port has its own file, so servers
// on different ports and one database do not replace each other's token.
import { execFile, execFileSync } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, fstatSync, ftruncateSync, mkdirSync, openSync, readSync, rmSync, writeSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const secretBytes = 32;
const secretPattern = /^[A-Za-z0-9_-]{43}$/u;
export const codeLifetimeMs = 60 * 1000;
export const sessionLifetimeMs = 12 * 60 * 60 * 1000;
const maxCodes = 32;
const maxSessions = 64;
const maxTokenFileBytes = 256;

const defaultDatabase = fileURLToPath(new URL('../.context-ledger/ledger.sqlite', import.meta.url));

const validPort = port => Number.isInteger(port) && port >= 1 && port <= 65535;

/** The token file of the ledger on this port: the database path with `.<port>.token` added. */
export function tokenFileFor(database, port) {
  if (!validPort(port)) throw new Error('Invalid port.');
  return `${resolve(database)}.${port}.token`;
}

/** Where a client looks: CONTEXT_LEDGER_DB as given, else the repository's default database. */
export function clientTokenFile(port, env = process.env) {
  return tokenFileFor(env.CONTEXT_LEDGER_DB ?? defaultDatabase, port);
}

const newSecret = () => randomBytes(secretBytes).toString('base64url');
const digest = text => createHash('sha256').update(text, 'utf8').digest();
const digestKey = text => digest(text).toString('hex');

/** A fresh random token of 32 bytes, base64url. */
export const newToken = newSecret;

// Windows ignores file modes: a file created the usual way takes its folder's inherited
// ACL, which outside the user profile often lets other users read it, and an account
// with WRITE_DAC on it could keep that right through a handle opened before any later
// change. So on Windows the token file is written and read by Windows PowerShell, each
// time through one handle that is both checked and used:
// - the writer creates the file (CreateNew, share mode None) with a protected security
//   descriptor whose owner and only entry are the current user, checks that descriptor
//   on the new handle, and only then writes the record, which it reads from stdin;
// - a reader opens the file, reads owner and DACL from that handle as SDDL (which does
//   not depend on the display language) and at most 257 bytes from the same handle.
// PowerShell runs from System32 with execFile and no shell, and takes its script as
// -EncodedCommand and the path in an environment variable. The token goes only through
// the private stdin and stdout pipes of that child process, never its arguments or
// environment.
const windows = process.platform === 'win32';
const powershell = () => join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const runTool = promisify(execFile);
const sidPattern = /^S-1-[0-9]+(?:-[0-9]+)+$/u;
const aliasPattern = /^[A-Z]{2}$/u;
const pathVariable = 'CONTEXT_LEDGER_PRIVATE_FILE';
// Exit codes of the write script: the path already names something (nothing was created,
// so nothing is removed), or a later step failed (the new file was emptied through its
// handle, so no token is left in it).
const createCollision = 3;
const writeFailed = 4;
// Exit code of the read script for a handle that is not a small regular file.
const notATokenFile = 5;
// SDDL writes some SIDs as two-letter aliases: the built-in Administrator account (RID
// 500, which GitHub's Windows runners use) is "LA", not its S-1-5-21-... form. So each
// script also prints how SDDL spells the current user, from a descriptor that holds only
// that SID as owner, and the check accepts either spelling (card P5a).
const powershellLines = lines => ["$ErrorActionPreference = 'Stop'", "$ProgressPreference = 'SilentlyContinue'",
  "function ownAlias($value) { (New-Object System.Security.AccessControl.RawSecurityDescriptor ('O:' + $value)).GetSddlForm([System.Security.AccessControl.AccessControlSections]::Owner).Substring(2) }",
  ...lines].join('\n');
const writeScript = powershellLines([
  '$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User',
  '$security = New-Object System.Security.AccessControl.FileSecurity',
  '$security.SetOwner($sid)',
  '$security.SetAccessRuleProtection($true, $false)',
  "$security.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule $sid, 'FullControl', 'Allow'))",
  'try {',
  `  $stream = New-Object System.IO.FileStream $env:${pathVariable}, ([System.IO.FileMode]::CreateNew), ([System.Security.AccessControl.FileSystemRights]::FullControl), ([System.IO.FileShare]::None), 4096, ([System.IO.FileOptions]::None), $security`,
  `} catch { exit ${createCollision} }`,
  'try {',
  '  $found = $stream.GetAccessControl()',
  '  $rules = @($found.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))',
  "  if (-not $found.AreAccessRulesProtected -or $found.GetOwner([System.Security.Principal.SecurityIdentifier]) -ne $sid -or $rules.Count -ne 1 -or $rules[0].IdentityReference -ne $sid -or $rules[0].AccessControlType -ne 'Allow') { throw 'not private' }",
  '  $record = [System.Text.Encoding]::UTF8.GetBytes([Console]::In.ReadLine() + "`n")',
  '  $stream.Write($record, 0, $record.Length)',
  '  $stream.Flush()',
  "  [Console]::Out.Write($sid.Value + \"`n\" + (ownAlias $sid.Value) + \"`n\" + $found.GetSecurityDescriptorSddlForm('Owner, Group, Access') + \"`n\")",
  '} catch {',
  '  $stream.SetLength(0)',
  `  exit ${writeFailed}`,
  '} finally { $stream.Dispose() }',
]);
// The reader shares the file for reading, writing and deletion, so a server that stops
// during a read can still remove it. Type and size are checked on the same handle (.NET
// already refuses handles that are not disk files). CONTEXT_LEDGER_TEST_READ_MARKER is a
// test hook: after the read, with the handle still open, it creates that marker file
// and waits (at most 10 s) until the test removes it.
const readScript = powershellLines([
  '$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
  `$stream = [System.IO.File]::Open($env:${pathVariable}, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, ([System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete))`,
  'try {',
  `  if (-not $stream.CanSeek -or $stream.Length -gt ${maxTokenFileBytes}) { exit ${notATokenFile} }`,
  "  $sddl = $stream.GetAccessControl().GetSecurityDescriptorSddlForm('Owner, Group, Access')",
  `  $buffer = New-Object byte[] ${maxTokenFileBytes + 1}`,
  '  $count = $stream.Read($buffer, 0, $buffer.Length)',
  '  if ($env:CONTEXT_LEDGER_TEST_READ_MARKER) {',
  "    [System.IO.File]::WriteAllText($env:CONTEXT_LEDGER_TEST_READ_MARKER, 'open')",
  '    $deadline = [DateTime]::UtcNow.AddSeconds(10)',
  '    while ((Test-Path -LiteralPath $env:CONTEXT_LEDGER_TEST_READ_MARKER) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 50 }',
  '  }',
  '  [Console]::Out.Write($sid + "`n" + (ownAlias $sid) + "`n" + $sddl + "`n" + [System.Convert]::ToBase64String($buffer, 0, $count) + "`n")',
  '} finally { $stream.Dispose() }',
]);
const powershellArguments = script => ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
const powershellOptions = path => ({ env: { ...process.env, [pathVariable]: path }, windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 });

/**
 * True when an SDDL security descriptor (owner, optional group, DACL) has this SID as
 * owner and a DACL whose every allow entry is for this SID. Deny entries are harmless.
 * Another owner (who may always change the DACL), a NULL DACL (anyone), a conditional
 * or object entry, or text in any other shape is false. `alias` is how SDDL spells this
 * SID (ownAlias above): the SID itself, or a two-letter alias that names the same account.
 */
export function privateToOwner(sddl, sid, alias = sid) {
  if (typeof sddl !== 'string' || typeof sid !== 'string' || !sidPattern.test(sid)) return false;
  if (alias !== sid && !(typeof alias === 'string' && aliasPattern.test(alias))) return false;
  const self = new Set([sid, alias]);
  const parts = /^O:([A-Z]{2}|S-1-[0-9-]+)(?:G:(?:[A-Z]{2}|S-1-[0-9-]+))?D:[A-Z]*((?:\([^()]*\))*)(?:S:.*)?$/u.exec(sddl.trim());
  if (!parts || !self.has(parts[1])) return false;
  const entries = [...parts[2].matchAll(/\(([^()]*)\)/gu)].map(entry => entry[1].split(';'));
  return entries.every(fields => fields[0] === 'D' || (fields[0] === 'A' && fields.length === 6 && self.has(fields[5])));
}

/** The lines the scripts print: { sid, alias, sddl, bytes }, or undefined. */
function described(output) {
  const [sid, alias, sddl, base64] = String(output).split(/\r?\n/u);
  if (!sid || !sddl || !sidPattern.test(sid)) return undefined;
  if (alias !== sid && !aliasPattern.test(alias ?? '')) return undefined;
  return { sid, alias, sddl, bytes: base64 === undefined ? undefined : Buffer.from(base64, 'base64') };
}

/** Windows: creates the token file private from the start and writes the record through the checked handle. */
function writePrivateFileSync(path, line) {
  let output;
  try {
    output = execFileSync(powershell(), powershellArguments(writeScript), { ...powershellOptions(path), input: line + '\n', stdio: ['pipe', 'pipe', 'ignore'] });
  } catch {
    throw new Error('The token file could not be written privately.');
  }
  const found = described(output);
  if (!found || !privateToOwner(found.sddl, found.sid, found.alias)) throw new Error(failedWrite(path, line));
}

// Fixed sentences for a Windows write that failed after the record was written: they
// say whether the record is still in the file, and never name the path.
const notWritten = 'The token file could not be written privately.';
const notWrittenNotEmptied = 'The token file could not be written privately, and it could not be emptied: delete it before the next start.';
const failedWrite = (path, line) => (emptyIfOwnRecord(path, line) === 'failed' ? notWrittenNotEmptied : notWritten);

/**
 * Empties the file at this path through its own descriptor, but only when it holds
 * exactly this record (which only this start knows), so a file that replaced it is left
 * alone. Nothing is removed by path. Returns 'emptied', 'not ours' (missing, not a
 * regular file or other content) or 'failed' (the record may still be there: the file
 * could not be opened for writing, or truncating it failed). Never throws.
 */
export function emptyIfOwnRecord(path, line) {
  let descriptor;
  let result = 'not ours';
  try {
    try {
      descriptor = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
    } catch {
      return 'not ours';
    }
    if (!fstatSync(descriptor).isFile()) return 'not ours';
    const buffer = Buffer.alloc(maxTokenFileBytes + 1);
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
    if (buffer.subarray(0, bytesRead).toString('utf8') !== line + '\n') return 'not ours';
    result = 'failed';
    // Ours: reopen for writing and check the content again on that descriptor.
    const writable = openSync(path, constants.O_RDWR | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
    try {
      const again = Buffer.alloc(maxTokenFileBytes + 1);
      const againRead = readSync(writable, again, 0, again.length, 0);
      if (again.subarray(0, againRead).toString('utf8') !== line + '\n') return (result = 'not ours');
      ftruncateSync(writable, 0);
      result = 'emptied';
    } finally {
      try {
        closeSync(writable);
      } catch {
        // The truncation, if any, is already done.
      }
    }
  } catch {
    // result says what is known.
  } finally {
    try {
      if (descriptor !== undefined) closeSync(descriptor);
    } catch {
      // Cleanup only.
    }
  }
  return result;
}

/** Windows: { sid, alias, sddl, bytes } of a file, all read through one handle. */
async function readPrivateFile(path) {
  const { stdout } = await runTool(powershell(), powershellArguments(readScript), powershellOptions(path));
  const found = described(stdout);
  if (!found?.bytes) throw new Error('The token file could not be read.');
  return found;
}

/**
 * Writes a token file for a server listening on this port. An existing file (or link)
 * at the path is removed first and the new one is created exclusively, so a file or
 * link put there in between makes this fail instead of writing through it (and that
 * file is not removed). Mode 0600 applies on POSIX; on Windows see above. A short write
 * or a failed close removes the file; a failure on Windows leaves no token in it. A
 * link in the folder path is not checked. Returns the file's identity ({ dev, ino } as
 * bigints, from an open descriptor: on Windows only a descriptor's stat names the
 * volume) so readers can refuse the file.
 */
export function writeTokenFile(path, token, port) {
  if (!secretPattern.test(token) || !validPort(port)) throw new Error('Invalid token record.');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  rmSync(path, { force: true });
  const line = JSON.stringify({ port, token });
  if (windows) {
    writePrivateFileSync(path, line);
    // The identity comes from a descriptor whose content is this start's record, which
    // nobody else can know, so it is the file just written. Every failure here is the
    // same fixed sentence, so no file system message (which names the path) escapes.
    let descriptor;
    let identity;
    try {
      descriptor = openSync(path, constants.O_RDONLY);
      const buffer = Buffer.alloc(maxTokenFileBytes + 1);
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
      if (buffer.subarray(0, bytesRead).toString('utf8') === line + '\n') {
        const { dev, ino } = fstatSync(descriptor, { bigint: true });
        identity = { dev, ino };
      }
    } catch {
      // identity stays undefined.
    }
    try {
      if (descriptor !== undefined) closeSync(descriptor);
    } catch {
      identity = undefined;
    }
    // A failed lookup empties the record this start wrote, as for a rejected descriptor.
    if (identity === undefined) throw new Error(failedWrite(path, line));
    return identity;
  }
  const descriptor = openSync(path, 'wx', 0o600);
  const record = Buffer.from(line + '\n', 'utf8');
  let identity;
  try {
    if (writeSync(descriptor, record, 0, record.length, 0) !== record.length) throw new Error('The token file was not written whole.');
    const { dev, ino } = fstatSync(descriptor, { bigint: true });
    identity = { dev, ino };
  } finally {
    let closed = false;
    try {
      closeSync(descriptor);
      closed = true;
    } finally {
      // A file that is not written whole or not closed is not left behind.
      if (identity === undefined || !closed) rmSync(path, { force: true });
    }
  }
  return identity;
}

/**
 * Removes the token file if it still holds this server's token (another start may have
 * replaced it). The read is bounded, non-blocking and refuses links and non-regular
 * files, so a FIFO put there cannot hang the stop. A start that replaces the file
 * between this read and the removal loses its file; run one server per database and port.
 */
export function removeTokenFile(path, isOwnToken) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.size > maxTokenFileBytes) return;
    const buffer = Buffer.alloc(maxTokenFileBytes + 1);
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
    const record = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
    if (typeof record?.token === 'string' && secretPattern.test(record.token) && isOwnToken(record.token)) {
      closeSync(descriptor);
      descriptor = undefined;
      rmSync(path, { force: true });
    }
  } catch {
    // Already gone, replaced or unreadable: nothing to remove.
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/**
 * Reads a token file: { port, token }, or undefined when the file is missing, is not a
 * regular file (a FIFO cannot block the read), is malformed, or on POSIX is a link,
 * belongs to another user or can be read or written by group or others. On Windows the
 * type, size, owner, ACL and content come through one handle (see above): a file that
 * another account owns, or whose ACL allows anyone but the current user, gives
 * { exposed: true } and is not used; a file whose security cannot be read gives undefined.
 */
export async function readTokenFile(path) {
  let file;
  try {
    let bytes;
    if (windows) {
      // One open, in PowerShell: type, size, owner, ACL and content all come from it.
      const found = await readPrivateFile(path);
      if (!privateToOwner(found.sddl, found.sid, found.alias)) return { exposed: true };
      bytes = found.bytes;
    } else {
      file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
      const info = await file.stat();
      if (!info.isFile() || info.size > maxTokenFileBytes) return undefined;
      if (typeof process.getuid === 'function' && (info.uid !== process.getuid() || (info.mode & 0o077) !== 0)) return undefined;
      const buffer = Buffer.alloc(maxTokenFileBytes + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      bytes = buffer.subarray(0, bytesRead);
    }
    if (bytes.length > maxTokenFileBytes) return undefined;
    const record = JSON.parse(bytes.toString('utf8'));
    if (typeof record?.token !== 'string' || !secretPattern.test(record.token) || !validPort(record.port)) return undefined;
    return { port: record.port, token: record.token };
  } catch {
    return undefined;
  } finally {
    await file?.close().catch(() => {});
  }
}

/**
 * What a client sends to the ledger on this port, from that port's token file: { token }
 * when the file names that port, { otherPort } when it names another (a file copied or
 * renamed; the token is then not sent, so it never goes to another listener),
 * { exposed: true } when the file is readable by other users (Windows ACL), or {} when
 * there is no readable file.
 */
export async function clientToken(port, env = process.env) {
  if (!validPort(port)) return {};
  const record = await readTokenFile(clientTokenFile(port, env));
  if (!record) return {};
  if (record.exposed) return { exposed: true };
  return record.port === port ? { token: record.token } : { otherPort: record.port };
}

/**
 * The token for a ledger URL, for scripts that take one (LEDGER): only for plain http
 * to the IPv4 loopback 127.0.0.1 (where the ledger listens; localhost may reach ::1;
 * URL parsing also accepts spellings such as 127.1, which are the same address) on the
 * port the token file names, else undefined. This guards against a wrong setting, not
 * against another program that takes the port after the ledger stops.
 */
export async function tokenForUrl(url, env = process.env) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1') return undefined;
  return (await clientToken(Number(parsed.port || 80), env)).token;
}

/** The value of one cookie in a Cookie header, or undefined. */
function cookieValue(header, name) {
  if (typeof header !== 'string') return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return undefined;
}

/** Keeps a map of digest -> expiry under a size bound, dropping expired and then oldest entries. */
function remember(map, key, expiresAt, limit, now) {
  for (const [entry, expiry] of map) if (expiry <= now) map.delete(entry);
  while (map.size >= limit) map.delete(map.keys().next().value);
  map.set(key, expiresAt);
}

function takeValid(map, key, now) {
  const expiry = map.get(key);
  if (expiry === undefined) return false;
  if (expiry <= now) {
    map.delete(key);
    return false;
  }
  return true;
}

/** The server's side: the token digest, one-time sign-in codes and browser sessions. */
export function createAuth({ token, port, now = Date.now }) {
  const tokenDigest = digest(token);
  const codes = new Map();
  const sessions = new Map();
  const cookieName = `context_ledger_${port}`;

  const bearer = request => {
    const match = /^Bearer ([A-Za-z0-9_-]{1,256})$/u.exec(request.headers.authorization ?? '');
    return Boolean(match) && timingSafeEqual(digest(match[1]), tokenDigest);
  };
  const session = request => {
    const value = cookieValue(request.headers.cookie, cookieName);
    return value !== undefined && secretPattern.test(value) && takeValid(sessions, digestKey(value), now());
  };

  return {
    cookieName,
    /** True when the request carries the bearer token. */
    bearer,
    /** True for this server's token (compared as digests, in constant time). */
    isOwnToken: text => timingSafeEqual(digest(text), tokenDigest),
    /** True when the request carries the bearer token or a live session cookie. */
    allowed: request => bearer(request) || session(request),
    /** True when the request carries a live browser session cookie (P2c). */
    signedIn: request => session(request),
    /** A new one-time sign-in code. */
    mintCode() {
      const code = newSecret();
      remember(codes, digestKey(code), now() + codeLifetimeMs, maxCodes, now());
      return code;
    },
    /** Uses up a code; returns the Set-Cookie value of a new session, or undefined. */
    redeem(code) {
      if (typeof code !== 'string' || !secretPattern.test(code)) return undefined;
      const key = digestKey(code);
      const valid = takeValid(codes, key, now());
      codes.delete(key);
      if (!valid) return undefined;
      const id = newSecret();
      remember(sessions, digestKey(id), now() + sessionLifetimeMs, maxSessions, now());
      return `${cookieName}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionLifetimeMs / 1000}`;
    },
  };
}
