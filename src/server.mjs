import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { GraphInputError } from './graph.mjs';
import { LatentError, latentRead, latentTransfer } from './latent.mjs';
import { InputError, isProvider, openStore } from './store.mjs';

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

const port = Number(process.env.PORT ?? 4317);
const store = openStore(process.env.CONTEXT_LEDGER_DB ?? '.context-ledger/ledger.sqlite');
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
    const method = request.method;

    if (method === 'GET' && staticFiles.has(url.pathname)) {
      const [file, contentType] = staticFiles.get(url.pathname);
      const bytes = await readFile(new URL(`../public/${file}`, import.meta.url));
      response.writeHead(200, { 'Content-Type': `${contentType}; charset=utf-8` });
      return response.end(bytes);
    }

    if (method === 'POST' && url.pathname === '/api/import') {
      const input = await readJson(request, origin, 'Import');
      return json(response, 200, { session: store.importTranscript(input) });
    }

    if (method === 'POST' && url.pathname === '/api/graphs') {
      const packet = await readJson(request, origin, 'Graph publication');
      return json(response, 200, { graph: store.publishGraph(packet) });
    }

    if (method === 'GET' && url.pathname === '/api/sessions') {
      const query = url.searchParams.get('q') ?? '';
      const provider = url.searchParams.get('provider') ?? '';
      if (query.length > 512) throw new InputError('Search is limited to 512 characters.');
      if (provider && !isProvider(provider)) throw new InputError('Unknown provider.');
      return json(response, 200, { sessions: store.list(query, provider) });
    }

    const id = url.pathname.match(/^\/api\/sessions\/([a-f0-9]{64})$/u)?.[1];
    if (method === 'GET' && id) {
      const session = store.get(id);
      if (session) return json(response, 200, { session });
    }

    const graphId = url.pathname.match(/^\/api\/graphs\/([a-f0-9]{64})$/u)?.[1];
    if (method === 'GET' && graphId) {
      const graph = store.getGraph(graphId);
      if (graph) return json(response, 200, { graph });
    }

    const contextId = url.pathname.match(/^\/api\/graphs\/([a-f0-9]{64})\/context$/u)?.[1];
    if (method === 'GET' && contextId) {
      const context = store.getGraphContext(contextId);
      if (context) return json(response, 200, { context });
    }

    if (method === 'POST' && url.pathname === '/api/latent/read') {
      const input = await readJson(request, origin, 'A latent read');
      return json(response, 200, await latentRead(input, {
        latentUrl: process.env.LATENT_URL ?? 'http://127.0.0.1:4320',
        latentRoot: process.env.LATENT_ROOT,
      }));
    }

    if (method === 'POST' && url.pathname === '/api/latent/transfer') {
      const input = await readJson(request, origin, 'A latent transfer');
      return json(response, 200, await latentTransfer(input, {
        latentUrl: process.env.LATENT_URL ?? 'http://127.0.0.1:4320',
        latentRoot: process.env.LATENT_ROOT,
      }));
    }

    if (method === 'POST' && url.pathname === '/api/rooms') {
      const input = await readJson(request, origin, 'Opening a room');
      return json(response, 200, { room: store.openRoom(input) });
    }

    const roomId = url.pathname.match(/^\/api\/rooms\/([a-f0-9]{64})$/u)?.[1];
    if (method === 'GET' && roomId) {
      const room = store.getRoom(roomId);
      if (room) return json(response, 200, { room });
    }

    const decisionRoomId = url.pathname.match(/^\/api\/rooms\/([a-f0-9]{64})\/decisions$/u)?.[1];
    if (method === 'POST' && decisionRoomId) {
      // People confirm proposals in the browser. Browsers set Sec-Fetch-Site and page
      // scripts cannot forge it; a local process can, so this keeps honest agent
      // clients (the CLI and MCP adapter) out rather than proving who clicked.
      if (request.headers['sec-fetch-site'] !== 'same-origin') {
        throw new HttpError(403, 'Proposals are confirmed by people in the browser.');
      }
      const input = await readJson(request, origin, 'A room decision');
      const room = store.decide(decisionRoomId, input);
      if (room) return json(response, 200, { room });
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
