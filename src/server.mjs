import { readFile } from 'node:fs/promises';
import { maxBundleGraphs } from './export.mjs';
import { terminalJson } from './text.mjs';
import { createServer } from 'node:http';
import { GraphInputError } from './graph.mjs';
import { LatentError, latentFiles, latentRead, latentTeam, latentTransfer } from './latent.mjs';
import { maxBudget, maxQuestionCharacters, minBudget, questionLength } from './scope.mjs';
import { ConflictError, InputError, isProjectSlug, isProvider, openStore, projectSlugRule } from './store.mjs';
import { codeLifetimeMs, createAuth, newToken, sessionLifetimeMs, removeTokenFile, tokenFileFor, writeTokenFile } from './token.mjs';

const maxRequestBytes = 8 * 1024 * 1024;
const staticFiles = new Map([
  ['/', ['index.html', 'text/html']],
  ['/app.js', ['app.js', 'text/javascript']],
  ['/styles.css', ['styles.css', 'text/css']],
  // P1f: the browser's session secret lives in this origin's storage; session.js reads
  // it for the pages, and the sign-in page turns a one-time code into one.
  ['/session.js', ['session.js', 'text/javascript']],
  ['/login', ['login.html', 'text/html']],
  ['/login.js', ['login.js', 'text/javascript']],
  // The console (card U1): a fixed list, so no other path under /console/ is served.
  ['/console', ['console/index.html', 'text/html']],
  ['/console/', ['console/index.html', 'text/html']],
  ...['console.css', 'office.css'].map(name => [`/console/${name}`, [`console/${name}`, 'text/css']]),
  ...['console.mjs', 'office.mjs', 'model.mjs', 'source.mjs', 'brain.mjs', 'evidence.mjs']
    .map(name => [`/console/${name}`, [`console/${name}`, 'text/javascript']]),
  ['/console/demo-recording.json', ['console/demo-recording.json', 'application/json']],
  // The same session.js, so the console's files all stay under /console/ (P1f).
  ['/console/session.js', ['session.js', 'text/javascript']],
]);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

// Every write, with or without a body, must come from this server's own origin.
function requireSameOrigin(request, origin, operation) {
  if (request.headers.origin !== origin) throw new HttpError(403, `${operation} requires the same origin.`);
}

async function readJson(request, origin, operation, limit = { bytes: maxRequestBytes, text: '8 MiB' }) {
  requireSameOrigin(request, origin, operation);
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new HttpError(415, `${operation} requires application/json.`);
  }
  if (Number(request.headers['content-length']) > limit.bytes) {
    throw new HttpError(413, `${operation} exceeds the ${limit.text} request limit.`);
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit.bytes) throw new HttpError(413, `${operation} exceeds the ${limit.text} request limit.`);
    chunks.push(chunk);
  }

  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)));
  } catch {
    throw new HttpError(400, `${operation} request must contain valid UTF-8 JSON.`);
  }
}

const hexParameter = /^[a-f0-9]{64}$/u;
const partyParameter = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

// Query parameters of the list routes. Errors are fixed text and never echo a value.
function listParameters(url, filters) {
  for (const name of ['limit', 'after', ...filters]) {
    if (url.searchParams.getAll(name).length > 1) throw new InputError('Each list parameter may appear once.');
  }
  const limitText = url.searchParams.get('limit');
  if (limitText !== null && (!/^[0-9]{1,3}$/u.test(limitText) || Number(limitText) < 1 || Number(limitText) > 100)) {
    throw new InputError('limit must be an integer from 1 to 100.');
  }
  const values = { limit: limitText === null ? undefined : Number(limitText) };
  for (const name of ['after', ...filters]) {
    const value = url.searchParams.get(name);
    if (value === null) continue;
    if (name === 'party') {
      if (value.length > 32 || !partyParameter.test(value)) {
        throw new InputError('party must be a party name of at most 32 lowercase letters, digits and single hyphens.');
      }
    } else if (name === 'project') {
      // P2a: a present but empty or malformed project is invalid, never "every project".
      if (!isProjectSlug(value)) throw new InputError(projectSlugRule);
    } else if (!hexParameter.test(value)) {
      throw new InputError(`${name} must be a 64-character lowercase hex ID.`);
    }
    values[name] = value;
  }
  return values;
}

// The local latent runtime. LATENT_URL overrides it; it is read on each request.
const defaultLatentUrl = 'http://127.0.0.1:4320';
const latentUrl = () => process.env.LATENT_URL ?? defaultLatentUrl;

const port = Number(process.env.PORT ?? 4317);
const database = process.env.CONTEXT_LEDGER_DB ?? '.context-ledger/ledger.sqlite';
const store = openStore(database);

// A fresh API token at each start, in a file next to the database named for the port
// (ADR-10; <database>.<port>.token), written only once the port is ours: a second
// server that cannot listen never replaces the first one's token, and a server on
// another port writes its own file. Only the CLI and the MCP adapter read the file; the
// browser signs in with a one-time code. Requests before the file is written get 503.
const tokenFailure = 'Cannot write the access token file next to the database. Set CONTEXT_LEDGER_DB to a file in a folder you own.';
if (database === ':memory:') {
  console.error(tokenFailure);
  process.exit(1);
}
let tokenFile;
let auth;
// The token file's identity, so a latent read refuses it under any name (a hard link).
let tokenIdentity;
const refuseFiles = () => (tokenIdentity ? [tokenIdentity] : []);
const signInHelp = 'Sign in first: run npm run ledger -- login and open the link it prints.';

// A handler returns the JSON body of a 200 response, `sent` when it wrote the response
// itself, or undefined when the record is not there; the request then goes on down
// the table and, as no other entry matches, ends in 404.
const sent = Symbol('sent');
const hexId = '([a-f0-9]{64})';
const idPattern = (prefix, suffix = '') => new RegExp(`^${prefix}/${hexId}${suffix}$`, 'u');

// Entries match on the method and the exact path or the anchored pattern, in order.
// A request that matches none is a 404 whatever its method (there is no 405). The
/**
 * Card G12: an export is the node-link JSON itself, so a download loads straight into
 * Graphify, and it is escaped like any other export: controls, bidi and format
 * characters become \u escapes, which JSON reads back as the same text.
 */
function sendExport(response, bundle) {
  if (!bundle) return undefined;
  response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(terminalJson(bundle) + '\n');
  return sent;
}

// Card G9: an optional question and token budget for a scoped briefing. The messages
// are fixed and echo nothing back.
function scopeParameters(url) {
  for (const name of ['question', 'budget']) {
    if (url.searchParams.getAll(name).length > 1) throw new InputError('Each context parameter may appear once.');
  }
  const question = url.searchParams.get('question') ?? undefined;
  const budgetText = url.searchParams.get('budget') ?? undefined;
  if (question !== undefined && (!question.trim() || questionLength(question) > maxQuestionCharacters)) {
    throw new InputError(`question must be 1 to ${maxQuestionCharacters} characters.`);
  }
  let budget;
  if (budgetText !== undefined) {
    budget = /^[1-9]\d{0,5}$/u.test(budgetText) ? Number(budgetText) : NaN;
    if (!(budget >= minBudget && budget <= maxBudget)) throw new InputError(`budget must be a whole number from ${minBudget} to ${maxBudget}.`);
    if (question === undefined) throw new InputError('budget needs a question.');
  }
  return { question, budget };
}

// Host, URL and token checks run before this table; each write checks its Origin, in
// readJson or, for the bodiless DELETE, in requireSameOrigin. Only the static files
// (the sign-in page among them) and POST /api/session are open without the token or a
// browser session.
const signInLimit = { bytes: 1024, text: '1 KiB' };
const linkFailure = 'This sign-in link was already used, has expired or is not valid. Run npm run ledger -- login for a new one.';
const routes = [
  ...[...staticFiles].map(([path, [file, contentType]]) => ({
    method: 'GET', path, handler: async ({ response }) => {
      const bytes = await readFile(new URL(`../public/${file}`, import.meta.url));
      response.writeHead(200, { 'Content-Type': `${contentType}; charset=utf-8` });
      response.end(bytes);
      return sent;
    },
  })),
  { method: 'POST', path: '/api/session', handler: async ({ request, response, origin }) => {
    // P1f: the sign-in page (GET /login, a static file) sends the one-time code from the
    // start-up line or `npm run ledger -- login` here, from this origin, and keeps the
    // session secret it gets back in this origin's storage. A well-formed code is used
    // up whether or not it was still valid. No cookie is set, and any P1e cookie of this
    // port is removed, because browsers send cookies to every port of the host.
    const input = await readJson(request, origin, 'Signing in', signInLimit);
    const keys = input !== null && typeof input === 'object' && !Array.isArray(input) ? Object.keys(input) : [];
    const session = keys.length === 1 && keys[0] === 'code' ? auth.redeem(input.code) : undefined;
    if (!session) throw new HttpError(401, linkFailure);
    response.setHeader('Set-Cookie', auth.clearOldCookie);
    return { session, expiresInSeconds: sessionLifetimeMs / 1000 };
  } },
  { method: 'POST', path: '/api/login', handler: ({ request }) => {
    // Sign-in codes are made with the token file, not with a browser session.
    if (!auth.bearer(request)) throw new HttpError(403, 'Sign-in links are made with the access token: run npm run ledger -- login.');
    return { path: '/login?code=' + auth.mintCode(), expiresInSeconds: codeLifetimeMs / 1000 };
  } },
  { method: 'POST', path: '/api/import', handler: async ({ request, origin }) => {
    const input = await readJson(request, origin, 'Import');
    const { skipped, ...session } = store.importTranscript(input);
    return skipped ? { session, skipped } : { session };
  } },
  { method: 'POST', path: '/api/graphs', handler: async ({ request, origin }) => {
    const packet = await readJson(request, origin, 'Graph publication');
    return { graph: store.publishGraph(packet) };
  } },
  // Card P2b (ADR-7b): artifacts are registered by a person, never found automatically.
  { method: 'POST', path: '/api/artifacts', handler: async ({ request, origin }) => {
    const input = await readJson(request, origin, 'Artifact registration');
    return { artifact: store.registerArtifact(input) };
  } },
  { method: 'GET', path: '/api/artifacts', handler: ({ url }) => {
    const { limit = 20, after, project } = listParameters(url, ['project']);
    return store.listArtifacts({ project, limit, after });
  } },
  { method: 'GET', path: '/api/sessions', handler: ({ url }) => {
    const query = url.searchParams.get('q') ?? '';
    const provider = url.searchParams.get('provider') ?? '';
    if (query.length > 512) throw new InputError('Search is limited to 512 characters.');
    if (provider && !isProvider(provider)) throw new InputError('Unknown provider.');
    // A project slug filters; an unknown one matches nothing. Errors never echo it.
    if (url.searchParams.getAll('project').length > 1) throw new InputError('project may appear once.');
    // A present but empty project is invalid, not "every project".
    const project = url.searchParams.get('project');
    if (project !== null && !isProjectSlug(project)) throw new InputError(projectSlugRule);
    // The browser and the CLI send neither limit nor after and get every match, as before.
    if (!url.searchParams.has('limit') && !url.searchParams.has('after')) return { sessions: store.list(query, provider, project) };
    const { limit = 100, after } = listParameters(url, []);
    return store.listSessionsPage({ query, provider, project, limit, after });
  } },
  { method: 'GET', path: '/api/graphs', handler: ({ url }) => {
    const { limit = 20, after, sessionId, party, project } = listParameters(url, ['sessionId', 'party', 'project']);
    return store.listGraphs({ sessionId, party, project, limit, after });
  } },
  { method: 'GET', path: '/api/rooms', handler: ({ url }) => {
    const { limit = 20, after, graphId, party, project } = listParameters(url, ['graphId', 'party', 'project']);
    return store.listRooms({ graphId, party, project, limit, after });
  } },
  { method: 'GET', pattern: idPattern('/api/sessions'), handler: ({ params: [id] }) => {
    const session = store.get(id);
    return session ? { session } : undefined;
  } },
  { method: 'DELETE', pattern: idPattern('/api/sessions'), handler: ({ request, origin, params: [id] }) => {
    // Origin first, so a foreign page cannot even learn whether the ID exists. The
    // request has no body to read. There is no MCP tool for this: agents do not
    // delete people's data.
    requireSameOrigin(request, origin, 'Deleting a session');
    return store.deleteSession(id) ? { deleted: id } : undefined;
  } },
  { method: 'GET', pattern: idPattern('/api/graphs'), handler: ({ params: [id] }) => {
    const graph = store.getGraph(id);
    if (!graph) return undefined;
    // Card P2c: a version 3 graph comes with the decisions on its nodes' current hashes.
    return { graph: graph.packet.version === 3 ? { ...graph, reviews: store.graphReviews(id) } : graph };
  } },
  { method: 'POST', pattern: idPattern('/api/graphs', '/reviews'), handler: async ({ request, origin, params: [id] }) => {
    // People approve or reject nodes in the browser. The request must carry a browser's
    // sign-in session (the CLI and the MCP adapter hold only the bearer token) and a
    // browser's Sec-Fetch-Site, which page scripts cannot forge. That keeps agent clients
    // out; it does not prove who clicked: a program running as the person can still sign
    // in as a browser does (ADR-10 trusts the OS user; P2c review).
    if (!auth.signedIn(request) || request.headers['sec-fetch-site'] !== 'same-origin') {
      throw new HttpError(403, 'Nodes are approved or rejected by people in the browser, signed in.');
    }
    const input = await readJson(request, origin, 'A node review');
    const reviews = store.reviewNode(id, input);
    return reviews ? { reviews } : undefined;
  } },
  { method: 'GET', pattern: idPattern('/api/graphs', '/export'), handler: ({ params: [id], url, response }) => {
    if ([...url.searchParams.keys()].length) throw new InputError('This export takes no parameters.');
    return sendExport(response, store.exportGraphs([id]));
  } },
  { method: 'GET', path: '/api/export', handler: ({ url, response }) => {
    const keys = [...url.searchParams.keys()];
    const ids = url.searchParams.getAll('graph');
    if (keys.some(key => key !== 'graph') || !ids.length || ids.length > maxBundleGraphs || ids.some(id => !/^[a-f0-9]{64}$/u.test(id))) {
      throw new InputError(`The export takes 1 to ${maxBundleGraphs} graph=<graph ID> parameters and nothing else.`);
    }
    return sendExport(response, store.exportGraphs(ids));
  } },
  { method: 'GET', pattern: idPattern('/api/graphs', '/diff'), handler: ({ params: [id], url }) => {
    // One from parameter and nothing else, so a typo is not silently ignored.
    if ([...url.searchParams.keys()].some(key => key !== 'from') || url.searchParams.getAll('from').length > 1) {
      throw new InputError('The diff takes one from parameter and no other.');
    }
    const from = url.searchParams.get('from') ?? '';
    if (!/^[a-f0-9]{64}$/u.test(from)) throw new InputError('from must be a graph ID.');
    const diff = store.diffGraphs(id, from);
    return diff ? { diff } : undefined;
  } },
  { method: 'GET', pattern: idPattern('/api/graphs', '/context'), handler: ({ params: [id], url }) => {
    const context = store.getGraphContext(id, scopeParameters(url));
    return context ? { context } : undefined;
  } },
  { method: 'POST', path: '/api/latent/read', handler: async ({ request, origin }) => {
    const input = await readJson(request, origin, 'A latent read');
    return latentRead(input, { latentUrl: latentUrl(), latentRoot: process.env.LATENT_ROOT, refuseFiles: refuseFiles() });
  } },
  { method: 'POST', path: '/api/latent/transfer', handler: async ({ request, origin }) => {
    const input = await readJson(request, origin, 'A latent transfer');
    return latentTransfer(input, { latentUrl: latentUrl(), latentRoot: process.env.LATENT_ROOT, refuseFiles: refuseFiles() });
  } },
  { method: 'POST', path: '/api/latent/files', handler: async ({ request, origin }) => {
    // The fallback's numbered text without the runtime: MCP pages a long fallback with it.
    const input = await readJson(request, origin, 'Reading latent files');
    return latentFiles(input, { latentRoot: process.env.LATENT_ROOT, refuseFiles: refuseFiles() });
  } },
  { method: 'POST', path: '/api/latent/team', handler: async ({ request, origin }) => {
    const input = await readJson(request, origin, 'A latent team run');
    return latentTeam(input, { latentUrl: latentUrl() });
  } },
  { method: 'POST', path: '/api/rooms', handler: async ({ request, origin }) => {
    const input = await readJson(request, origin, 'Opening a room');
    return { room: store.openRoom(input) };
  } },
  { method: 'GET', pattern: idPattern('/api/rooms'), handler: ({ params: [id] }) => {
    const room = store.getRoom(id);
    return room ? { room } : undefined;
  } },
  { method: 'POST', pattern: idPattern('/api/rooms', '/decisions'), handler: async ({ request, origin, params: [id] }) => {
    // People confirm proposals in the browser. Browsers set Sec-Fetch-Site and page
    // scripts cannot forge it; a local process can, so this keeps honest agent
    // clients (the CLI and MCP adapter) out rather than proving who clicked.
    if (request.headers['sec-fetch-site'] !== 'same-origin') {
      throw new HttpError(403, 'Proposals are confirmed by people in the browser.');
    }
    const input = await readJson(request, origin, 'A room decision');
    const room = store.decide(id, input);
    return room ? { room } : undefined;
  } },
];

/** The captured groups when the route matches this path, otherwise null. */
function matchRoute(route, pathname) {
  if (route.path !== undefined) return route.path === pathname ? [] : null;
  return route.pattern.exec(pathname)?.slice(1) ?? null;
}

const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');

  try {
    const localPort = server.address().port;
    const host = request.headers.host;
    if (host !== `127.0.0.1:${localPort}` && host !== `localhost:${localPort}`) {
      throw new HttpError(403, 'Unrecognized local host.');
    }
    if (!request.url?.startsWith('/') || request.url.startsWith('//')) {
      throw new HttpError(400, 'Invalid request URL.');
    }
    const origin = `http://${host}`;
    const url = new URL(request.url, origin);
    if (!auth) throw new HttpError(503, 'Context Ledger is starting.');
    const open = staticFiles.has(url.pathname) || (request.method === 'POST' && url.pathname === '/api/session');
    if (!open) {
      if (!auth.allowed(request)) {
        response.setHeader('WWW-Authenticate', 'Bearer realm="Context Ledger"');
        throw new HttpError(401, signInHelp);
      }
    }

    for (const route of routes) {
      if (route.method !== request.method) continue;
      const params = matchRoute(route, url.pathname);
      if (!params) continue;
      const body = await route.handler({ request, response, url, origin, params });
      if (body === undefined) continue;
      if (body !== sent) json(response, 200, body);
      return;
    }

    throw new HttpError(404, 'Not found.');
  } catch (error) {
    if (response.destroyed) return;
    if (!request.readableEnded) {
      response.setHeader('Connection', 'close');
      request.resume();
    }
    if (error instanceof HttpError || error instanceof LatentError) return json(response, error.status, { error: error.message });
    if (error instanceof ConflictError) return json(response, 409, { error: error.message, ...error.details });
    if (error instanceof InputError || error instanceof GraphInputError) {
      return json(response, 400, { error: error.message });
    }
    return json(response, 500, { error: 'Local request failed.' });
  }
});

server.listen(port, '127.0.0.1', () => {
  const localPort = server.address().port;
  // The plain token lives only in this callback and in the file; auth keeps its digest.
  const token = newToken();
  try {
    tokenFile = tokenFileFor(database, localPort);
    tokenIdentity = writeTokenFile(tokenFile, token, localPort);
  } catch {
    console.error(tokenFailure);
    process.exit(1);
  }
  auth = createAuth({ token, port: localPort });
  // A clean stop removes the file, so a program that takes the port later gets no
  // live token from a client. A killed process leaves a dead token behind.
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      removeTokenFile(tokenFile, auth.isOwnToken);
      process.exit(0);
    });
  }
  console.log(`Context Ledger listening at http://127.0.0.1:${localPort}`);
  console.log(`Sign in to the browser app (one use, within ${codeLifetimeMs / 1000} seconds): http://127.0.0.1:${localPort}${'/login?code=' + auth.mintCode()}`);
});
