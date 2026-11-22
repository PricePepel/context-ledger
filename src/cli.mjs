import { createHash } from 'node:crypto';
import { constants, lstat, open } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { handoffMarkdown } from './handoff.mjs';
import { setupAgents } from './install.mjs';
import { redactSession } from './secrets.mjs';
import {
  buildBundle, generateSigningKey, ledgerDatabasePath, loadSigningKey, normalizeFingerprint, signingKeyPath,
  verifyBundle, writeBundle,
} from './sign.mjs';
import { inlineText, terminalJson, terminalLabel, terminalLine } from './text.mjs';
import { clientToken } from './token.mjs';

const usage = 'Usage: npm run ledger -- search [--provider claude|codex] [--project <slug>] [query]\n' +
  '       npm run ledger -- import --provider claude|codex <file.jsonl>\n' +
  '       npm run ledger -- handoff <session-id> [--sign <new-folder>]\n' +
  '       npm run ledger -- keygen\n' +
  '       npm run ledger -- verify <folder> [--fingerprint <fingerprint>]\n' +
  '       npm run ledger -- reviews verify [--head <hash>]\n' +
  '       npm run ledger -- redact <session-id> [--json | --text]\n' +
  '       npm run ledger -- delete <session-id>\n' +
  '       npm run ledger -- graph publish <packet.json>\n' +
  '       npm run ledger -- graph read <graph-id>\n' +
  '       npm run ledger -- graph export <graph-id> [<graph-id>...]\n' +
  '       npm run ledger -- artifact add commit|pr|file <repo> <ref> [--project <slug>]\n' +
  '       npm run ledger -- artifact list [--project <slug>] [--limit <n>] [--after <id>]\n' +
  '       npm run ledger -- login\n' +
  '       npm run ledger -- import-t3 <copy-of-statev2.sqlite> [--thread <id>] [--list]\n' +
  '       npm run ledger -- install|uninstall [--agent claude|codex] [--dry-run]';
const maxGraphPacketBytes = 8 * 1024 * 1024;

// parseArgs errors quote the user's argument, so they are replaced by the usage text.
function options(args, spec) {
  try {
    return parseArgs({ args, options: spec, allowPositionals: true, strict: true });
  } catch {
    throw new Error(usage);
  }
}

function command(argv) {
  const [action, ...args] = argv;
  if (action === 'keygen' && args.length === 0) return { action };
  // Card P3: check the chain of review events in the ledger database.
  if (action === 'reviews' && args[0] === 'verify') {
    const { values, positionals } = options(args.slice(1), { head: { type: 'string' } });
    if (positionals.length === 0 && (values.head === undefined || /^[a-f0-9]{64}$/u.test(values.head))) {
      return { action: 'reviews-verify', head: values.head };
    }
    if (values.head !== undefined) throw new Error('--head must be a 64-character lowercase hex hash.');
  }
  if (action === 'verify') {
    const { values, positionals } = options(args, { fingerprint: { type: 'string' } });
    if (positionals.length === 1) {
      const fingerprint = values.fingerprint === undefined ? undefined : normalizeFingerprint(values.fingerprint);
      return { action, dir: positionals[0], fingerprint };
    }
  }
  if (action === 'search') {
    const { values, positionals } = options(args, { provider: { type: 'string' }, project: { type: 'string', multiple: true } });
    if (values.provider && !['claude', 'codex'].includes(values.provider)) {
      throw new Error('Provider must be claude or codex.');
    }
    // The same rule as the server's, checked here so a bad slug sends no request.
    if (values.project?.length > 1) throw new Error('Give --project once.');
    const [project] = values.project ?? [];
    if (project !== undefined && (project.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(project))) {
      throw new Error('Project must be a slug of at most 64 lowercase letters, digits and single hyphens.');
    }
    const query = new URLSearchParams({ q: positionals.join(' ') });
    if (values.provider) query.set('provider', values.provider);
    if (project) query.set('project', project);
    return { action, path: '/api/sessions?' + query };
  }
  if (action === 'import') {
    let parsed;
    try {
      parsed = parseArgs({ args, options: { provider: { type: 'string' } }, allowPositionals: true });
    } catch {
      // parseArgs quotes the bad option in its message, so print the usage instead.
      throw new Error(usage);
    }
    const { values, positionals } = parsed;
    if (!['claude', 'codex'].includes(values.provider)) throw new Error('Provider must be claude or codex.');
    if (positionals.length !== 1) throw new Error(usage);
    return { action, provider: values.provider, filePath: positionals[0] };
  }
  if (action === 'login' && args.length === 0) return { action, path: '/api/login', login: true };
  // Card P4b: report what in a session looks like a secret, without showing any value.
  if (action === 'redact' && args.length >= 1 && args.length <= 2 && /^[a-f0-9]{64}$/.test(args[0])) {
    const format = args[1] === undefined ? 'report' : args[1] === '--json' ? 'json' : args[1] === '--text' ? 'text' : null;
    if (format) return { action, format, id: args[0], path: '/api/sessions/' + args[0] };
  }
  if (action === 'handoff') {
    const { values, positionals } = options(args, { sign: { type: 'string' } });
    if (positionals.length === 1 && /^[a-f0-9]{64}$/.test(positionals[0]) && values.sign !== '') {
      return { action, path: '/api/sessions/' + positionals[0], sessionId: positionals[0], signDir: values.sign };
    }
  }
  // Card G12: one node-link file for one or more graphs, on stdout.
  if (action === 'graph' && args[0] === 'export' && args.length >= 2 && args.slice(1).every(id => /^[a-f0-9]{64}$/.test(id))) {
    return { action, path: '/api/export?' + new URLSearchParams(args.slice(1).map(id => ['graph', id])), raw: true };
  }
  // Card P2b: a person registers an artifact a version 3 graph can cite; the ledger checks it.
  if (action === 'artifact' && (args[0] === 'add' || args[0] === 'list')) {
    const { values, positionals } = options(args.slice(1), {
      project: { type: 'string', multiple: true }, limit: { type: 'string', multiple: true }, after: { type: 'string', multiple: true },
    });
    if (values.project?.length > 1 || values.limit?.length > 1 || values.after?.length > 1) throw new Error('Give each option once.');
    const [project] = values.project ?? [];
    if (project !== undefined && (project.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(project))) {
      throw new Error('Project must be a slug of at most 64 lowercase letters, digits and single hyphens.');
    }
    const [limit] = values.limit ?? [];
    const [after] = values.after ?? [];
    if (limit !== undefined && (!/^[1-9][0-9]{0,2}$/u.test(limit) || Number(limit) > 100)) throw new Error('Limit must be an integer from 1 to 100.');
    if (after !== undefined && !/^[a-f0-9]{64}$/u.test(after)) throw new Error('After must be an artifact ID from a previous list.');
    if (args[0] === 'list' && positionals.length === 0) {
      const query = new URLSearchParams({ ...(project ? { project } : {}), ...(limit ? { limit } : {}), ...(after ? { after } : {}) });
      return { action, path: '/api/artifacts' + (String(query) ? '?' + query : '') };
    }
    if (args[0] === 'add' && (limit !== undefined || after !== undefined)) throw new Error(usage);
    if (args[0] === 'add' && positionals.length === 3) {
      const [kind, repo, ref] = positionals;
      return { action, path: '/api/artifacts', body: JSON.stringify({ kind, repo, ref, ...(project ? { project } : {}) }) };
    }
  }
  if (action === 'delete' && args.length === 1 && /^[a-f0-9]{64}$/.test(args[0])) {
    return { action, path: '/api/sessions/' + args[0], sessionId: args[0] };
  }
  if (action === 'graph' && args.length === 2) {
    const [operation, value] = args;
    if (operation === 'publish') return { action, path: '/api/graphs', packetPath: value };
    if (operation === 'read' && /^[a-f0-9]{64}$/.test(value)) {
      return { action, path: '/api/graphs/' + value };
    }
  }
  throw new Error(usage);
}

async function readGraphPacket(packetPath) {
  let file;
  try {
    file = await open(packetPath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error('Graph packet must be a regular file.');
    if (stat.size > maxGraphPacketBytes) throw new Error('Graph packet exceeds 8 MiB.');

    // Keep the limit if the file grows between stat and read.
    const buffer = Buffer.allocUnsafe(maxGraphPacketBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size > maxGraphPacketBytes) throw new Error('Graph packet exceeds 8 MiB.');
    return buffer.subarray(0, size);
  } catch (error) {
    if (error.code) throw new Error('Cannot read graph packet file.');
    throw error;
  } finally {
    await file?.close();
  }
}

/** Card G8: install or uninstall the MCP server and instruction block for each agent. */
function setup(mode, args) {
  const { values, positionals } = parseArgs({
    args,
    options: { agent: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } },
    allowPositionals: true,
  });
  if (positionals.length || (values.agent !== undefined && !['claude', 'codex'].includes(values.agent))) throw new Error(usage);
  const agents = values.agent ? [values.agent] : ['claude', 'codex'];
  const { ok, lines } = setupAgents({ mode, agents, dryRun: values['dry-run'] });
  console.log(lines.join('\n'));
  if (!ok) process.exitCode = 1;
}

// Fixed sentences: they never name the token or the file's path.
const noToken = 'Cannot read the Context Ledger access token. Start the ledger with npm start, and run this with the same PORT and CONTEXT_LEDGER_DB as the ledger.';
const exposedToken = 'The Context Ledger access token file can be read by other users, so it was not used. Restart the ledger to write a private one.';
const refusedToken = 'Context Ledger refused the access token. Check that PORT and CONTEXT_LEDGER_DB match the running ledger.';
const tokenForOtherPort = other => `The Context Ledger access token is for the ledger on port ${other}, so it was not sent. Set PORT to ${other}, or use the CONTEXT_LEDGER_DB of the ledger on this port.`;

/**
 * Card I1: import a transcript file straight into the ledger database, read as a stream,
 * so files over the 8 MiB HTTP limit can be imported. The server need not be running.
 */
async function importFile(provider, filePath) {
  const { openStore, InputError } = await import('./store.mjs');
  let store;
  try {
    store = openStore(process.env.CONTEXT_LEDGER_DB ?? '.context-ledger/ledger.sqlite');
  } catch {
    // The underlying error names the database path, so it is not shown.
    throw new Error('Cannot open the ledger database.');
  }
  try {
    const { skipped, ...session } = await store.importTranscriptFile({ provider, path: filePath });
    console.log(terminalJson(skipped ? { session, skipped } : { session }));
  } catch (error) {
    // Store messages are fixed sentences; anything else may carry a path, so it is not shown.
    throw error instanceof InputError ? error : new Error('Import failed.');
  } finally {
    try { store.close(); } catch { /* the import result or error above is what matters */ }
  }
}

function ledgerPort() {
  const port = Number(process.env.PORT ?? 4317);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT.');
  return port;
}

// A server message is shown only when it is short, fixed-looking text.
function serverProblem(problem) {
  if (typeof problem?.error === 'string' && problem.error.length <= 160 && !/\p{C}/u.test(problem.error)) return problem.error;
}

// Messages the store can give for an import (src/store.mjs). Any other text from the
// server is replaced by a fixed sentence, so the CLI never prints what it did not write.
const knownImportProblems = new Set([
  'No supported conversation messages found.',
  'Invalid transcript file name.',
  'Transcript must be JSONL text.',
]);

/** One import request. Returns { session }, { refused }, or { lost, reached } when the outcome is unknown. */
async function postImport(port, request, maxBytes, auth) {
  const origin = `http://127.0.0.1:${port}`;
  const body = JSON.stringify(request);
  if (Buffer.byteLength(body) > maxBytes) return { refused: 'This T3 thread is larger than the 8 MiB import limit.' };
  let response;
  let text;
  try {
    response = await fetch(origin + '/api/import', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json', Origin: origin },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
    // Reading the body is part of the exchange: a drop here leaves the outcome unknown.
    text = await response.text();
  } catch {
    return { lost: true, reached: response !== undefined };
  }
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    // Handled below as an unexpected response.
  }
  if (response.status === 401) return { refused: refusedToken };
  if (response.status === 413) return { refused: 'This T3 thread is larger than the 8 MiB import limit.' };
  if (response.status === 400) {
    const problem = data?.error;
    return { refused: knownImportProblems.has(problem) ? problem : 'Context Ledger refused this T3 thread.' };
  }
  if (!response.ok) return { refused: `Context Ledger returned HTTP ${response.status}.` };
  // The store names a session by this hash (src/store.mjs). It keeps the source of the first
  // import of the same transcript, so the source is not compared.
  const expectedId = createHash('sha256').update(`${request.provider}\0`).update(request.transcript).digest('hex');
  const session = data?.session;
  if (session?.id !== expectedId || session.provider !== request.provider || typeof session.source !== 'string') {
    return { refused: 'Context Ledger returned an unexpected response.' };
  }
  return { session };
}

// Imports T3 Code threads from a copy of T3's database that the person names. Read-only;
// the copy is never looked for (src/t3code.mjs, docs/evals.md D3).
async function importT3(args) {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: { thread: { type: 'string' }, list: { type: 'boolean' } },
      allowPositionals: true,
    });
  } catch {
    throw new Error(usage);
  }
  const { values, positionals } = parsed;
  if (positionals.length !== 1) throw new Error(usage);
  // Loaded here so the other commands do not load node:sqlite and print its warning.
  const { maxImportBytes, openT3Copy, threadIdPattern } = await import('./t3code.mjs');
  if (values.thread !== undefined && !threadIdPattern.test(values.thread)) {
    throw new Error('A T3 thread ID is 1 to 128 letters, digits, hyphens or underscores.');
  }
  const port = values.list ? undefined : ledgerPort();
  const unreachable = `Cannot reach Context Ledger on port ${port}. Start it with npm start.`;
  // P1e: transcripts go only to the port the token file names, so they never reach a
  // listener that is not known to be the ledger. The token is read before the first send.
  let auth;
  const tokenAuth = async () => {
    const { token, otherPort, exposed } = await clientToken(port);
    if (exposed) throw new Error(exposedToken);
    if (token === undefined) throw new Error(otherPort !== undefined ? tokenForOtherPort(otherPort) : noToken);
    return { Authorization: `Bearer ${token}` };
  };

  const copy = openT3Copy(positionals[0]);
  try {
    const threads = copy.threads(values.thread);
    if (values.list) {
      console.log(terminalJson(threads.map(thread => copy.summary(thread))));
      return;
    }
    const imported = [];
    const refused = [];
    const unknown = [];
    let answered = false;
    for (const [index, thread] of threads.entries()) {
      const request = copy.importRequest(thread);
      if (!request.refusal) auth ??= await tokenAuth();
      const result = request.refusal ? { refused: request.refusal } : await postImport(port, request, maxImportBytes, auth);
      if (result.lost) {
        if (!answered && !result.reached) throw new Error(unreachable);
        // The server may have stored it before the connection dropped. Importing again is
        // safe: the same thread gives the same session.
        unknown.push({ thread: thread.id, unknown: 'The connection to Context Ledger was lost; this thread may not be imported.' });
        for (const rest of threads.slice(index + 1)) unknown.push({ thread: rest.id, unknown: 'Not tried after the connection was lost.' });
        break;
      }
      if (!request.refusal) answered = true;
      if (result.session) imported.push({ thread: thread.id, agent: request.provider, session: result.session });
      else refused.push({ thread: thread.id, refused: result.refused });
    }
    if (values.thread !== undefined && refused.length > 0) throw new Error(refused[0].refused);
    console.log(terminalJson({ imported, refused, ...(unknown.length ? { unknown } : {}) }));
    if (unknown.length > 0) console.error(unreachable + ' Run the same import again to finish; it does not import a thread twice.');
    if (refused.length > 0 || unknown.length > 0) process.exitCode = 1;
  } finally {
    copy.close();
  }
}

async function verifyCommand(dir, fingerprint) {
  const { problems, files, createdAt, session, fingerprint: signer, redaction } = await verifyBundle(dir, { fingerprint });
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    throw new Error('Verification failed.');
  }
  const listed = files.map(({ name, bytes }) => name + ' (' + bytes + ' bytes)').join(', ');
  // The scanner name passed an exact check, so it is printed as it is.
  const redacted = redaction === null ? 'not recorded (a version 1 bundle)'
    : `${redaction.findings} ${redaction.findings === 1 ? 'replacement' : 'replacements'}, by ${redaction.scanner}`;
  console.log('Verified: ' + listed + '.\nSession: ' + session + '\nSigned: ' + createdAt +
    '\nRedaction: ' + redacted + '\nKey fingerprint: ' + signer);
  if (redaction === null) {
    console.error('Warning: this bundle was signed before hand-offs were redacted. ' +
      'Its hand-off was not checked for secrets; read it with care before you pass it on.');
  }
  if (fingerprint === undefined) {
    console.error('Warning: the key was not checked. Ask the sender for the key fingerprint ' +
      'and run verify again with --fingerprint.');
  }
}

// Read one session straight from the ledger database, in this process (design ADR-2: one
// core behind CLI, HTTP and MCP). Signing never asks whatever answers on PORT for the
// content it signs.
/** Opens the ledger database only if it is already at this build's schema; never creates or migrates it. */
async function openCurrentStore(databasePath, upgradeHint) {
  try {
    await lstat(databasePath);
  } catch (error) {
    // Never create an empty database just to find no session in it.
    if (error.code === 'ENOENT') throw new Error('No ledger database. Import a session first, or set CONTEXT_LEDGER_DB.');
    throw new Error('Cannot open the ledger database.');
  }
  // Loaded only here: node:sqlite prints an experimental warning when it loads.
  const { DatabaseSync } = await import('node:sqlite');
  const { schemaVersion } = await import('./migrate.mjs');
  // openStore creates missing tables and migrates an older file. Signing must not change
  // the ledger, so read the schema version first with a connection that cannot write or
  // create a file (a dangling symlink stays dangling), and open the store only when the
  // file is already at the current version.
  let version;
  try {
    const probe = new DatabaseSync(databasePath, { readOnly: true });
    try {
      version = probe.prepare('PRAGMA user_version').get().user_version;
    } finally {
      probe.close();
    }
  } catch {
    throw new Error('Cannot open the ledger database.');
  }
  if (version > schemaVersion) {
    throw new Error(`This ledger database was written by a newer Context Ledger (schema ${version}). ` +
      'Use that version or another CONTEXT_LEDGER_DB.');
  }
  if (version < schemaVersion) {
    throw new Error('This ledger database has an older schema. Start Context Ledger once with npm start ' +
      `to upgrade it, then ${upgradeHint} again.`);
  }
  const { openStore } = await import('./store.mjs');
  try {
    return openStore(databasePath);
  } catch {
    throw new Error('Cannot open the ledger database.');
  }
}

async function readLedgerSession(databasePath, sessionId) {
  const store = await openCurrentStore(databasePath, 'sign');
  try {
    let session;
    try {
      session = store.get(sessionId);
    } catch {
      throw new Error('Cannot read the ledger database.');
    }
    if (session?.id !== sessionId) throw new Error('Session not found.');
    return session;
  } finally {
    store.close();
  }
}

// Card P3: recompute the chain of review events. A broken chain is an error, and its
// first bad event is named by number only, never by what it says.
async function reviewsVerifyCommand(trustedHead) {
  const store = await openCurrentStore(ledgerDatabasePath(), 'verify');
  let result;
  try {
    result = store.verifyReviews(trustedHead);
  } catch {
    throw new Error('Cannot read the ledger database.');
  } finally {
    store.close();
  }
  if (result.brokenAt !== undefined) {
    throw new Error(`Review chain broken at event ${result.brokenAt}: it does not match the events before it.`);
  }
  if (trustedHead !== undefined && result.trustedAt === null) {
    throw new Error('The trusted head is not in this review chain: events up to it were removed or rewritten.');
  }
  const count = `${result.events} ${result.events === 1 ? 'event' : 'events'}`;
  if (trustedHead === undefined) {
    console.log(`Review chain verified: ${count}.\nHead: ${result.head}`);
    // A chain cut short at its end still checks; only a head kept from earlier can show that.
    console.error('Note: events removed from the end would not show. Keep this head and run again with --head to check.');
    return;
  }
  const since = result.events - result.trustedAt;
  console.log(`Review chain verified: ${count}, with the trusted head at event ${result.trustedAt} (${since} added since).\nHead: ${result.head}`);
}

async function signCommand(sessionId, signDir) {
  // Load the key first, so a missing key fails before anything is read or written.
  const privateKey = await loadSigningKey(signingKeyPath());
  const session = await readLedgerSession(ledgerDatabasePath(), sessionId);
  // Card P4d: what is signed is always the redacted hand-off; there is no way to opt out.
  const { session: redacted, findings } = redactSession(session);
  const bundle = buildBundle({ sessionId, markdown: handoffMarkdown(redacted) + '\n', findings: findings.length, privateKey });
  await writeBundle(signDir, bundle);
  console.log('Signed hand-off written to ' + terminalLabel(signDir) + '\n' + redactionLine(findings, sessionId) +
    '\nKey fingerprint: ' + bundle.fingerprint);
}

/** The sender's summary of what signing redacted: counts only, never a value or preview. */
function redactionLine(findings, sessionId) {
  if (findings.length === 0) {
    return 'Redacted: nothing; the secret checks found no value. They cannot find every secret, so read handoff.md before you send it.';
  }
  // Counted by transcript line (one message each), with the source name named apart.
  const lines = new Set(findings.filter(finding => finding.line !== null).map(finding => finding.line)).size;
  const source = findings.some(finding => finding.line === null);
  const where = [lines ? `${lines} transcript ${lines === 1 ? 'line' : 'lines'}` : '', source ? 'the source name' : '']
    .filter(Boolean).join(' and ');
  return `Redacted: ${findings.length} possible ${findings.length === 1 ? 'secret' : 'secrets'} in ${where}, ` +
    'each replaced by [REDACTED <kind>]. ' +
    `Run npm run ledger -- redact ${sessionId} to see where. Read handoff.md before you send it.`;
}

// The hand-off renderer keeps ZWNJ, ZWJ and tabs; the redaction view escapes every format
// character and tab too, so nothing in it can be hidden or misaligned.
const strict = text => text.replace(/[\p{Cf}\t]/gu, character => Array.from({ length: character.length },
  (_, index) => `\\u${character.charCodeAt(index).toString(16).padStart(4, '0')}`).join(''));

/** A session as the server returns it, checked before anything is scanned or printed. */
function sessionShape(data, id) {
  const session = data?.session;
  // Provider and role are printed as they are, so only the values the store writes pass.
  const ok = session && typeof session === 'object' && session.id === id && typeof session.source === 'string'
    && (session.provider === 'claude' || session.provider === 'codex') && Array.isArray(session.messages)
    && session.messages.every(message => message && typeof message.text === 'string'
      && ['user', 'assistant', 'agent'].includes(message.role)
      && (message.role !== 'agent' || (typeof message.author === 'string' && typeof message.recipient === 'string'))
      && Number.isSafeInteger(message.line) && message.line >= 1);
  if (!ok) throw new Error('Context Ledger returned an unexpected session response.');
  return session;
}

/** Card P4b: the redaction report, the findings as JSON, or the redacted hand-off. */
function redactionOutput(session, format) {
  const { session: redacted, findings } = redactSession(session);
  if (format === 'text') return strict(handoffMarkdown(redacted));
  const lines = new Set(findings.map(finding => finding.line ?? 'source')).size;
  if (format === 'json') return terminalJson({ sessionId: session.id, count: findings.length, lines, findings });
  const rows = findings.map(finding => `${finding.line === null ? 'source name' : `line ${finding.line}`}  ${finding.kind}  ${finding.length} characters  ${strict(inlineText(finding.preview))}`);
  const total = findings.length
    ? `${findings.length} possible ${findings.length === 1 ? 'secret' : 'secrets'} in ${lines} ${lines === 1 ? 'line' : 'lines'}. Values are not shown; use --text for the redacted hand-off.`
    : 'No findings from the checks below.';
  // Say what is checked (P4b key formats, P4c line tails), so a clean report is not read as "no secrets".
  return [...rows, total, 'Checked: known key formats, and the rest of the same line after an Authorization: Bearer header or a secret-like name followed by : or = (such as password=), unless the whole value is a placeholder. A value that continues onto the next line, and other free-text secrets, are not found.'].join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === 'import-t3') return importT3(argv.slice(1));
  // Card G8: setup edits the agents' own config files and needs no server.
  if (argv[0] === 'install' || argv[0] === 'uninstall') return setup(argv[0], argv.slice(1));
  const { action, path, packetPath, body, login, sessionId, provider, filePath, raw, signDir, dir, fingerprint, format, id, head } = command(argv);
  // Card I1: a file import opens the database itself, so it needs no running server or token.
  if (action === 'import') return importFile(provider, filePath);
  // Card P4a: keys, signing and checking work on local files; signing reads the session
  // from the ledger database in this process, never from whatever answers on PORT.
  if (action === 'keygen') {
    console.log(await generateSigningKey(signingKeyPath()));
    return;
  }
  if (action === 'verify') {
    await verifyCommand(dir, fingerprint);
    return;
  }
  if (action === 'reviews-verify') {
    await reviewsVerifyCommand(head);
    return;
  }
  if (action === 'handoff' && signDir !== undefined) {
    await signCommand(sessionId, signDir);
    return;
  }
  const port = ledgerPort();
  const origin = `http://127.0.0.1:${port}`;
  // The token goes only to the port its file names. Without it the request still goes
  // out, so a ledger that is not running gives the "Cannot reach" message.
  const { token, otherPort, exposed } = await clientToken(port);
  const headers = token === undefined ? {} : { Authorization: `Bearer ${token}` };
  // A token file others can read is not used, and nothing is sent.
  if (exposed) throw new Error(exposedToken);
  const withoutToken = otherPort !== undefined ? tokenForOtherPort(otherPort) : noToken;
  // A graph packet or a delete is not sent where the token does not go: the listener on
  // this port is not known to be the ledger.
  if ((packetPath !== undefined || body !== undefined || action === 'delete') && token === undefined) throw new Error(withoutToken);
  let write = login ? { method: 'POST' } : {};
  if (packetPath !== undefined || body !== undefined) {
    const sent = body ?? await readGraphPacket(packetPath);
    write = { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: sent };
  } else if (action === 'delete') {
    write = { method: 'DELETE', headers: { Origin: origin } };
  }
  let response;
  try {
    response = await fetch(origin + path, {
      ...write,
      headers: { ...write.headers, ...headers },
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    if (action === 'delete' && error?.name === 'TimeoutError') {
      throw new Error('Context Ledger did not answer within 5 seconds. The session may or may not be deleted; search to check.');
    }
    throw new Error(`Cannot reach Context Ledger on port ${port}. Start it with npm start.`);
  }
  if (response.status === 401) throw new Error(token !== undefined ? refusedToken : withoutToken);
  if (login) {
    const data = response.ok ? await response.json().catch(() => null) : null;
    // Print only a link of the expected shape, so nothing else reaches the terminal.
    if (typeof data?.path !== 'string' || !/^\/login\?code=[A-Za-z0-9_-]{43}$/u.test(data.path)) {
      throw new Error(`Context Ledger returned HTTP ${response.status}.`);
    }
    console.log(`Open this link in your browser within a minute (it works once): ${origin}${data.path}`);
    return;
  }
  if (response.status === 404) throw new Error(action === 'graph' ? 'Graph not found.' : 'Session not found.');
  if (!response.ok) {
    if ((action === 'graph' || action === 'artifact') && (response.status === 400 || response.status === 413)) {
      const message = serverProblem(await response.json().catch(() => null));
      if (message) throw new Error(message);
    }
    if (action === 'delete' && response.status === 409) {
      // Built from the count alone, so no text from the server reaches the terminal.
      const problem = await response.json().catch(() => null);
      const graphs = problem?.graphs;
      if (Number.isSafeInteger(graphs) && graphs > 0) {
        throw new Error(`Session is cited by ${graphs} ${graphs === 1 ? 'graph' : 'graphs'}, so it was not deleted.`);
      }
      if (problem?.journalMode === 'wal' || problem?.journalMode === 'persist') {
        throw new Error('The ledger database does not use the default rollback journal, so the session was not deleted.');
      }
    }
    throw new Error(`Context Ledger returned HTTP ${response.status}.`);
  }
  if (action === 'redact') {
    let session;
    try {
      session = sessionShape(await response.json(), id);
    } catch {
      // The parser's message can quote response bytes, so it is never shown.
      throw new Error('Context Ledger returned an unexpected session response.');
    }
    console.log(redactionOutput(session, format));
    return;
  }
  // A JSON parse error quotes the body, which is the server's text: never print it.
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error('Context Ledger returned an unexpected response.');
  }
  if (action === 'delete') {
    if (data?.deleted !== sessionId) throw new Error('Context Ledger returned an unexpected response.');
    console.log(`Deleted session ${sessionId}.`);
    return;
  }
  // The export is the node-link JSON itself, escaped here as well as by the ledger.
  if (raw) {
    console.log(terminalJson(data));
    return;
  }
  if (action === 'graph' || action === 'artifact') {
    console.log(terminalJson(data));
    return;
  }
  console.log(action === 'search' ? terminalJson(data.sessions) : handoffMarkdown(data.session));
}

main().catch(error => {
  // The usage text is ours and spans lines; any other message is escaped onto one line, in
  // case it ever carries text from the command line or a file.
  console.error(error.message === usage ? usage : terminalLine(error.message));
  process.exitCode = 1;
});
