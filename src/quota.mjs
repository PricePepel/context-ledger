// The ledger side of the handoff limit. Each graph briefing an agent reads is one
// handoff. The ledger spends handoffs from signed leases it takes from the usage
// service, so a read does not wait on the network, and it reports what it spent.
// Only a device ID, event IDs, lease IDs and times leave this machine.
import { createPublicKey, randomUUID, verify } from 'node:crypto';

const requestTimeoutMs = 3000;

/** Tables and queries the quota client needs, on the ledger's own database. */
export function mountQuotaStore(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS quota_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS quota_leases (
      id TEXT PRIMARY KEY,
      credits INTEGER NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      used_at_issue INTEGER NOT NULL,
      quota_limit INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      resets_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS quota_events (
      event_id TEXT PRIMARY KEY,
      lease_id TEXT,
      at INTEGER NOT NULL,
      reported INTEGER NOT NULL DEFAULT 0
    ) STRICT;
  `);
  const getSetting = database.prepare('SELECT value FROM quota_settings WHERE key = ?');
  const putSetting = database.prepare('INSERT INTO quota_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value');
  const activeLease = database.prepare(`
    SELECT id, credits, used, used_at_issue AS usedAtIssue, quota_limit AS "limit", resets_at AS resetsAt
    FROM quota_leases WHERE used < credits AND expires_at > ? ORDER BY expires_at LIMIT 1
  `);
  const insertLease = database.prepare(`
    INSERT INTO quota_leases (id, credits, used_at_issue, quota_limit, expires_at, resets_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO NOTHING
  `);
  const takeCredit = database.prepare('UPDATE quota_leases SET used = used + 1 WHERE id = ? AND used < credits');
  const insertEvent = database.prepare('INSERT INTO quota_events (event_id, lease_id, at) VALUES (?, ?, ?)');
  const unreported = database.prepare('SELECT event_id AS eventId, lease_id AS leaseId, at FROM quota_events WHERE reported = 0 ORDER BY at LIMIT 500');
  const offlineCount = database.prepare('SELECT count(*) AS n FROM quota_events WHERE reported = 0 AND lease_id IS NULL');
  const markReported = database.prepare('UPDATE quota_events SET reported = 1 WHERE event_id = ?');

  return {
    setting: key => getSetting.get(key)?.value,
    setSetting: (key, value) => putSetting.run(key, value),
    activeLease: time => activeLease.get(time),
    saveLease: lease => insertLease.run(lease.id, lease.credits, lease.usedAtIssue, lease.limit, lease.expiresAt, lease.resetsAt),
    spend(leaseId, eventId, at) {
      database.exec('BEGIN IMMEDIATE');
      try {
        if (leaseId !== null && takeCredit.run(leaseId).changes !== 1) throw new Error('Lease has no credits left.');
        insertEvent.run(eventId, leaseId, at);
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
    unreported: () => unreported.all(),
    offlineCount: () => offlineCount.get().n,
    markReported(eventIds) {
      for (const eventId of eventIds) markReported.run(eventId);
    },
  };
}

/** Accept a lease only if the usage service signed it for this device and it is still valid. */
export function readLease({ token, signature }, publicKeyPem, deviceId, time) {
  if (typeof token !== 'string' || typeof signature !== 'string') return;
  let valid = false;
  try {
    valid = verify(null, Buffer.from(token), createPublicKey(publicKeyPem), Buffer.from(signature, 'base64url'));
  } catch {
    return;
  }
  if (!valid) return;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    return;
  }
  const expiresAt = Date.parse(payload?.expiresAt);
  const resetsAt = Date.parse(payload?.resetsAt);
  if (payload?.v !== 1 || payload.deviceId !== deviceId || typeof payload.leaseId !== 'string') return;
  if (!Number.isInteger(payload.credits) || payload.credits < 1 || !Number.isInteger(payload.limit)) return;
  if (!Number.isInteger(payload.usedAtIssue) || !(expiresAt > time) || !(resetsAt > time)) return;
  return {
    id: payload.leaseId, credits: payload.credits, usedAtIssue: payload.usedAtIssue, limit: payload.limit,
    expiresAt, resetsAt: new Date(resetsAt).toISOString(),
  };
}

const cleanUsage = usage => {
  const limit = Number.isInteger(usage?.limit) ? usage.limit : undefined;
  const used = Number.isInteger(usage?.used) ? usage.used : undefined;
  const resetsAt = Number.isFinite(Date.parse(usage?.resetsAt)) ? new Date(usage.resetsAt).toISOString() : undefined;
  return limit === undefined || used === undefined || resetsAt === undefined ? undefined : { used, limit, resetsAt };
};

/**
 * A client of the usage service. `consume()` resolves { ok: true, usage } when the
 * handoff may go ahead, or { ok: false, reason: 'limit' | 'unreachable', usage }.
 */
export function createQuotaClient({ serviceUrl, persist, fetchImpl = fetch, now = () => Date.now(), offlineAllowance = 5 }) {
  const base = serviceUrl.replace(/\/+$/u, '');
  let deviceId = persist.setting('device_id');
  if (!deviceId) {
    deviceId = randomUUID();
    persist.setSetting('device_id', deviceId);
  }

  async function call(path, body) {
    const init = { redirect: 'error', signal: AbortSignal.timeout(requestTimeoutMs) };
    if (body !== undefined) {
      init.method = 'POST';
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    const response = await fetchImpl(base + path, init);
    const data = await response.json().catch(() => null);
    return { status: response.status, data };
  }

  async function publicKey() {
    // Trust on first use for the local stand-in. A shipped client would carry the key.
    let pem = persist.setting('service_public_key');
    if (!pem) {
      const { status, data } = await call('/v1/public-key');
      if (status !== 200 || typeof data?.publicKey !== 'string') throw new Error('No public key.');
      pem = data.publicKey;
      persist.setSetting('service_public_key', pem);
    }
    return pem;
  }

  async function report() {
    const events = persist.unreported();
    if (!events.length) return;
    const { status } = await call('/v1/usage/report', { deviceId, events });
    if (status === 200) persist.markReported(events.map(event => event.eventId));
  }

  async function newLease(time) {
    await report().catch(() => {});
    let result;
    try {
      result = await call('/v1/leases', { deviceId });
    } catch {
      return { kind: 'unreachable' };
    }
    if (result.status === 402) return { kind: 'limit', usage: cleanUsage(result.data?.usage) };
    if (result.status !== 200) return { kind: 'unreachable' };
    let pem;
    try {
      pem = await publicKey();
    } catch {
      return { kind: 'unreachable' };
    }
    const lease = readLease(result.data ?? {}, pem, deviceId, time);
    // A lease that fails verification is never spent; treat the service as unavailable.
    if (!lease) return { kind: 'unreachable' };
    persist.saveLease(lease);
    return { kind: 'lease' };
  }

  async function consumeNow() {
    const time = now();
    let lease = persist.activeLease(time);
    if (!lease) {
      const outcome = await newLease(time);
      if (outcome.kind === 'limit') return { ok: false, reason: 'limit', usage: outcome.usage };
      if (outcome.kind === 'unreachable') {
        if (persist.offlineCount() >= offlineAllowance) return { ok: false, reason: 'unreachable' };
        persist.spend(null, randomUUID(), time);
        return { ok: true, offline: true };
      }
      lease = persist.activeLease(time);
    }
    persist.spend(lease.id, randomUUID(), time);
    const used = lease.used + 1;
    // The last credit of a lease: report in the background, the reader does not wait.
    if (used >= lease.credits) report().catch(() => {});
    return { ok: true, usage: { used: Math.min(lease.limit, lease.usedAtIssue + used), limit: lease.limit, resetsAt: lease.resetsAt } };
  }

  // One handoff at a time, so two parallel reads never take two leases for one credit.
  let queue = Promise.resolve();
  return {
    deviceId,
    consume() {
      const next = queue.then(consumeNow);
      queue = next.catch(() => {});
      return next;
    },
    report,
  };
}
