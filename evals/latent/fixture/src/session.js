import { SESSION_HARD_CAP_SECONDS, SESSION_REFRESH_SECONDS, SESSION_TTL_SECONDS } from './config.js';

const sessions = new Map();

export function createSession(userId, now = Date.now()) {
  const id = `s-${userId}-${now}`;
  sessions.set(id, {
    userId,
    createdAt: now,
    expiresAt: now + SESSION_TTL_SECONDS * 1000,
  });
  return id;
}

// Sliding refresh: extend by the refresh window, capped from creation time.
export function refreshSession(id, now = Date.now()) {
  const session = sessions.get(id);
  if (!session || session.expiresAt <= now) return false;
  const capped = session.createdAt + SESSION_HARD_CAP_SECONDS * 1000;
  session.expiresAt = Math.min(now + SESSION_REFRESH_SECONDS * 1000, capped);
  return true;
}

export function isActive(id, now = Date.now()) {
  const session = sessions.get(id);
  return Boolean(session && session.expiresAt > now);
}

export function logout(id) {
  return sessions.delete(id);
}
