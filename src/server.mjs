import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { GraphInputError } from './graph.mjs';
import { LatentError, latentFiles, latentRead, latentTeam, latentTransfer } from './latent.mjs';
import { InputError, isProjectSlug, isProvider, openStore, projectSlugRule } from './store.mjs';

const maxRequestBytes = 8 * 1024 * 1024;
const staticFiles = new Map([
  ['/', ['index.html', 'text/html']],
  ['/app.js', ['app.js', 'text/javascript']],
  ['/styles.css', ['styles.css', 'text/css']],
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

async function readJson(request, origin, operation) {
  if (request.headers.origin !== origin) throw new HttpError(403, `${operation} requires the same origin.`);
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new HttpError(415, `${operation} requires application/json.`);
  }
  if (Number(request.headers['content-length']) > maxRequestBytes) {
    throw new HttpError(413, `${operation} exceeds the 8 MiB request limit.`);
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maxRequestBytes) throw new HttpError(413, `${operation} exceeds the 8 MiB request limit.`);
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
const store = openStore(process.env.CONTEXT_LEDGER_DB ?? '.context-ledger/ledger.sqlite');

// A handler returns the JSON body of a 200 response, `sent` when it wrote the response
// itself, or undefined when the record is not there; the request then goes on down
// the table and, as no other entry matches, ends in 404.
const sent = Symbol('sent');
const hexId = '([a-f0-9]{64})';
const idPattern = (prefix, suffix = '') => new RegExp(`^${prefix}/${hexId}${suffix}$`, 'u');

// Entries match on the method and the exact path or the anchored pattern, in order.
// A request that matches none is a 404 whatever its method (there is no 405). The
// Host and URL checks run before this table; each write checks its Origin in readJson.
const routes = [
  ...[...staticFiles].map(([path, [file, contentType]]) => ({
    method: 'GET', path, handler: async ({ response }) => {
      const bytes = await readFile(new URL(`../public/${file}`, import.meta.url));
      response.writeHead(200, { 'Content-Type': `${contentType}; charset=utf-8` });
      response.end(bytes);
      return sent;
    },
  })),
  { method: 'POST', path: '/api/import', handler: async ({ request, origin }) => {
    const input = await readJson(request, origin, 'Import');
    return { session: store.importTranscript(input) };
  } },
  { method: 'POST', path: '/api/graphs', handler: async ({ request, origin }) => {
    const packet = await readJson(request, origin, 'Graph publication');
    return { graph: store.publishGraph(packet) };
  } },
  // Card U5: the library's project picker. Read-only, every project with its session count.
  { method: 'GET', path: '/api/projects', handler: () => ({ projects: store.listProjects() }) },
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
    const { limit = 20, after, sessionId, party } = listParameters(url, ['sessionId', 'party']);
    return store.listGraphs({ sessionId, party, limit, after });
  } },
  { method: 'GET', path: '/api/rooms', handler: ({ url }) => {
    const { limit = 20, after, graphId, party } = listParameters(url, ['graphId', 'party']);
    return store.listRooms({ graphId, party, limit, after });
  } },
  { method: 'GET', pattern: idPattern('/api/sessions'), handler: ({ params: [id] }) => {
    const session = store.get(id);
    return session ? { session } : undefined;
  } },
  { method: 'GET', pattern: idPattern('/api/graphs'), handler: ({ params: [id] }) => {
    const graph = store.getGraph(id);
    return graph ? { graph } : undefined;
  } },
  { method: 'GET', pattern: idPattern('/api/graphs', '/context'), handler: ({ params: [id] }) => {
    const context = store.getGraphContext(id);
    return context ? { context } : undefined;
  } },
  { method: 'POST', path: '/api/latent/read', handler: async ({ request, origin }) => {
    const input = await readJson(request, origin, 'A latent read');
    return latentRead(input, { latentUrl: latentUrl(), latentRoot: process.env.LATENT_ROOT });
  } },
  { method: 'POST', path: '/api/latent/transfer', handler: async ({ request, origin }) => {
    const input = await readJson(request, origin, 'A latent transfer');
    return latentTransfer(input, { latentUrl: latentUrl(), latentRoot: process.env.LATENT_ROOT });
  } },
  { method: 'POST', path: '/api/latent/files', handler: async ({ request, origin }) => {
    // The fallback's numbered text without the runtime: MCP pages a long fallback with it.
    const input = await readJson(request, origin, 'Reading latent files');
    return latentFiles(input, { latentRoot: process.env.LATENT_ROOT });
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
    if (error instanceof InputError || error instanceof GraphInputError) {
      return json(response, 400, { error: error.message });
    }
    return json(response, 500, { error: 'Local request failed.' });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Context Ledger listening at http://127.0.0.1:${server.address().port}`);
});
