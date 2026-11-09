// A local stand-in for the hosted usage service: it keeps each device's monthly limit of
// graph handoffs and hands out signed leases, so a ledger can spend a few handoffs
// without asking first. It stores device IDs, event IDs and times, never graph content.
//
//   QUOTA_PORT=4390 QUOTA_FREE_LIMIT=50 node src/quota-server.mjs
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const maxBodyBytes = 64 * 1024;
const maxEventsPerReport = 1000;
const deviceIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const dayMs = 24 * 60 * 60 * 1000;

/** The calendar month (UTC) that contains `time`. */
export function periodOf(time) {
  const date = new Date(time);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  return {
    period: `${year}-${String(month + 1).padStart(2, '0')}`,
    end: Date.UTC(year, month + 1, 1),
  };
}

function loadKey(dataDir) {
  const keyPath = join(dataDir, 'quota-signing-key.pem');
  if (!existsSync(keyPath)) {
    const { privateKey } = generateKeyPairSync('ed25519');
    writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  }
  const privateKey = createPrivateKey(readFileSync(keyPath));
  return { privateKey, publicKeyPem: createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }) };
}

class QuotaHttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** The service logic, without HTTP. `now` is injectable for tests. */
export function createQuotaService({ dataDir, freeLimit = 50, leaseSize = 10, leaseDays = 7, now = () => Date.now() }) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const { privateKey, publicKeyPem } = loadKey(dataDir);
  const database = new DatabaseSync(join(dataDir, 'quota.sqlite'));
  database.exec(`
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS leases (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      period TEXT NOT NULL,
      credits INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS events (
      event_id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      lease_id TEXT,
      period TEXT NOT NULL,
      at INTEGER NOT NULL
    ) STRICT;
  `);
  const countUsed = database.prepare('SELECT count(*) AS n FROM events WHERE device_id = ? AND period = ?');
  // Credits still held by unexpired leases count as taken, so a device cannot hoard leases.
  const countReserved = database.prepare(`
    SELECT coalesce(sum(max(0, l.credits - (SELECT count(*) FROM events e WHERE e.lease_id = l.id))), 0) AS n
    FROM leases l WHERE l.device_id = ? AND l.period = ? AND l.expires_at > ?
  `);
  const insertLease = database.prepare('INSERT INTO leases (id, device_id, period, credits, expires_at) VALUES (?, ?, ?, ?, ?)');
  const leaseOwner = database.prepare('SELECT device_id AS deviceId, period FROM leases WHERE id = ?');
  const insertEvent = database.prepare(`
    INSERT INTO events (event_id, device_id, lease_id, period, at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (event_id) DO NOTHING
  `);

  function usage(deviceId) {
    const time = now();
    const { period, end } = periodOf(time);
    const used = countUsed.get(deviceId, period).n;
    const reserved = countReserved.get(deviceId, period, time).n;
    return { used, reserved, limit: freeLimit, resetsAt: new Date(end).toISOString(), period, end };
  }

  const publicUsage = ({ used, reserved, limit, resetsAt }) => ({ used: Math.min(limit, used + reserved), limit, resetsAt });

  function requireDevice(value) {
    if (typeof value !== 'string' || !deviceIdPattern.test(value)) throw new QuotaHttpError(400, 'A device ID is required.');
    return value;
  }

  return {
    publicKeyPem,

    lease(body) {
      const deviceId = requireDevice(body?.deviceId);
      const current = usage(deviceId);
      const available = current.limit - current.used - current.reserved;
      if (available <= 0) {
        return { status: 402, body: { error: 'limit', usage: publicUsage(current) } };
      }
      const credits = Math.min(leaseSize, available);
      const time = now();
      const expiresAt = Math.min(time + leaseDays * dayMs, current.end);
      const payload = {
        v: 1,
        leaseId: randomUUID(),
        deviceId,
        period: current.period,
        credits,
        expiresAt: new Date(expiresAt).toISOString(),
        resetsAt: current.resetsAt,
        limit: current.limit,
        usedAtIssue: current.used + current.reserved,
      };
      insertLease.run(payload.leaseId, deviceId, current.period, credits, expiresAt);
      const token = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const signature = sign(null, Buffer.from(token), privateKey).toString('base64url');
      return { status: 200, body: { token, signature, usage: publicUsage(usage(deviceId)) } };
    },

    report(body) {
      const deviceId = requireDevice(body?.deviceId);
      const events = body?.events;
      if (!Array.isArray(events) || events.length > maxEventsPerReport) {
        throw new QuotaHttpError(400, `A report carries 0 to ${maxEventsPerReport} events.`);
      }
      const time = now();
      for (const event of events) {
        const { eventId, leaseId = null, at } = event ?? {};
        if (typeof eventId !== 'string' || !deviceIdPattern.test(eventId)) throw new QuotaHttpError(400, 'Each event needs an event ID.');
        if (!Number.isFinite(at)) throw new QuotaHttpError(400, 'Each event needs a time.');
        let period;
        if (leaseId !== null) {
          const owner = typeof leaseId === 'string' ? leaseOwner.get(leaseId) : undefined;
          if (!owner || owner.deviceId !== deviceId) throw new QuotaHttpError(400, 'An event names a lease of another device.');
          period = owner.period;
        } else {
          // An offline handoff has no lease: count it in the month it happened, but never in the future.
          period = periodOf(Math.min(at, time)).period;
        }
        insertEvent.run(eventId, deviceId, leaseId, period, Math.round(at));
      }
      return { status: 200, body: { usage: publicUsage(usage(deviceId)) } };
    },

    usage(deviceId) {
      return { status: 200, body: { usage: publicUsage(usage(requireDevice(deviceId))) } };
    },

    close() {
      database.close();
    },
  };
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) throw new QuotaHttpError(413, 'Request too large.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new QuotaHttpError(400, 'Request must be JSON.');
  }
}

/** Serve the service on loopback. Resolves { port, close() }. */
export function startQuotaServer({ port = 0, ...options }) {
  const service = createQuotaService(options);
  const server = createServer(async (request, response) => {
    const send = (status, body) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(body));
    };
    try {
      const localPort = server.address().port;
      const host = request.headers.host;
      if (host !== `127.0.0.1:${localPort}` && host !== `localhost:${localPort}`) throw new QuotaHttpError(403, 'Unrecognized host.');
      const url = new URL(request.url, `http://${host}`);
      if (request.method === 'GET' && url.pathname === '/v1/public-key') return send(200, { publicKey: service.publicKeyPem });
      if (request.method === 'GET' && url.pathname === '/v1/usage') {
        const result = service.usage(url.searchParams.get('deviceId'));
        return send(result.status, result.body);
      }
      if (request.method === 'POST' && url.pathname === '/v1/leases') {
        const result = service.lease(await readBody(request));
        return send(result.status, result.body);
      }
      if (request.method === 'POST' && url.pathname === '/v1/usage/report') {
        const result = service.report(await readBody(request));
        return send(result.status, result.body);
      }
      throw new QuotaHttpError(404, 'Not found.');
    } catch (error) {
      if (error instanceof QuotaHttpError) return send(error.status, { error: error.message });
      console.error('quota service:', error);
      return send(500, { error: 'Usage service failed.' });
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({
      port: server.address().port,
      close: () => new Promise(done => server.close(() => { service.close(); done(); })),
    }));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = process.env;
  const positive = (value, fallback) => {
    const number = Number(value ?? fallback);
    if (!Number.isInteger(number) || number < 1) throw new Error(`Expected a positive integer, got ${value}.`);
    return number;
  };
  const { port } = await startQuotaServer({
    port: positive(env.QUOTA_PORT, 4390),
    dataDir: env.QUOTA_DATA_DIR ?? join(homedir(), '.context-ledger', 'quota-service'),
    freeLimit: positive(env.QUOTA_FREE_LIMIT, 50),
    leaseSize: positive(env.QUOTA_LEASE_SIZE, 10),
  });
  console.log(`Context Ledger usage service (local stand-in) listening at http://127.0.0.1:${port}`);
}
