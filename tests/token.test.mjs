import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { chmod, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { codeLifetimeMs, createAuth, emptyIfOwnRecord, privateToOwner, readTokenFile, sessionLifetimeMs, tokenFileFor, tokenForUrl } from '../src/token.mjs';
import { restrictToOwner } from './ledger-auth.mjs';
import { startMcp } from './mcp-client.mjs';

// P1e: the loopback API token (ADR-10). Synthetic data and temporary databases only.
const execute = promisify(execFile);
const secret = /^[A-Za-z0-9_-]{43}$/u;
const signIn = { error: 'Sign in first: run npm run ledger -- login and open the link it prints.' };
const cliNoToken = 'Cannot read the Context Ledger access token. Start the ledger with npm start, and run this with the same PORT and CONTEXT_LEDGER_DB as the ledger.';
const refused = 'Context Ledger refused the access token. Check that PORT and CONTEXT_LEDGER_DB match the running ledger.';
const mcpNoToken = 'Cannot read the Context Ledger access token. Start the ledger with npm start, and give this MCP server the same PORT and CONTEXT_LEDGER_DB as the ledger (an absolute path).';
const exposedToken = 'The Context Ledger access token file can be read by other users, so it was not used. Restart the ledger to write a private one.';

// Token files are written owner-only: on POSIX a client refuses any other mode, and on
// Windows any ACL that allows another user.
const writeTokenText = async (path, text) => {
  await writeFile(path, text, { mode: 0o600 });
  restrictToOwner(path);
};
// The token file of a database for a port no test server uses (it is per port).
const anyPortFile = database => tokenFileFor(database, 4317);

// A port that was free a moment ago, for tests that put something at a server's token
// path before it starts.
async function freePort() {
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  return port;
}

// Windows only: the current user's SID and a file's owner, group and DACL as SDDL,
// read with Get-Acl (the test's own call; it does not use src/token.mjs).
const system32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
async function windowsSecurity(path) {
  const script = "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; " +
    '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; (Get-Acl -LiteralPath $env:TEST_FILE).Sddl';
  const { stdout } = await execute(join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { env: { ...process.env, TEST_FILE: path } });
  const [sid, sddl] = stdout.split(/\r?\n/u);
  return { sid, sddl };
}
// A token file as the server writes it, for a ledger on this port.
const tokenRecord = (port, token) => JSON.stringify({ port, token }) + '\n';

async function startServer(database, { port: wanted = 0, env = {} } = {}) {
  const child = spawn(process.execPath, ['src/server.mjs'], {
    env: { ...process.env, PORT: String(wanted), CONTEXT_LEDGER_DB: database, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let errors = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { errors += chunk; });
  child.stdout.setEncoding('utf8');
  // Wait for both start-up lines: the address and the sign-in link.
  const port = await new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/listening at http:\/\/127\.0\.0\.1:(\d+)\n[^\n]*\n/u);
      if (match) resolve(Number(match[1]));
    });
    child.once('exit', () => reject(new Error('Server exited before listening: ' + output + errors)));
  });
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    token: (await readTokenFile(tokenFileFor(database, port)))?.token,
    output: () => output + errors,
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await once(child, 'exit');
      }
    },
  };
}

function raw(port, { method = 'GET', path, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, method, path, headers: { Host: `127.0.0.1:${port}`, ...headers }, agent: false }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = text;
        if (response.headers['content-type']?.startsWith('application/json') && text) parsed = JSON.parse(text);
        resolve({ status: response.statusCode, headers: response.headers, body: parsed });
      });
    });
    request.on('error', reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-token-'));
  const servers = [];
  const clients = [];
  t.after(async () => {
    try {
      for (const client of clients) if (client.child.exitCode === null) await client.close();
      for (const server of servers) await server.stop();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  return {
    directory,
    database: join(directory, 'ledger.sqlite'),
    start: async (database, options) => {
      const server = await startServer(database ?? join(directory, 'ledger.sqlite'), options);
      servers.push(server);
      return server;
    },
    mcp: (port, env) => {
      const client = startMcp(port, env);
      clients.push(client);
      return client;
    },
  };
}

const bearer = token => ({ Authorization: `Bearer ${token}` });
const cli = (args, env) => execute(process.execPath, ['src/cli.mjs', ...args], { env: { ...process.env, ...env } })
  .then(({ stdout, stderr }) => ({ code: 0, stdout, stderr }), error => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }));

async function signInCookie(server) {
  const minted = await raw(server.port, { method: 'POST', path: '/api/login', headers: bearer(server.token) });
  assert.equal(minted.status, 200);
  const signedIn = await raw(server.port, { path: minted.body.path });
  assert.equal(signedIn.status, 303);
  return signedIn.headers['set-cookie'][0].split(';')[0];
}

test('each start writes a fresh 32-byte token next to the database, owner-only, and never prints it', async t => {
  const place = await temporary(t);
  const nested = join(place.directory, 'data', 'ledger.sqlite');
  // A stale file with other content is replaced, not appended to or reused.
  await mkdir(join(place.directory, 'data'), { recursive: true, mode: 0o700 });
  const wanted = await freePort();
  await writeTokenText(tokenFileFor(nested, wanted), 'stale-token-from-an-old-start\n');
  const first = await place.start(nested, { port: wanted });
  assert.equal(first.port, wanted);
  assert.match(first.token, secret);
  assert.equal(Buffer.from(first.token, 'base64url').length, 32);
  assert.equal((await readFile(tokenFileFor(nested, first.port), 'utf8')), tokenRecord(first.port, first.token));
  assert.equal(first.output().includes(first.token), false, 'the token is never printed');
  if (process.platform !== 'win32') {
    assert.equal((await stat(tokenFileFor(nested, first.port))).mode & 0o777, 0o600);
  }
  assert.equal((await raw(first.port, { path: '/api/sessions', headers: bearer(first.token) })).status, 200);
  await first.stop();

  const second = await place.start(nested);
  assert.notEqual(second.token, first.token);
  assert.equal((await raw(second.port, { path: '/api/sessions', headers: bearer(first.token) })).status, 401, 'the old token is dead');
  assert.equal((await raw(second.port, { path: '/api/sessions', headers: bearer(second.token) })).status, 200);
});

test('a new folder for the database and token is created owner-only', { skip: process.platform === 'win32' && 'Windows ignores the mode; the folder takes its parent ACL.' }, async t => {
  const place = await temporary(t);
  const database = join(place.directory, 'fresh', 'ledger.sqlite');
  await place.start(database);
  assert.equal((await stat(join(place.directory, 'fresh'))).mode & 0o777, 0o700);
});

test('a link planted at the token path is replaced, not written through', { skip: process.platform === 'win32' && 'Symbolic links need extra rights on Windows.' }, async t => {
  const place = await temporary(t);
  const target = join(place.directory, 'target.txt');
  await writeFile(target, 'synthetic target\n');
  const wanted = await freePort();
  await symlink(target, tokenFileFor(place.database, wanted));
  const server = await place.start(undefined, { port: wanted });
  assert.equal(await readFile(target, 'utf8'), 'synthetic target\n');
  assert.equal((await stat(tokenFileFor(place.database, wanted))).isFile(), true);
  assert.match(server.token, secret);
});

test('a server that cannot write its token file stops with a fixed sentence that names no path', async t => {
  const place = await temporary(t);
  // A folder where the token file should go cannot be removed without recursion.
  const wanted = await freePort();
  await mkdir(tokenFileFor(place.database, wanted), { recursive: true });
  await writeFile(join(tokenFileFor(place.database, wanted), 'keep.txt'), 'synthetic\n');
  const child = spawn(process.execPath, ['src/server.mjs'], { env: { ...process.env, PORT: String(wanted), CONTEXT_LEDGER_DB: place.database }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 1);
  assert.match(output, /Cannot write the access token file next to the database\. Set CONTEXT_LEDGER_DB to a file in a folder you own\./u);
  assert.equal(output.includes(place.directory), false);
  assert.equal(output.includes('listening'), false);
});

test('every guarded request needs the exact token or a live session cookie', async t => {
  const place = await temporary(t);
  const server = await place.start();
  const { port, token } = server;
  const get = headers => raw(port, { path: '/api/sessions', headers });
  assert.equal((await get(bearer(token))).status, 200);
  const wrong = [
    {},
    { Authorization: token },
    { Authorization: `bearer ${token}` },
    { Authorization: `Basic ${token}` },
    { Authorization: `Bearer ${token}x` },
    { Authorization: `Bearer ${token.slice(0, -1)}` },
    { Authorization: `Bearer  ${token}` },
    { Authorization: `Bearer ${token.slice(0, -1)}${token.at(-1) === 'A' ? 'B' : 'A'}` },
    { Authorization: `Bearer ${'x'.repeat(300)}` },
    { Cookie: `context_ledger_${port}=${token}` },
    { Cookie: `token=${token}` },
    { Cookie: `context_ledger_${port}=${'A'.repeat(43)}` },
  ];
  for (const headers of wrong) {
    const response = await get(headers);
    assert.equal(response.status, 401, JSON.stringify(Object.keys(headers)));
    assert.deepEqual(response.body, signIn);
    assert.equal(response.headers['www-authenticate'], 'Bearer realm="Context Ledger"');
    assert.equal(response.headers['set-cookie'], undefined);
  }
  // A foreign Host is refused before the token is looked at; static files stay public.
  assert.equal((await raw(port, { path: '/api/sessions', headers: { Host: 'evil.example', ...bearer(token) } })).status, 403);
  assert.equal((await raw(port, { path: '/app.js' })).status, 200);
  // The token does not relax the Origin rule on writes.
  const foreign = await raw(port, { method: 'POST', path: '/api/import', body: '{}',
    headers: { ...bearer(token), 'Content-Type': 'application/json', Origin: 'https://foreign.example' } });
  assert.deepEqual({ status: foreign.status, body: foreign.body }, { status: 403, body: { error: 'Import requires the same origin.' } });
});

test('the browser signs in once with a short-lived code and then uses an HttpOnly, SameSite=Strict cookie', async t => {
  const place = await temporary(t);
  const server = await place.start();
  const { port, origin, token } = server;

  // The start-up line carries a working code; the token is not in it.
  const startLink = server.output().match(/Sign in to the browser app \(one use, within 60 seconds\): (http:\/\/127\.0\.0\.1:\d+(\/login\?code=[A-Za-z0-9_-]{43}))\n/u);
  assert.ok(startLink, server.output());
  assert.equal(startLink[1].includes(token), false);
  const atStart = await raw(port, { path: startLink[2] });
  assert.equal(atStart.status, 303);

  // `npm run ledger -- login` prints a new one.
  const printed = await cli(['login'], { PORT: String(port), CONTEXT_LEDGER_DB: place.database });
  assert.equal(printed.code, 0, printed.stderr);
  const link = printed.stdout.match(/^Open this link in your browser within a minute \(it works once\): (http:\/\/127\.0\.0\.1:\d+)(\/login\?code=([A-Za-z0-9_-]{43}))\n$/u);
  assert.ok(link, printed.stdout);
  assert.equal(link[1], origin);
  assert.notEqual(link[3], token);

  const signedIn = await raw(port, { path: link[2] });
  assert.equal(signedIn.status, 303);
  assert.equal(signedIn.headers.location, '/');
  const [cookie] = signedIn.headers['set-cookie'];
  assert.match(cookie, new RegExp(`^context_ledger_${port}=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200$`, 'u'));
  const session = cookie.split(';')[0];
  assert.equal(session.includes(token), false, 'the cookie is not the token');
  assert.equal(signedIn.headers['cache-control'], 'no-store');
  assert.equal(signedIn.headers['referrer-policy'], 'no-referrer');

  // The cookie reads and, with the same Origin, writes; the decisions route takes it.
  assert.equal((await raw(port, { path: '/api/sessions', headers: { Cookie: `other=1; ${session}` } })).status, 200);
  const imported = await raw(port, { method: 'POST', path: '/api/import', headers: { Cookie: session, 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ provider: 'claude', source: 'vela.jsonl', transcript: JSON.stringify({ type: 'user', message: { role: 'user', content: 'Plan the synthetic Vela review.' } }) }) });
  assert.equal(imported.status, 200);
  const foreignWrite = await raw(port, { method: 'POST', path: '/api/import', body: '{}', headers: { Cookie: session, 'Content-Type': 'application/json', Origin: 'https://foreign.example' } });
  assert.equal(foreignWrite.status, 403);

  // A code works once; an unknown, malformed, repeated or missing code gives no cookie.
  const linkFailure = { error: 'This sign-in link was already used, has expired or is not valid. Run npm run ledger -- login for a new one.' };
  const fresh = async () => (await raw(port, { method: 'POST', path: '/api/login', headers: bearer(token) })).body.path.slice('/login?code='.length);
  const [first, second] = [await fresh(), await fresh()];
  for (const path of [link[2], startLink[2], `/login?code=${'A'.repeat(43)}`, '/login?code=short', '/login', `/login?code=${token}`,
    `/login?code=${first}&code=${second}`]) {
    const again = await raw(port, { path });
    assert.deepEqual({ status: again.status, body: again.body }, { status: 401, body: linkFailure }, path);
    assert.equal(again.headers['set-cookie'], undefined, path);
  }
  // Two codes in one link are refused without using up either.
  for (const code of [first, second]) assert.equal((await raw(port, { path: `/login?code=${code}` })).status, 303);

  // A cookie alone can confirm a room proposal only as a same-origin browser request.
  const party = async (name, text) => (await raw(port, { method: 'POST', path: '/api/import', headers: { Cookie: session, 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ provider: 'claude', source: `${name}.jsonl`, transcript: JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) }) })).body.session;
  const post = (path, data, headers = {}) => raw(port, { method: 'POST', path, body: JSON.stringify(data),
    headers: { Cookie: session, 'Content-Type': 'application/json', Origin: origin, ...headers } });
  const leo = await party('leo', 'Leo plans the synthetic Vela launch.');
  const ali = await party('ali', 'Ali reviews the synthetic Vela launch.');
  const packet = (session, name, extra = {}) => ({ version: 2, sessionId: session.id, party: name, nodes: [{ id: 'goal', kind: 'goal', label: 'Vela launch', evidenceLines: [1] }], edges: [], ...extra });
  const leoGraph = (await post('/api/graphs', packet(leo, 'leo'))).body.graph;
  const aliGraph = (await post('/api/graphs', packet(ali, 'ali', { links: [{ from: 'goal', graph: leoGraph.id, to: 'goal', type: 'matches' }] }))).body.graph;
  const room = (await post('/api/rooms', { graphIds: [leoGraph.id, aliGraph.id] })).body.room;
  const choice = { proposalId: room.proposals[0].id, party: 'leo', choice: 'confirm' };
  assert.equal((await post(`/api/rooms/${room.id}/decisions`, choice)).status, 403, 'without Sec-Fetch-Site');
  const decided = await post(`/api/rooms/${room.id}/decisions`, choice, { 'Sec-Fetch-Site': 'same-origin' });
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
  assert.equal(decided.body.room.proposals[0].choices.leo, 'confirm');
  const noCookie = await raw(port, { method: 'POST', path: `/api/rooms/${room.id}/decisions`, body: JSON.stringify(choice),
    headers: { 'Content-Type': 'application/json', Origin: origin, 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal(noCookie.status, 401);

  // Codes are minted with the token only: not with a cookie, not without anything.
  const withCookie = await raw(port, { method: 'POST', path: '/api/login', headers: { Cookie: session } });
  assert.deepEqual({ status: withCookie.status, body: withCookie.body },
    { status: 403, body: { error: 'Sign-in links are made with the access token: run npm run ledger -- login.' } });
  assert.equal((await raw(port, { method: 'POST', path: '/api/login' })).status, 401);
  const minted = await raw(port, { method: 'POST', path: '/api/login', headers: bearer(token) });
  assert.equal(minted.status, 200);
  assert.deepEqual(Object.keys(minted.body), ['path', 'expiresInSeconds']);
  assert.equal(minted.body.expiresInSeconds, 60);
  assert.match(minted.body.path, /^\/login\?code=[A-Za-z0-9_-]{43}$/u);

  // A restart forgets every session and code.
  await server.stop();
  const restarted = await place.start();
  const stale = await raw(restarted.port, { path: '/api/sessions', headers: { Cookie: session.replace(`_${port}=`, `_${restarted.port}=`) } });
  assert.equal(stale.status, 401);
  assert.equal(server.output().includes(token), false);
});

test('codes expire after 60 seconds and sessions after 12 hours; both are bounded in number', () => {
  let now = 1_000_000;
  const auth = createAuth({ token: 'T'.repeat(43), port: 4317, now: () => now });
  const cookieOf = setCookie => ({ headers: { cookie: setCookie.split(';')[0] } });
  assert.equal(codeLifetimeMs, 60_000);
  assert.equal(sessionLifetimeMs, 12 * 3_600_000);

  const late = auth.mintCode();
  now += codeLifetimeMs;
  assert.equal(auth.redeem(late), undefined, 'a code at its expiry is refused');
  const early = auth.mintCode();
  now += codeLifetimeMs - 1;
  const setCookie = auth.redeem(early);
  assert.ok(setCookie);
  assert.equal(auth.allowed(cookieOf(setCookie)), true);
  now += sessionLifetimeMs - 1;
  assert.equal(auth.allowed(cookieOf(setCookie)), true);
  now += 1;
  assert.equal(auth.allowed(cookieOf(setCookie)), false, 'a session at its expiry is refused');

  // Only the newest 32 codes stay valid, and only the newest 64 sessions.
  const codes = Array.from({ length: 40 }, () => auth.mintCode());
  assert.equal(auth.redeem(codes[0]), undefined);
  assert.ok(auth.redeem(codes[39]));
  const sessions = [];
  for (let index = 0; index < 70; index += 1) sessions.push(auth.redeem(auth.mintCode()));
  assert.equal(auth.allowed(cookieOf(sessions[0])), false);
  assert.equal(auth.allowed(cookieOf(sessions[69])), true);

  // The bearer check takes only the exact token.
  assert.equal(auth.bearer({ headers: { authorization: `Bearer ${'T'.repeat(43)}` } }), true);
  assert.equal(auth.allowed({ headers: { authorization: `Bearer ${'T'.repeat(42)}U` } }), false);
  assert.equal(auth.allowed({ headers: {} }), false);
});

test('the CLI sends the token from the file named by CONTEXT_LEDGER_DB, and its errors name no token or path', async t => {
  const place = await temporary(t);
  const server = await place.start();
  const env = { PORT: String(server.port), CONTEXT_LEDGER_DB: place.database };
  const searched = await cli(['search', 'vela'], env);
  assert.deepEqual({ code: searched.code, stdout: searched.stdout }, { code: 0, stdout: '[]\n' });

  const missing = await cli(['search', 'vela'], { ...env, CONTEXT_LEDGER_DB: join(place.directory, 'other.sqlite') });
  assert.deepEqual({ code: missing.code, stderr: missing.stderr }, { code: 1, stderr: cliNoToken + '\n' });
  const malformed = join(place.directory, 'malformed.sqlite');
  await writeTokenText(tokenFileFor(malformed, server.port), 'not a token\n');
  assert.equal((await cli(['search', 'vela'], { ...env, CONTEXT_LEDGER_DB: malformed })).stderr, cliNoToken + '\n');
  // A token file in the old one-line format, or naming no port, is not a token.
  await writeTokenText(tokenFileFor(malformed, server.port), 'A'.repeat(43) + '\n');
  assert.equal((await cli(['search', 'vela'], { ...env, CONTEXT_LEDGER_DB: malformed })).stderr, cliNoToken + '\n');
  await writeTokenText(tokenFileFor(malformed, server.port), JSON.stringify({ token: 'A'.repeat(43) }));
  assert.equal((await cli(['search', 'vela'], { ...env, CONTEXT_LEDGER_DB: malformed })).stderr, cliNoToken + '\n');
  const stale = join(place.directory, 'stale.sqlite');
  await writeTokenText(tokenFileFor(stale, server.port), tokenRecord(server.port, 'A'.repeat(43)));
  const refusedRun = await cli(['search', 'vela'], { ...env, CONTEXT_LEDGER_DB: stale });
  assert.deepEqual({ code: refusedRun.code, stderr: refusedRun.stderr }, { code: 1, stderr: refused + '\n' });
  assert.equal((await cli(['login'], { ...env, CONTEXT_LEDGER_DB: stale })).stderr, refused + '\n');
  for (const run of [missing, refusedRun]) {
    assert.equal(run.stderr.includes(server.token), false);
    assert.equal(run.stderr.includes(place.directory), false);
    assert.equal(run.stdout, '');
  }

  // A ledger that is not running still gives the old message, with or without a token.
  await server.stop();
  assert.equal((await cli(['search', 'vela'], env)).stderr, `Cannot reach Context Ledger on port ${server.port}. Start it with npm start.\n`);
  assert.equal((await cli(['search', 'vela'], { ...env, CONTEXT_LEDGER_DB: join(place.directory, 'none.sqlite') })).stderr,
    `Cannot reach Context Ledger on port ${server.port}. Start it with npm start.\n`);
});

async function fakeLedger(t, status = 200) {
  const seen = [];
  const fake = createServer((request, response) => {
    seen.push({ url: request.url, authorization: request.headers.authorization });
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(status === 200 ? { sessions: [] } : { error: 'Sign in first.' }));
  });
  await new Promise(resolve => fake.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => fake.close(resolve)));
  return { seen, port: fake.address().port };
}

test('the CLI and the MCP adapter put the file token in the Authorization header', async t => {
  const place = await temporary(t);
  const token = 'Z'.repeat(20) + '_-' + 'y'.repeat(21);
  const { seen, port } = await fakeLedger(t);
  await writeTokenText(tokenFileFor(place.database, port), tokenRecord(port, token));
  const searched = await cli(['search', 'vela'], { PORT: String(port), CONTEXT_LEDGER_DB: place.database });
  assert.equal(searched.code, 0, searched.stderr);
  const client = place.mcp(port, { CONTEXT_LEDGER_DB: place.database });
  await client.request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  const result = await client.call(2, 'session_search', { query: 'vela' });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.deepEqual(seen.map(entry => entry.authorization), [`Bearer ${token}`, `Bearer ${token}`]);
});

test('the CLI and the MCP adapter never send the token to a port its file does not name', async t => {
  const place = await temporary(t);
  const token = 'Q'.repeat(43);
  const { seen, port } = await fakeLedger(t, 401);
  const ledgerPort = port === 65535 ? port - 1 : port + 1;
  // This port's file names another port (a file copied or renamed): the token stays home.
  await writeTokenText(tokenFileFor(place.database, port), tokenRecord(ledgerPort, token));
  const otherPortCli = `The Context Ledger access token is for the ledger on port ${ledgerPort}, so it was not sent. Set PORT to ${ledgerPort}, or use the CONTEXT_LEDGER_DB of the ledger on this port.\n`;
  const run = await cli(['search', 'vela'], { PORT: String(port), CONTEXT_LEDGER_DB: place.database });
  assert.deepEqual({ code: run.code, stdout: run.stdout, stderr: run.stderr }, { code: 1, stdout: '', stderr: otherPortCli });
  const client = place.mcp(port, { CONTEXT_LEDGER_DB: place.database });
  await client.request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  const result = await client.call(2, 'session_search', { query: 'vela' });
  assert.deepEqual(result.content, [{ type: 'text', text: `The Context Ledger access token is for the ledger on port ${ledgerPort}, so it was not sent. Set PORT to ${ledgerPort} for this MCP server, or give it the CONTEXT_LEDGER_DB of the ledger on this port.` }]);
  assert.deepEqual(seen.map(entry => entry.authorization), [undefined, undefined]);
});

test('scripts that take a ledger URL get the token only for loopback http on the named port', async t => {
  const place = await temporary(t);
  await writeTokenText(tokenFileFor(place.database, 4999), tokenRecord(4999, 'W'.repeat(43)));
  const env = { CONTEXT_LEDGER_DB: place.database };
  assert.equal(await tokenForUrl('http://127.0.0.1:4999', env), 'W'.repeat(43));
  assert.equal(await tokenForUrl('http://127.0.0.1:4999/api', env), 'W'.repeat(43));
  // localhost may resolve to ::1, where another program can listen on the same port.
  for (const url of ['http://localhost:4999', 'http://127.0.0.1:5000','https://127.0.0.1:4999', 'http://example.com:4999', 'http://127.0.0.2:4999',
    'http://[::1]:4999', 'http://127.0.0.1.example.com:4999', 'not a url']) {
    assert.equal(await tokenForUrl(url, env), undefined, url);
  }
});

test('a token file that is a folder, a FIFO or too large is not read', async t => {
  const place = await temporary(t);
  const folder = join(place.directory, 'folder.sqlite');
  await mkdir(anyPortFile(folder));
  assert.equal(await readTokenFile(anyPortFile(folder)), undefined);
  const large = join(place.directory, 'large.sqlite');
  await writeTokenText(anyPortFile(large), tokenRecord(4317, 'L'.repeat(43)).padEnd(300, ' '));
  assert.equal(await readTokenFile(anyPortFile(large)), undefined);
  if (process.platform !== 'win32') {
    const fifo = join(place.directory, 'fifo.sqlite');
    await execute('mkfifo', [anyPortFile(fifo)]);
    // Opened without blocking and refused as not a regular file.
    assert.equal(await readTokenFile(anyPortFile(fifo)), undefined);
  }
});

test('a second server on the same port fails to start and leaves the first one\'s token in place', async t => {
  const place = await temporary(t);
  const first = await place.start();
  const child = spawn(process.execPath, ['src/server.mjs'], { env: { ...process.env, PORT: String(first.port), CONTEXT_LEDGER_DB: place.database }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.resume();
  let errors = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { errors += chunk; });
  const [code] = await once(child, 'exit');
  assert.notEqual(code, 0);
  assert.match(errors, /EADDRINUSE/u, 'the second start got as far as listening');
  assert.deepEqual(await readTokenFile(tokenFileFor(place.database, first.port)), { port: first.port, token: first.token });
  const searched = await cli(['search', 'vela'], { PORT: String(first.port), CONTEXT_LEDGER_DB: place.database });
  assert.deepEqual({ code: searched.code, stdout: searched.stdout }, { code: 0, stdout: '[]\n' });
});

test('the latent file reader refuses the token file, by its name and through a link', async t => {
  const place = await temporary(t);
  const server = await place.start(undefined, { env: { LATENT_ROOT: place.directory } });
  const read = paths => raw(server.port, { method: 'POST', path: '/api/latent/files', body: JSON.stringify({ paths }),
    headers: { ...bearer(server.token), 'Content-Type': 'application/json', Origin: server.origin } });
  const secretRefusal = { status: 400, body: { error: 'Paths must not name secret files (.env, .git, keys).' } };
  const direct = await read([`ledger.sqlite.${server.port}.token`]);
  assert.deepEqual({ status: direct.status, body: direct.body }, secretRefusal);
  try {
    await symlink(tokenFileFor(place.database, server.port), join(place.directory, 'notes.txt'));
  } catch {
    t.diagnostic('Symbolic links are not available here; the alias case is not run.');
    return;
  }
  const alias = await read(['notes.txt']);
  assert.deepEqual({ status: alias.status, body: alias.body }, secretRefusal);
  assert.equal(JSON.stringify(alias.body).includes(server.token), false);
});

test('the MCP adapter reads the token on each call and reports a missing or refused token in fixed words', async t => {
  const place = await temporary(t);
  const server = await place.start();
  const client = place.mcp(server.port, { CONTEXT_LEDGER_DB: place.database });
  await client.request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  const ok = await client.call(2, 'session_search', { query: 'vela' });
  assert.equal(ok.isError, undefined, JSON.stringify(ok));

  // The same adapter process outlives a ledger restart on the same port: its next call
  // reads the new token (caching the first token would fail here).
  await server.stop();
  const restarted = await place.start(undefined, { port: server.port });
  assert.notEqual(restarted.token, server.token);
  const again = await client.call(3, 'session_search', { query: 'vela' });
  assert.equal(again.isError, undefined, JSON.stringify(again));

  const stale = join(place.directory, 'stale.sqlite');
  await writeTokenText(tokenFileFor(stale, restarted.port), tokenRecord(restarted.port, 'A'.repeat(43)));
  for (const [env, message] of [[{ CONTEXT_LEDGER_DB: stale }, refused], [{ CONTEXT_LEDGER_DB: join(place.directory, 'none.sqlite') }, mcpNoToken], [{}, mcpNoToken]]) {
    const other = place.mcp(restarted.port, env);
    await other.request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    const result = await other.call(2, 'session_search', { query: 'vela' });
    assert.equal(result.isError, true);
    assert.deepEqual(result.content, [{ type: 'text', text: message }]);
    assert.equal(result.content[0].text.includes(place.directory), false);
    assert.equal(result.content[0].text.includes(restarted.token), false);
  }
});

test('the CLI prints only a sign-in link of the expected shape, so nothing else from the server reaches the terminal', async t => {
  const place = await temporary(t);
  const seen = [];
  let answer;
  const fake = createServer((request, response) => {
    seen.push({ method: request.method, url: request.url, authorization: request.headers.authorization });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(answer));
  });
  await new Promise(resolve => fake.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => fake.close(resolve)));
  await writeTokenText(tokenFileFor(place.database, fake.address().port), tokenRecord(fake.address().port, 'F'.repeat(43)));
  const env ={ PORT: String(fake.address().port), CONTEXT_LEDGER_DB: place.database };
  for (const path of ['/login?code=' + 'a'.repeat(43) + String.fromCodePoint(0x1b) + '[2J', 'https://evil.example/login?code=' + 'a'.repeat(43), '/login?code=short', 42, undefined]) {
    answer = { path };
    const run = await cli(['login'], env);
    assert.deepEqual({ code: run.code, stdout: run.stdout, stderr: run.stderr }, { code: 1, stdout: '', stderr: 'Context Ledger returned HTTP 200.\n' });
  }
  assert.deepEqual(seen[0], { method: 'POST', url: '/api/login', authorization: `Bearer ${'F'.repeat(43)}` });
});

test('on POSIX a token file that is a link or readable by others is not read', { skip: process.platform === 'win32' && 'Windows has no POSIX modes, and links need extra rights.' }, async t => {
  const place = await temporary(t);
  const real = join(place.directory, 'real.sqlite');
  await writeTokenText(anyPortFile(real), tokenRecord(4317, 'R'.repeat(43)));
  assert.deepEqual(await readTokenFile(anyPortFile(real)), { port: 4317, token: 'R'.repeat(43) });
  const linked = join(place.directory, 'linked.sqlite');
  await symlink(anyPortFile(real), anyPortFile(linked));
  assert.equal(await readTokenFile(anyPortFile(linked)), undefined);
  const open = join(place.directory, 'open.sqlite');
  await writeFile(anyPortFile(open), tokenRecord(4317, 'O'.repeat(43)));
  await chmod(anyPortFile(open), 0o644);
  assert.equal(await readTokenFile(anyPortFile(open)), undefined);
});

test('the latent reader refuses the token file under another name (a hard link)', async t => {
  const place = await temporary(t);
  const server = await place.start(undefined, { env: { LATENT_ROOT: place.directory } });
  await link(tokenFileFor(place.database, server.port), join(place.directory, 'notes.md'));
  const response = await raw(server.port, { method: 'POST', path: '/api/latent/files', body: JSON.stringify({ paths: ['notes.md'] }),
    headers: { ...bearer(server.token), 'Content-Type': 'application/json', Origin: server.origin } });
  assert.deepEqual({ status: response.status, body: response.body }, { status: 400, body: { error: 'Paths must not name secret files (.env, .git, keys).' } });
  // Other files in the same root are still read.
  await writeFile(join(place.directory, 'plan.md'), 'Ship the synthetic Vela build.\n');
  const plan = await raw(server.port, { method: 'POST', path: '/api/latent/files', body: JSON.stringify({ paths: ['plan.md'] }),
    headers: { ...bearer(server.token), 'Content-Type': 'application/json', Origin: server.origin } });
  assert.equal(plan.status, 200, JSON.stringify(plan.body));
});

test('a clean stop removes the token file, but not one a later start wrote', { skip: process.platform === 'win32' && 'Windows has no SIGTERM handler for a child process.' }, async t => {
  const place = await temporary(t);
  const server = await place.start();
  await server.stop();
  await assert.rejects(stat(tokenFileFor(place.database, server.port)), { code: 'ENOENT' });
  // A file that holds another server's token is left alone.
  const second = await place.start();
  const other = join(place.directory, 'other.sqlite');
  const third = await place.start(other);
  await writeTokenText(tokenFileFor(place.database, second.port), tokenRecord(third.port, third.token));
  await second.stop();
  assert.deepEqual(await readTokenFile(tokenFileFor(place.database, second.port)), { port: third.port, token: third.token });

  // A FIFO put in place of the file cannot hang the stop.
  const fourth = await place.start(join(place.directory, 'fourth.sqlite'));
  await rm(tokenFileFor(join(place.directory, 'fourth.sqlite'), fourth.port));
  await execute('mkfifo', [tokenFileFor(join(place.directory, 'fourth.sqlite'), fourth.port)]);
  const started = Date.now();
  await fourth.stop();
  assert.ok(Date.now() - started < 5000);
  assert.equal((await stat(tokenFileFor(join(place.directory, 'fourth.sqlite'), fourth.port))).isFIFO(), true);
});

test('a graph publish and the demo script send nothing where the token does not go', async t => {
  const place = await temporary(t);
  const { seen, port } = await fakeLedger(t);
  const packet = join(place.directory, 'packet.json');
  await writeFile(packet, JSON.stringify({ version: 2, sessionId: 'b'.repeat(64), party: 'leo', nodes: [], edges: [] }));
  const missing = await cli(['graph', 'publish', packet], { PORT: String(port), CONTEXT_LEDGER_DB: place.database });
  assert.deepEqual({ code: missing.code, stdout: missing.stdout, stderr: missing.stderr }, { code: 1, stdout: '', stderr: cliNoToken + '\n' });
  const otherPortNumber = port === 65535 ? port - 1 : port + 1;
  await writeTokenText(tokenFileFor(place.database, port), tokenRecord(otherPortNumber, 'P'.repeat(43)));
  const wrongPort = await cli(['graph', 'publish', packet], { PORT: String(port), CONTEXT_LEDGER_DB: place.database });
  assert.match(wrongPort.stderr, new RegExp(`^The Context Ledger access token is for the ledger on port ${otherPortNumber}, so it was not sent\.`, 'u'));
  const demo = await execute(process.execPath, ['demo/publish-reference.mjs'], { env: { ...process.env, PORT: String(port), CONTEXT_LEDGER_DB: place.database } })
    .then(() => ({ code: 0 }), error => ({ code: error.code, stderr: error.stderr }));
  assert.deepEqual(demo, { code: 1, stderr: `The ledger's access token is for port ${otherPortNumber}: run this with PORT=${otherPortNumber}.\n` });
  assert.deepEqual(seen, []);
});

test('two servers on different ports and one database each keep their own token file, and both keep working', async t => {
  const place = await temporary(t);
  const first = await place.start();
  const second = await place.start();
  assert.notEqual(first.port, second.port);
  assert.notEqual(first.token, second.token);
  // The second start did not touch the first one's file.
  assert.deepEqual(await readTokenFile(tokenFileFor(place.database, first.port)), { port: first.port, token: first.token });
  assert.deepEqual(await readTokenFile(tokenFileFor(place.database, second.port)), { port: second.port, token: second.token });
  for (const server of [first, second]) {
    const searched = await cli(['search', 'vela'], { PORT: String(server.port), CONTEXT_LEDGER_DB: place.database });
    assert.deepEqual({ code: searched.code, stdout: searched.stdout, stderr: searched.stderr }, { code: 0, stdout: '[]\n', stderr: '' });
    const client = place.mcp(server.port, { CONTEXT_LEDGER_DB: place.database });
    await client.request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    const result = await client.call(2, 'session_search', { query: 'vela' });
    assert.equal(result.isError, undefined, JSON.stringify(result));
  }
  // Each token opens only its own server.
  assert.equal((await raw(first.port, { path: '/api/sessions', headers: bearer(second.token) })).status, 401);
  assert.equal((await raw(second.port, { path: '/api/sessions', headers: bearer(first.token) })).status, 401);
});

test('the Windows check accepts only the current user as owner and as the only allowed account', () => {
  const sid = 'S-1-5-21-1000-2000-3000-1001';
  const group = 'G:S-1-5-21-1000-2000-3000-513';
  assert.equal(privateToOwner(`O:${sid}${group}D:P(A;;FA;;;${sid})`, sid), true);
  assert.equal(privateToOwner(`O:${sid}D:PAI(A;;FA;;;${sid})\r\n`, sid), true, 'no group, trailing line break');
  assert.equal(privateToOwner(`O:${sid}${group}D:P(D;;FA;;;WD)(A;;FA;;;${sid})`, sid), true, 'a deny entry for others is harmless');
  for (const sddl of [
    `O:S-1-5-21-1000-2000-3000-1002${group}D:P(A;;FA;;;${sid})`, // another owner may always change the DACL
    `O:BA${group}D:P(A;;FA;;;${sid})`, // owned by Administrators
    `O:${sid}${group}D:AI(A;ID;FA;;;${sid})(A;ID;FA;;;SY)`, // inherited SYSTEM
    `O:${sid}${group}D:AI(A;ID;0x1301bf;;;S-1-5-21-1000-2000-3000-1002)(A;ID;FA;;;${sid})`, // another local user
    `O:${sid}${group}D:P(A;;FR;;;WD)(A;;FA;;;${sid})`, // Everyone
    `O:${sid}${group}D:P(A;;FA;;;${sid}-5)`, // a longer SID with the same prefix
    `O:${sid}${group}D:NO_ACCESS_CONTROL`, // a NULL DACL allows anyone
    `O:${sid}${group}D:P(XA;;FA;;;${sid};(WIN://X))`, // a conditional entry
    `O:${sid}${group}D:P(OA;;FA;;;${sid})`, // an object entry
    `D:P(A;;FA;;;${sid})`, // no owner
    '',
  ]) {
    assert.equal(privateToOwner(sddl, sid), false, sddl);
  }
  assert.equal(privateToOwner(undefined, sid), false);
  assert.equal(privateToOwner(`O:${sid}D:P(A;;FA;;;${sid})`, 'not a sid'), false);
});

test('on Windows the token file is private to the current user from its creation, even in a folder that grants everyone full control', { skip: process.platform !== 'win32' && 'POSIX uses the file mode (tested above).' }, async t => {
  const place = await temporary(t);
  // Every file created the usual way in this folder inherits full control for Everyone,
  // which includes WRITE_DAC: a token file made that way and fixed later is not private.
  const open = join(place.directory, 'open');
  await mkdir(open);
  await execute(join(system32, 'icacls.exe'), [open, '/grant', '*S-1-1-0:(OI)(CI)F']);
  const control = join(open, 'control.txt');
  await writeFile(control, 'synthetic\n');
  assert.match((await windowsSecurity(control)).sddl, /\(A;ID;FA;;;WD\)/u, 'the folder hands out Everyone:F');

  const database = join(open, 'ledger.sqlite');
  const server = await place.start(database);
  const { sid, sddl } = await windowsSecurity(tokenFileFor(database, server.port));
  // Owner and only entry are this user; nothing is inherited from the folder. The DACL
  // is "P" alone: a file whose ACL was replaced after creation (icacls, SetNamedSecurityInfo)
  // shows "PAI" instead, so this also pins that the descriptor was set at creation.
  assert.match(sddl, new RegExp(`^O:${sid}(?:G:[A-Z0-9-]+)?D:P\\(A;;FA;;;${sid}\\)$`, 'u'));
  assert.equal((await cli(['search', 'vela'], { PORT: String(server.port), CONTEXT_LEDGER_DB: database })).stdout, '[]\n');
});

test('on Windows a token file others can read is refused in fixed words, and nothing is sent', { skip: process.platform !== 'win32' && 'POSIX uses the file mode (tested above).' }, async t => {
  const place = await temporary(t);
  const { seen, port } = await fakeLedger(t);
  const file = tokenFileFor(place.database, port);
  await writeTokenText(file, tokenRecord(port, 'E'.repeat(43)));
  assert.deepEqual(await readTokenFile(file), { port, token: 'E'.repeat(43) });
  // Once another account (Everyone) may read it, every client refuses it.
  await execute(join(system32, 'icacls.exe'), [file, '/grant', '*S-1-1-0:R']);
  assert.deepEqual(await readTokenFile(file), { exposed: true });
  const env = { PORT: String(port), CONTEXT_LEDGER_DB: place.database };
  const run = await cli(['search', 'vela'], env);
  assert.deepEqual({ code: run.code, stdout: run.stdout, stderr: run.stderr }, { code: 1, stdout: '', stderr: exposedToken + '\n' });
  const packet = join(place.directory, 'packet.json');
  await writeFile(packet, JSON.stringify({ version: 2, sessionId: 'b'.repeat(64), party: 'leo', nodes: [], edges: [] }));
  assert.equal((await cli(['graph', 'publish', packet], env)).stderr, exposedToken + '\n');
  const client = place.mcp(port, { CONTEXT_LEDGER_DB: place.database });
  await client.request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  const result = await client.call(2, 'session_search', { query: 'vela' });
  assert.deepEqual({ isError: result.isError, content: result.content }, { isError: true, content: [{ type: 'text', text: exposedToken }] });
  const demo = await execute(process.execPath, ['demo/publish-reference.mjs'], { env: { ...process.env, ...env } })
    .then(() => ({ code: 0 }), error => ({ code: error.code, stderr: error.stderr }));
  assert.deepEqual(demo, { code: 1, stderr: 'The ledger\'s access token file can be read by other users, so it was not used: restart the ledger to write a private one.\n' });
  for (const text of [run.stderr, result.content[0].text, demo.stderr]) {
    assert.equal(text.includes('E'.repeat(43)), false);
    assert.equal(text.includes(place.directory), false);
  }
  // No client sent anything, with or without the token.
  assert.deepEqual(seen, []);

  // A file with its folder's inherited ACL is refused too when that ACL names anyone
  // else (here the temporary folder's SYSTEM and Administrators entries, at least).
  const plain = anyPortFile(join(place.directory, 'plain.sqlite'));
  await writeFile(plain, tokenRecord(4317, 'N'.repeat(43)));
  const security = await windowsSecurity(plain);
  if (!privateToOwner(security.sddl, security.sid)) assert.deepEqual(await readTokenFile(plain), { exposed: true });
  restrictToOwner(plain);
  assert.deepEqual(await readTokenFile(plain), { port: 4317, token: 'N'.repeat(43) });
});

test('on Windows a reader takes type and size from its own handle', { skip: process.platform !== 'win32' && 'POSIX checks the open descriptor (tested above).' }, async t => {
  const place = await temporary(t);
  const folder = anyPortFile(join(place.directory, 'folder.sqlite'));
  await mkdir(folder);
  assert.equal(await readTokenFile(folder), undefined);
  // Private, a valid record at the start, but longer than a token file may be.
  const long = anyPortFile(join(place.directory, 'long.sqlite'));
  await writeTokenText(long, tokenRecord(4317, 'L'.repeat(43)).padEnd(300, ' '));
  assert.equal(await readTokenFile(long), undefined);
  const exact = anyPortFile(join(place.directory, 'exact.sqlite'));
  await writeTokenText(exact, tokenRecord(4317, 'K'.repeat(43)).padEnd(256, ' '));
  assert.deepEqual(await readTokenFile(exact), { port: 4317, token: 'K'.repeat(43) });
});

test('cleanup empties a token file only through its own descriptor and only when it holds this record, and says when it cannot', async t => {
  const place = await temporary(t);
  const line = JSON.stringify({ port: 4317, token: 'C'.repeat(43) });
  const own = anyPortFile(join(place.directory, 'own.sqlite'));
  await writeTokenText(own, line + '\n');
  assert.equal(emptyIfOwnRecord(own, line), 'emptied');
  // Emptied in place, not removed by path: the entry is still there, with no token in it.
  assert.equal((await stat(own)).size, 0);
  // A file that replaced it (other content) is left exactly as it is.
  const replaced = anyPortFile(join(place.directory, 'replaced.sqlite'));
  await writeTokenText(replaced, tokenRecord(4317, 'D'.repeat(43)));
  assert.equal(emptyIfOwnRecord(replaced, line), 'not ours');
  assert.equal(await readFile(replaced, 'utf8'), tokenRecord(4317, 'D'.repeat(43)));
  // A missing file is not an error.
  assert.equal(emptyIfOwnRecord(anyPortFile(join(place.directory, 'none.sqlite')), line), 'not ours');
  // Its own record in a file it cannot open for writing (read-only here; on Windows a
  // reader that denies write sharing has the same effect): reported, not hidden.
  const stuck = anyPortFile(join(place.directory, 'stuck.sqlite'));
  await writeTokenText(stuck, line + '\n');
  await chmod(stuck, 0o400);
  t.after(() => chmod(stuck, 0o600).catch(() => {}));
  assert.equal(emptyIfOwnRecord(stuck, line), 'failed');
  assert.equal(await readFile(stuck, 'utf8'), line + '\n');
});

test('a reader opens the token file from Node only on POSIX; on Windows the one open is PowerShell\'s', async t => {
  const place = await temporary(t);
  const file = anyPortFile(place.database);
  await writeTokenText(file, tokenRecord(4317, 'U'.repeat(43)));
  // Count the opens src/token.mjs makes through node:fs/promises (its named import is
  // kept in step with the builtin by syncBuiltinESMExports).
  const promisesModule = createRequire(import.meta.url)('node:fs/promises');
  const original = promisesModule.open;
  let opens = 0;
  promisesModule.open = (path, ...rest) => {
    if (String(path) === file) opens += 1;
    return original(path, ...rest);
  };
  syncBuiltinESMExports();
  try {
    assert.deepEqual(await readTokenFile(file), { port: 4317, token: 'U'.repeat(43) });
  } finally {
    promisesModule.open = original;
    syncBuiltinESMExports();
  }
  assert.equal(opens, process.platform === 'win32' ? 0 : 1);
});

test('on Windows a token file can be removed while a client is reading it', { skip: process.platform !== 'win32' && 'Share modes are a Windows feature.' }, async t => {
  const place = await temporary(t);
  const file = anyPortFile(place.database);
  const marker = join(place.directory, 'reader-open.marker');
  await writeTokenText(file, tokenRecord(4317, 'H'.repeat(43)));
  // The test hook makes the reader create the marker once it has read, with its handle
  // still open, and wait until the marker is gone.
  const previous = process.env.CONTEXT_LEDGER_TEST_READ_MARKER;
  process.env.CONTEXT_LEDGER_TEST_READ_MARKER = marker;
  let reading;
  try {
    reading = readTokenFile(file);
  } finally {
    if (previous === undefined) delete process.env.CONTEXT_LEDGER_TEST_READ_MARKER;
    else process.env.CONTEXT_LEDGER_TEST_READ_MARKER = previous;
  }
  const started = Date.now();
  for (;;) {
    try {
      await stat(marker);
      break;
    } catch {
      assert.ok(Date.now() - started < 30_000, 'the reader opened the file');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  // A clean stop removes the file this way; a reader without delete sharing makes it EBUSY.
  await rm(file);
  await rm(marker);
  assert.deepEqual(await reading, { port: 4317, token: 'H'.repeat(43) });
  await assert.rejects(stat(file), { code: 'ENOENT' });
});
