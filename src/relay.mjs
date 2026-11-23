// Card R2 (ADR-20): the relay, a mailbox for sealed parcels between two machines.
//
// It is a separate program from the ledger server and must stay one: this file imports
// only Node built-ins, opens no database and reads no file (tests/relay.test.mjs checks
// the imports). It never sees a parcel's text or its key. A sender puts sealed bytes
// under an access token; the relay files them under the SHA-256 of that token, so it
// stores no token either. A box holds one parcel, in memory, until the receiver deletes
// it or it expires. Replies are fixed JSON and never echo a token or a body.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

export const relayName = 'context-ledger-relay';
export const relayVersion = 1;
export const defaultRelayPort = 4319;
// A parcel is at most 8 MiB (parcel.mjs); the seal adds a 32-byte header and tag.
export const maxSealedBytes = 8 * 1024 * 1024 + 1024;
export const minSealedBytes = 33;
export const defaultLimits = Object.freeze({ parcels: 64, bytes: 128 * 1024 * 1024, lifetimeMs: 24 * 60 * 60 * 1000 });

/**
 * What `ledger relay serve` prints once it listens, from server.address(). An address
 * other machines can reach gets a plain warning, because the relay has no accounts.
 */
export function listeningNotice({ address, family, port }) {
  const local = address === '::1' || /^127\./u.test(address);
  return [
    `Context Ledger relay listening on http://${family === 'IPv6' ? `[${address}]` : address}:${port}`,
    'It holds sealed parcels in memory for up to 24 hours and cannot read them.',
    local ? 'Only this machine can reach it. To serve another machine, start it with --host and an address of this machine.'
      : 'It listens beyond this machine: anyone who can reach this address can use it. Run it only on a network you trust.',
  ].join('\n');
}

// The token is 32 bytes as base64url, exactly as the client derives it.
const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/u;
const problems = {
  400: 'A sealed parcel is expected as the request body.',
  401: 'A relay access token is required.',
  404: 'Nothing here.',
  405: 'Method not allowed.',
  409: 'This box already holds a parcel.',
  413: 'The parcel is too large for the relay.',
  507: 'The relay is full.',
};

function send(response, status, body, headers = {}) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  response.end(text);
}

const refuse = (response, status, headers) => send(response, status, { error: problems[status] }, headers);

// A refused body is still read to its end and dropped, because an answer sent while the
// sender is still writing is lost with the connection on some systems, and the sender
// then sees a broken connection instead of the reason. What is dropped is bounded.
const maxDroppedBytes = 2 * maxSealedBytes;

/**
 * The request body when it is at most `limit` bytes, or null when it is longer: the rest
 * is then read and dropped. Rejects when the connection breaks, or when the body passes
 * the drop bound and the connection is cut.
 */
function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    request.on('data', chunk => {
      size += chunk.length;
      if (size > maxDroppedBytes) {
        request.destroy();
        reject(new Error('The body is far too long.'));
      } else if (size > limit) {
        chunks = null;
      } else {
        chunks.push(chunk);
      }
    });
    request.on('end', () => resolve(chunks && Buffer.concat(chunks)));
    request.on('error', reject);
    request.on('close', () => reject(new Error('The request ended early.')));
  });
}

/**
 * A relay: its HTTP server (not yet listening) and stats() for tests. `limits` bounds how
 * many parcels and bytes it holds and for how long; `now` is the clock.
 */
export function createRelay({ limits = defaultLimits, now = Date.now } = {}) {
  // SHA-256 of the access token, in hex, to { sealed, expires }.
  const boxes = new Map();
  let held = 0;
  const drop = id => {
    const box = boxes.get(id);
    if (!box) return false;
    held -= box.sealed.length;
    boxes.delete(id);
    return true;
  };
  const sweep = () => {
    const time = now();
    for (const [id, box] of boxes) {
      if (box.expires <= time) drop(id);
    }
  };

  async function parcel(request, response) {
    const token = bearer.exec(request.headers.authorization ?? '')?.[1];
    if (token === undefined) return refuse(response, 401, { 'WWW-Authenticate': 'Bearer' });
    const id = createHash('sha256').update(token).digest('hex');
    sweep();
    if (request.method === 'GET') {
      const box = boxes.get(id);
      if (!box) return refuse(response, 404);
      response.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': box.sealed.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      return response.end(box.sealed);
    }
    if (request.method === 'DELETE') {
      if (!drop(id)) return refuse(response, 404);
      response.writeHead(204, { 'Cache-Control': 'no-store' });
      return response.end();
    }
    if (request.method !== 'PUT') return refuse(response, 405, { Allow: 'GET, PUT, DELETE' });

    // What is already known to be refused is not kept while it arrives.
    const declared = Number(request.headers['content-length']);
    const early = boxes.has(id) ? 409
      : declared > maxSealedBytes ? 413
        : boxes.size >= limits.parcels || held + (declared || 0) > limits.bytes ? 507 : 0;
    const sealed = await readBody(request, early ? 0 : maxSealedBytes);
    if (early) return refuse(response, early);
    if (sealed === null) return refuse(response, 413);
    if (sealed.length < minSealedBytes) return refuse(response, 400);
    // Checked again: other requests ran while this body arrived.
    sweep();
    if (boxes.has(id)) return refuse(response, 409);
    if (boxes.size >= limits.parcels || held + sealed.length > limits.bytes) return refuse(response, 507);
    boxes.set(id, { sealed, expires: now() + limits.lifetimeMs });
    held += sealed.length;
    return send(response, 201, { stored: true, expiresInSeconds: Math.floor(limits.lifetimeMs / 1000) });
  }

  const server = createServer((request, response) => {
    let path;
    try {
      path = new URL(request.url, 'http://relay.invalid').pathname;
    } catch {
      return refuse(response, 404);
    }
    if (path === '/v1/health') {
      if (request.method !== 'GET') return refuse(response, 405, { Allow: 'GET' });
      return send(response, 200, { relay: relayName, version: relayVersion });
    }
    if (path !== '/v1/parcel') return refuse(response, 404);
    return parcel(request, response).catch(() => {
      // The request broke off; there is nobody left to answer.
      response.destroy();
    });
  });
  // A sender that stalls cannot hold a connection open for long.
  server.headersTimeout = 10_000;
  server.requestTimeout = 60_000;
  server.keepAliveTimeout = 5_000;
  server.maxConnections = 64;
  return { server, stats: () => ({ parcels: boxes.size, bytes: held }) };
}
