import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { bearer, ledgerToken } from './ledger-auth.mjs';

// H5: a probe set that pins what src/server.mjs answers for every route, wrong
// methods, unknown paths, static files, foreign Host and Origin, the decisions
// route's same-origin rule, bad IDs, the body limit and the error mapping. It was
// run on the server before the request table replaced the if-chain. Synthetic data.
// Set ROUTES_PROBE_OUT to a file path to also write every probe's full response.
// P1e: the probes send the server's access token (read from the file next to its
// database); a block at the end pins the 401 that every guarded probe gets without it.
const fixtureRoot = fileURLToPath(new URL('../evals/latent/fixture', import.meta.url));
const securityHeaders = {
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};
const jsonType = 'application/json; charset=utf-8';
const notFound = { error: 'Not found.' };
const hex = character => character.repeat(64);

async function startServer(env) {
  const childEnv = { ...process.env, PORT: '0', ...env };
  for (const [name, value] of Object.entries(childEnv)) if (value === undefined) delete childEnv[name];
  const child = spawn(process.execPath, ['src/server.mjs'], { env: childEnv, stdio: ['ignore', 'pipe', 'inherit'] });
  let output = '';
  for await (const chunk of child.stdout) {
    output += chunk;
    const match = output.match(/listening at http:\/\/127\.0\.0\.1:(\d+)/);
    if (match) return { port: Number(match[1]), headers: bearer(await ledgerToken(env.CONTEXT_LEDGER_DB, Number(match[1]))), stop: async () => { child.kill(); await once(child, 'exit'); } };
  }
  throw new Error('Server exited before listening: ' + output);
}

/** One raw HTTP request, so Host, Origin, method and body are all under the test's control. */
function raw(port, { method = 'GET', path, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, method, path, headers: { Host: `127.0.0.1:${port}`, ...headers }, agent: false }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = text;
        if (response.headers['content-type'] === jsonType && text !== '') parsed = JSON.parse(text);
        resolve({ status: response.statusCode, headers: response.headers, body: parsed });
      });
    });
    request.on('error', reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

function fakeRuntime() {
  const seen = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    seen.push({ url: request.url, body });
    if (body.question === 'runtime-fails') return response.writeHead(500).end();
    response.writeHead(200, { 'Content-Type': 'application/json' });
    if (request.url === '/latent/read') {
      return response.end(JSON.stringify({
        graph: { version: 1, kind: 'latent-slice', question: body.question, answer: 'Retried 3 times.',
          findings: [{ id: 'a', label: 'RETRY_LIMIT is 3', evidence: [{ path: 'src/config.js', startLine: 21, endLine: 22 }] }] },
        receipt: { model: 'fake', calls: [{ role: 'worker', promptTokens: 100, cachedTokens: 90 }] },
        stats: { prefixTokens: 1000, sliceTokensEstimate: 60, cachedShare: 0.9 },
      }));
    }
    if (request.url === '/latent/transfer') {
      return response.end(JSON.stringify({ mode: 'transfer', answer: 'only when verified', answerVerified: false,
        receipt: { sender: body.sender, receiver: body.receiver, mapperId: 'm1', senderTokens: 9, receiverTokens: 9, senderMs: 1, mapperMs: 1, totalMs: 2 } }));
    }
    response.end(JSON.stringify({ mode: 'latent-team', answer: 'The answer is 9.', answerVerified: false,
      receipt: { model: 'fake', latentVectors: 4, generatedTokens: 5 } }));
  });
  return { seen, server };
}

async function setup(t, env = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-routes-'));
  const state = {};
  t.after(async () => {
    try {
      await state.server?.stop();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  state.server = await startServer({ CONTEXT_LEDGER_DB: join(directory, 'ledger.sqlite'), LATENT_ROOT: fixtureRoot, ...env });
  const { port } = state.server;
  const origin = `http://127.0.0.1:${port}`;
  state.port = port;
  state.origin = origin;
  const auth = state.server.headers;
  state.raw = request => raw(port, { ...request, headers: { ...auth, ...request.headers } });
  state.get = (path, headers) => state.raw({ path, headers });
  state.post = (path, data, headers = {}) => state.raw({
    method: 'POST', path, body: typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data),
    headers: { 'Content-Type': 'application/json', Origin: origin, ...headers },
  });
  return state;
}

const v2 = (session, party, label, extra = {}) => ({ version: 2, sessionId: session.id, party,
  nodes: [{ id: 'goal', kind: 'goal', label, evidenceLines: [1] }], edges: [], ...extra });

function checkSecurityHeaders(response, label) {
  for (const [name, value] of Object.entries(securityHeaders)) assert.equal(response.headers[name], value, `${label}: ${name}`);
}

test('the server request table answers every probe as before', async t => {
  const runtime = fakeRuntime();
  await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => runtime.server.close(resolve)));
  const state = await setup(t, { LATENT_URL: `http://127.0.0.1:${runtime.server.address().port}` });
  const { port, origin } = state;
  const record = [];
  const expect = async (label, promise, status, body) => {
    const response = await promise;
    record.push({ label, status: response.status, headers: response.headers, body: response.body });
    checkSecurityHeaders(response, label);
    assert.equal(response.status, status, `${label}: ${JSON.stringify(response.body)}`);
    if (body !== undefined) assert.deepEqual(response.body, body, label);
    return response;
  };

  // Static files: GET only, exact paths only.
  for (const [path, type, start] of [['/', 'text/html', '<!doctype html>'], ['/app.js', 'text/javascript', ''], ['/styles.css', 'text/css', ''], ['/pixel.css', 'text/css', '']]) {
    const response = await expect(`GET ${path}`, state.get(path), 200);
    assert.equal(response.headers['content-type'], `${type}; charset=utf-8`);
    assert.ok(response.body.toLowerCase().startsWith(start), path);
    await expect(`POST ${path}`, state.post(path, {}), 404, notFound);
    await expect(`HEAD ${path}`, state.raw({ method: 'HEAD', path }), 404, '');
  }
  await expect('GET /?q=1 is still the page', state.get('/?q=1'), 200);
  for (const path of ['/index.html', '/public/app.js', '/nope', '/api', '/api/', '/api/sessions/', '/api/%73essions', '/API/sessions', '/api/graphs/', '/api/rooms/']) {
    await expect(`GET ${path}`, state.get(path), 404, notFound);
  }

  // Host and URL checks come before any route, including static files and writes.
  for (const host of ['evil.example', `evil.example:${port}`, `127.0.0.1:${port + 1}`, `localhost.evil:${port}`, `[::1]:${port}`]) {
    await expect(`Host ${host} GET /`, state.get('/', { Host: host }), 403, { error: 'Unrecognized local host.' });
    await expect(`Host ${host} POST /api/import`, state.raw({ method: 'POST', path: '/api/import', body: '{}',
      headers: { Host: host, 'Content-Type': 'application/json', Origin: `http://${host}` } }), 403, { error: 'Unrecognized local host.' });
  }
  await expect('Host localhost GET /api/rooms', state.get('/api/rooms', { Host: `localhost:${port}` }), 200, { rooms: [], next: null });
  await expect('URL //x', state.get('//x'), 400, { error: 'Invalid request URL.' });
  await expect('URL *', state.raw({ method: 'OPTIONS', path: '*' }), 400, { error: 'Invalid request URL.' });
  await expect('Host before URL', state.get('//x', { Host: 'evil.example' }), 403, { error: 'Unrecognized local host.' });

  // Writes: same origin, JSON type, size limit and valid JSON, in that order, on every write.
  const writes = [
    ['/api/import', 'Import'],
    ['/api/graphs', 'Graph publication'],
    ['/api/latent/read', 'A latent read'],
    ['/api/latent/transfer', 'A latent transfer'],
    ['/api/latent/files', 'Reading latent files'],
    ['/api/latent/team', 'A latent team run'],
    ['/api/rooms', 'Opening a room'],
  ];
  for (const [path, operation] of writes) {
    await expect(`${path} foreign Origin`, state.post(path, {}, { Origin: 'https://foreign.example' }), 403, { error: `${operation} requires the same origin.` });
    await expect(`${path} Origin of the other local name`, state.post(path, {}, { Origin: `http://localhost:${port}` }), 403, { error: `${operation} requires the same origin.` });
    await expect(`${path} no Origin`, state.raw({ method: 'POST', path, body: '{}', headers: { 'Content-Type': 'application/json' } }), 403, { error: `${operation} requires the same origin.` });
    await expect(`${path} text/plain`, state.post(path, {}, { 'Content-Type': 'text/plain' }), 415, { error: `${operation} requires application/json.` });
    await expect(`${path} declared too large`, state.post(path, '', { 'Content-Length': String(8 * 1024 * 1024 + 1) }), 413, { error: `${operation} exceeds the 8 MiB request limit.` });
    await expect(`${path} bad JSON`, state.post(path, '{'), 400, { error: `${operation} request must contain valid UTF-8 JSON.` });
    await expect(`${path} bad UTF-8`, state.post(path, Buffer.from([0x22, 0xff, 0x22])), 400, { error: `${operation} request must contain valid UTF-8 JSON.` });
    await expect(`${path} charset parameter accepted`, state.post(path, '{', { 'Content-Type': 'Application/JSON; charset=utf-8' }), 400, { error: `${operation} request must contain valid UTF-8 JSON.` });
    for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
      if (method === 'GET' && (path === '/api/graphs' || path === '/api/rooms')) continue;
      await expect(`${method} ${path}`, state.raw({ method, path, headers: { Origin: origin } }), 404, notFound);
    }
  }
  // A body over the limit without a declared length is cut off while it streams.
  await expect('streamed too large', state.raw({ method: 'POST', path: '/api/import', body: Buffer.alloc(8 * 1024 * 1024 + 1, 0x20),
    headers: { 'Content-Type': 'application/json', Origin: origin, 'Transfer-Encoding': 'chunked' } }), 413, { error: 'Import exceeds the 8 MiB request limit.' });

  // Error mapping: InputError and GraphInputError are 400, other errors 500.
  await expect('import InputError', state.post('/api/import', { provider: 'nobody' }), 400);
  await expect('import of null', state.post('/api/import', 'null'), 400);
  await expect('publish GraphInputError', state.post('/api/graphs', { version: 2 }), 400);
  await expect('room InputError', state.post('/api/rooms', { graphIds: [] }), 400, { error: 'A room needs exactly two graph IDs.' });
  await expect('search too long', state.get('/api/sessions?q=' + 'x'.repeat(513)), 400, { error: 'Search is limited to 512 characters.' });
  await expect('unknown provider', state.get('/api/sessions?provider=nobody'), 400, { error: 'Unknown provider.' });
  await expect('bad limit', state.get('/api/graphs?limit=0'), 400, { error: 'limit must be an integer from 1 to 100.' });

  // Every route with its right method.
  const leoImport = await expect('POST /api/import', state.post('/api/import', { provider: 'claude', source: 'leo.jsonl',
    transcript: JSON.stringify({ type: 'user', message: { role: 'user', content: 'Leo plans the synthetic Lyra demo.' } }) }), 200);
  const leo = leoImport.body.session;
  const ali = (await expect('POST /api/import ali', state.post('/api/import?x=1', { provider: 'claude', source: 'ali.jsonl',
    transcript: JSON.stringify({ type: 'user', message: { role: 'user', content: 'Ali reviews the synthetic Lyra demo.' } }) }), 200)).body.session;
  assert.match(leo.id, /^[a-f0-9]{64}$/u);
  const leoGraph = (await expect('POST /api/graphs', state.post('/api/graphs', v2(leo, 'leo', 'Lyra goal')), 200)).body.graph;
  const aliGraph = (await expect('POST /api/graphs ali', state.post('/api/graphs', v2(ali, 'ali', 'Lyra review',
    { links: [{ from: 'goal', graph: leoGraph.id, to: 'goal', type: 'matches' }] })), 200)).body.graph;
  const room = (await expect('POST /api/rooms', state.post('/api/rooms', { graphIds: [leoGraph.id, aliGraph.id] }), 200)).body.room;
  assert.deepEqual(Object.keys(leoImport.body), ['session']);

  const all = await expect('GET /api/sessions', state.get('/api/sessions'), 200);
  assert.deepEqual(all.body.sessions.map(session => session.id).sort(), [leo.id, ali.id].sort());
  assert.equal('next' in all.body, false);
  const page = await expect('GET /api/sessions?limit=1', state.get('/api/sessions?q=lyra&limit=1'), 200);
  assert.equal(page.body.sessions.length, 1);
  assert.ok(page.body.next);
  const graphs = await expect('GET /api/graphs', state.get(`/api/graphs?party=leo`), 200);
  assert.deepEqual(graphs.body.graphs.map(graph => graph.id), [leoGraph.id]);
  const rooms = await expect('GET /api/rooms', state.get(`/api/rooms?graphId=${leoGraph.id}`), 200);
  assert.deepEqual(rooms.body.rooms.map(entry => entry.id), [room.id]);
  assert.deepEqual((await expect('GET session', state.get(`/api/sessions/${leo.id}`), 200)).body.session.id, leo.id);
  assert.deepEqual((await expect('GET graph', state.get(`/api/graphs/${leoGraph.id}`), 200)).body.graph.id, leoGraph.id);
  assert.deepEqual(Object.keys((await expect('GET context', state.get(`/api/graphs/${leoGraph.id}/context`), 200)).body), ['context']);
  assert.deepEqual((await expect('GET room', state.get(`/api/rooms/${room.id}`), 200)).body.room.id, room.id);

  // Unknown and malformed IDs: 404, and never a write.
  for (const [prefix, suffix] of [['/api/sessions/', ''], ['/api/graphs/', ''], ['/api/graphs/', '/context'], ['/api/rooms/', '']]) {
    await expect(`unknown ${prefix}${suffix}`, state.get(`${prefix}${hex('e')}${suffix}`), 404, notFound);
    await expect(`upper ${prefix}${suffix}`, state.get(`${prefix}${hex('A')}${suffix}`), 404, notFound);
    await expect(`short ${prefix}${suffix}`, state.get(`${prefix}${'a'.repeat(63)}${suffix}`), 404, notFound);
    await expect(`long ${prefix}${suffix}`, state.get(`${prefix}${'a'.repeat(65)}${suffix}`), 404, notFound);
    await expect(`trailing ${prefix}${suffix}`, state.get(`${prefix}${leo.id}${suffix}/`), 404, notFound);
    for (const method of ['POST', 'PUT', 'DELETE']) {
      // Node's client sends a DELETE body unframed unless a length is given, and
      // /api/sessions/:id now has a DELETE route, so the server would read those
      // bytes as a second, malformed request. Give the length (P1d).
      const length = method === 'DELETE' ? { 'Content-Length': '2' } : {};
      await expect(`${method} ${prefix}id${suffix}`, state.raw({ method, path: `${prefix}${leoGraph.id}${suffix}`, body: '{}',
        headers: { 'Content-Type': 'application/json', Origin: origin, ...length } }), 404, notFound);
    }
  }
  await expect('GET /api/graphs/<session id>', state.get(`/api/graphs/${leo.id}`), 404, notFound);

  // P1d: DELETE /api/sessions/:id. The loop above still gets 404 for DELETE on
  // /api/sessions/<graph id>, now from the handler (no such session) instead of from
  // having no route. Origin comes first, then the ID, then the citing graphs.
  const cara = (await expect('POST /api/import cara', state.post('/api/import', { provider: 'claude', source: 'cara.jsonl',
    transcript: JSON.stringify({ type: 'user', message: { role: 'user', content: 'Cara drafts the synthetic Vega notes.' } }) }), 200)).body.session;
  const remove = (id, headers = { Origin: origin }) => state.raw({ method: 'DELETE', path: `/api/sessions/${id}`, headers });
  const sameOrigin = { error: 'Deleting a session requires the same origin.' };
  await expect('DELETE session foreign Origin', remove(cara.id, { Origin: 'https://foreign.example' }), 403, sameOrigin);
  await expect('DELETE session Origin of the other local name', remove(cara.id, { Origin: `http://localhost:${port}` }), 403, sameOrigin);
  await expect('DELETE session no Origin', remove(cara.id, {}), 403, sameOrigin);
  await expect('DELETE unknown session needs the Origin', remove(hex('e'), {}), 403, sameOrigin);
  await expect('DELETE session foreign Host', state.raw({ method: 'DELETE', path: `/api/sessions/${cara.id}`,
    headers: { Host: 'evil.example', Origin: 'http://evil.example' } }), 403, { error: 'Unrecognized local host.' });
  for (const [label, id] of [['unknown', hex('e')], ['upper', hex('A')], ['short', 'a'.repeat(63)], ['long', 'a'.repeat(65)]]) {
    await expect(`DELETE ${label} session`, remove(id), 404, notFound);
  }
  await expect('DELETE session trailing slash', remove(`${cara.id}/`), 404, notFound);
  await expect('DELETE /api/sessions', state.raw({ method: 'DELETE', path: '/api/sessions', headers: { Origin: origin } }), 404, notFound);
  await expect('DELETE cited session', remove(leo.id), 409, { error: 'This session is cited by 1 graph, so it cannot be deleted.', graphs: 1 });
  await expect('cited session still there', state.get(`/api/sessions/${leo.id}`), 200);
  await expect('PATCH session', state.raw({ method: 'PATCH', path: `/api/sessions/${cara.id}`, headers: { Origin: origin } }), 404, notFound);
  await expect('DELETE session', remove(cara.id), 200, { deleted: cara.id });
  await expect('GET deleted session', state.get(`/api/sessions/${cara.id}`), 404, notFound);
  await expect('DELETE deleted session', remove(cara.id), 404, notFound);
  await expect('search after delete', state.get('/api/sessions?q=vega'), 200, { sessions: [] });

  // The decisions route: Sec-Fetch-Site first, then the write checks, then the room.
  const decisions = `/api/rooms/${room.id}/decisions`;
  const choice = { proposalId: room.proposals[0].id, party: 'leo', choice: 'confirm' };
  const browser = { 'Sec-Fetch-Site': 'same-origin' };
  const people = { error: 'Proposals are confirmed by people in the browser.' };
  await expect('decision without Sec-Fetch-Site', state.post(decisions, choice), 403, people);
  await expect('decision cross-site', state.post(decisions, choice, { 'Sec-Fetch-Site': 'cross-site' }), 403, people);
  await expect('decision same-site', state.post(decisions, choice, { 'Sec-Fetch-Site': 'same-site' }), 403, people);
  await expect('decision people before Origin', state.post(decisions, choice, { Origin: 'https://foreign.example' }), 403, people);
  await expect('decision foreign Origin', state.post(decisions, choice, { ...browser, Origin: 'https://foreign.example' }), 403, { error: 'A room decision requires the same origin.' });
  await expect('decision text/plain', state.post(decisions, choice, { ...browser, 'Content-Type': 'text/plain' }), 415, { error: 'A room decision requires application/json.' });
  await expect('decision declared too large', state.post(decisions, '', { ...browser, 'Content-Length': String(8 * 1024 * 1024 + 1) }), 413, { error: 'A room decision exceeds the 8 MiB request limit.' });
  await expect('decision bad JSON', state.post(decisions, '{', browser), 400, { error: 'A room decision request must contain valid UTF-8 JSON.' });
  await expect('decision unknown proposal', state.post(decisions, { ...choice, proposalId: 'x' }, browser), 400, { error: 'Unknown proposal in this room.' });
  await expect('decision unknown room', state.post(`/api/rooms/${hex('e')}/decisions`, choice, browser), 404, notFound);
  await expect('decision unknown room needs the browser', state.post(`/api/rooms/${hex('e')}/decisions`, choice), 403, people);
  await expect('decision upper-case room', state.post(`/api/rooms/${hex('A')}/decisions`, choice), 404, notFound);
  await expect('GET decisions', state.get(decisions), 404, notFound);
  await expect('PUT decisions', state.raw({ method: 'PUT', path: decisions, body: '{}', headers: { ...browser, Origin: origin } }), 404, notFound);
  const decided = await expect('POST decisions', state.post(decisions, choice, browser), 200);
  assert.equal(decided.body.room.id, room.id);
  assert.deepEqual(Object.keys(decided.body), ['room']);

  // The latent routes reach the runtime at LATENT_URL; refusals never do.
  const before = runtime.seen.length;
  await expect('latent read secret path', state.post('/api/latent/read', { paths: ['.env'], question: 'q' }), 400);
  await expect('latent files with a question', state.post('/api/latent/files', { paths: ['src/notify.js'], question: 'q' }), 400, { error: 'Latent files accepts only paths.' });
  assert.equal(runtime.seen.length, before);
  const read = await expect('POST /api/latent/read', state.post('/api/latent/read', { paths: ['src/config.js'], question: 'How are charges retried?' }), 200);
  assert.equal(read.body.graph.findings.length, 1);
  const transfer = await expect('POST /api/latent/transfer', state.post('/api/latent/transfer', { sender: 'Qwen/Qwen2.5-0.5B-Instruct',
    receiver: 'HuggingFaceTB/SmolLM2-360M-Instruct', paths: ['src/notify.js'], question: 'When is an SMS sent?' }), 200);
  assert.equal(transfer.body.mode, 'transfer');
  const team = await expect('POST /api/latent/team', state.post('/api/latent/team', { question: 'Janet has 16 eggs' }), 200);
  assert.deepEqual(team.body, { mode: 'latent-team', answer: 'The answer is 9.', answerVerified: false, receipt: team.body.receipt });
  const files = await expect('POST /api/latent/files', state.post('/api/latent/files', { paths: ['src/notify.js'] }), 200);
  assert.equal(files.body.mode, 'text');
  assert.deepEqual(runtime.seen.slice(before).map(entry => entry.url), ['/latent/read', '/latent/transfer', '/latent/team']);
  // LatentError keeps its own status.
  await expect('latent team LatentError', state.post('/api/latent/team', { question: 'runtime-fails' }), 502, { error: 'The latent runtime refused the request (HTTP 500).' });

  // P1e: without the token or a browser session, every route but the static files (the
  // sign-in page among them) and POST /api/session (P1f) is 401, whatever the method or
  // path, and never reaches a handler. The Host and URL checks still come first, and the
  // static files stay public.
  const signIn = { error: 'Sign in first: run npm run ledger -- login and open the link it prints.' };
  const anonymous = (method, path, headers = {}) => raw(port, { method, path, body: method === 'GET' ? undefined : '{}',
    headers: { 'Content-Type': 'application/json', Origin: origin, ...browser, ...headers } });
  const guarded = [
    ['POST', '/api/import'], ['POST', '/api/graphs'], ['GET', '/api/sessions'], ['GET', '/api/graphs'], ['GET', '/api/rooms'],
    ['GET', `/api/sessions/${leo.id}`], ['GET', `/api/graphs/${leoGraph.id}`], ['GET', `/api/graphs/${leoGraph.id}/context`],
    ['POST', '/api/latent/read'], ['POST', '/api/latent/transfer'], ['POST', '/api/latent/files'], ['POST', '/api/latent/team'],
    ['POST', '/api/rooms'], ['GET', `/api/rooms/${room.id}`], ['POST', decisions], ['POST', '/api/login'],
    ['GET', '/nope'], ['GET', '/api'], ['GET', '/API/sessions'], ['PUT', '/api/sessions'], ['DELETE', `/api/rooms/${room.id}`],
    ['GET', '/api/session'], ['PUT', '/api/session'],
  ];
  const seenBefore = runtime.seen.length;
  for (const [method, path] of guarded) {
    const response = await expect(`no token ${method} ${path}`, anonymous(method, path), 401, signIn);
    assert.equal(response.headers['www-authenticate'], 'Bearer realm="Context Ledger"', path);
    await expect(`wrong token ${method} ${path}`, anonymous(method, path, { Authorization: 'Bearer ' + 'A'.repeat(43) }), 401, signIn);
  }
  assert.equal(runtime.seen.length, seenBefore);
  await expect('no token, foreign Host', raw(port, { path: '/api/sessions', headers: { Host: 'evil.example' } }), 403, { error: 'Unrecognized local host.' });
  await expect('no token, bad URL', raw(port, { path: '//api/sessions' }), 400, { error: 'Invalid request URL.' });
  for (const path of ['/', '/app.js', '/styles.css', '/session.js', '/login', '/login.js', '/swarm/session.js']) await expect(`no token GET ${path}`, raw(port, { path }), 200);
  await expect('no token HEAD / is still 404', raw(port, { method: 'HEAD', path: '/' }), 404, '');

  if (process.env.ROUTES_PROBE_OUT) {
    // Dates and the ephemeral port vary between runs; everything else is compared as is.
    const stable = JSON.stringify(record, null, 1)
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/gu, '<time>')
      .replace(/"date": "[^"]*"/gu, '"date": "<date>"')
      .replaceAll(String(port + 1), '<port+1>')
      .replaceAll(String(port), '<port>');
    await writeFile(process.env.ROUTES_PROBE_OUT, stable);
  }
});

// The server in a child that can change its own environment, or make static reads
// fail, between requests on a line of JSON from the test. It answers each line with "ok".
const controlled = `
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { createInterface } from 'node:readline';
const require = createRequire(import.meta.url);
createInterface({ input: process.stdin }).on('line', line => {
  const { env = {}, failStaticReads } = JSON.parse(line);
  for (const [name, value] of Object.entries(env)) {
    if (value === null) delete process.env[name];
    else process.env[name] = value;
  }
  if (failStaticReads) {
    require('node:fs/promises').readFile = async () => { throw new Error('Synthetic disk failure.'); };
    syncBuiltinESMExports();
  }
  process.stdout.write('ok\\n');
});
await import(${JSON.stringify(new URL('../src/server.mjs', import.meta.url).href)});
`;

test('LATENT_URL and LATENT_ROOT are read on each request, and unexpected errors are a plain 500', async t => {
  const first = fakeRuntime();
  const second = fakeRuntime();
  for (const runtime of [first, second]) {
    await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => runtime.server.close(resolve)));
  }
  const directory = await mkdtemp(join(tmpdir(), 'ledger-routes-env-'));
  const child = spawn(process.execPath, ['--input-type=module', '-e', controlled], {
    env: { ...process.env, PORT: '0', CONTEXT_LEDGER_DB: join(directory, 'ledger.sqlite'), LATENT_ROOT: fixtureRoot,
      LATENT_URL: `http://127.0.0.1:${first.server.address().port}` },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  // P5a review: one promise for the child's end, so a child already gone (by a code or
  // a signal) or one that failed to spawn never leaves the teardown waiting.
  const ended = once(child, 'exit').catch(() => {});
  let running = true;
  ended.then(() => { running = false; });
  t.after(async () => {
    try {
      if (running) {
        child.kill();
        await ended;
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  const lines = [];
  const waiting = [];
  let buffered = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffered += chunk;
    let end;
    while ((end = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, end).trim();
      buffered = buffered.slice(end + 1);
      if (waiting.length) waiting.shift().resolve(line);
      else lines.push(line);
    }
  });
  // P5a: a child that exits (a server that cannot start) fails every wait instead of
  // leaving it pending, which with the fake runtimes still listening hung the whole file.
  let exited;
  const fail = error => {
    exited = error;
    while (waiting.length) waiting.shift().reject(exited);
  };
  child.once('exit', (code, signal) => fail(new Error(`The server child exited (${signal ?? code}).`)));
  child.once('error', error => fail(new Error(`The server child failed: ${error.message}`)));
  const nextLine = () => {
    if (lines.length) return Promise.resolve(lines.shift());
    if (exited) return Promise.reject(exited);
    return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
  };
  const listening = (await nextLine()).match(/listening at http:\/\/127\.0\.0\.1:(\d+)/u);
  assert.ok(listening, 'the server prints where it listens');
  const port = Number(listening[1]);
  assert.match(await nextLine(), /^Sign in to the browser app/u);
  const auth = bearer(await ledgerToken(join(directory, 'ledger.sqlite'), port));
  const send = async message => {
    child.stdin.write(JSON.stringify(message) + '\n');
    assert.equal(await nextLine(), 'ok');
  };
  const origin = `http://127.0.0.1:${port}`;
  const post = (path, data) => raw(port, { method: 'POST', path, body: JSON.stringify(data), headers: { 'Content-Type': 'application/json', Origin: origin, ...auth } });

  assert.equal((await post('/api/latent/team', { question: 'one' })).status, 200);
  await send({ env: { LATENT_URL: `http://127.0.0.1:${second.server.address().port}` } });
  assert.equal((await post('/api/latent/team', { question: 'two' })).status, 200);
  assert.deepEqual(first.seen.map(entry => entry.body.question), ['one']);
  assert.deepEqual(second.seen.map(entry => entry.body.question), ['two']);

  assert.equal((await post('/api/latent/files', { paths: ['src/notify.js'] })).status, 200);
  await send({ env: { LATENT_ROOT: null } });
  const unset = await post('/api/latent/files', { paths: ['src/notify.js'] });
  assert.deepEqual({ status: unset.status, body: unset.body }, { status: 503, body: { error: 'Latent reading is not configured: set LATENT_ROOT.' } });

  assert.equal((await raw(port, { path: '/' })).status, 200);
  await send({ failStaticReads: true });
  const failed = await raw(port, { path: '/' });
  checkSecurityHeaders(failed, 'failed static read');
  assert.deepEqual({ status: failed.status, body: failed.body }, { status: 500, body: { error: 'Local request failed.' } });
});

test('the default runtime address is used when LATENT_URL is not set', async t => {
  const runtime = fakeRuntime();
  try {
    await new Promise((resolve, reject) => {
      runtime.server.once('error', reject);
      runtime.server.listen(4320, '127.0.0.1', resolve);
    });
  } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
    t.skip('Port 4320 is in use, so the default address cannot be faked here.');
    return;
  }
  t.after(() => new Promise(resolve => runtime.server.close(resolve)));
  const state = await setup(t, { LATENT_URL: undefined });
  const team = await state.post('/api/latent/team', { question: 'Janet has 16 eggs' });
  assert.equal(team.status, 200, JSON.stringify(team.body));
  assert.equal(team.body.mode, 'latent-team');
  assert.deepEqual(runtime.seen.map(entry => entry.url), ['/latent/team']);
});
