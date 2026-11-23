// Card R2 (ADR-20): what `ledger share --relay` and `ledger receive --from` do with a
// relay. The relay is not trusted: a parcel is sealed here with a key the relay never
// gets, and anything the relay answers is treated as data. Errors are fixed sentences.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { InputError } from './errors.mjs';
import { maxSealedBytes, relayName, relayVersion } from './relay.mjs';

const magic = Buffer.from('CLR1', 'ascii');
const nonceBytes = 12;
const tagBytes = 16;
// Bound into the seal, so bytes sealed for anything else never open as a parcel.
const sealedAs = Buffer.from('context-ledger relay parcel v1', 'ascii');
const secretPattern = /^[A-Za-z0-9_-]{43}$/u;

const derive = (secret, purpose) => Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), `context-ledger relay v1 ${purpose}`, 32));

/** A fresh 32-byte secret for one parcel. */
export const newSecret = () => randomBytes(32);

/** The token the relay files a parcel under. It tells the relay nothing about the key. */
export const accessToken = secret => derive(secret, 'access').toString('base64url');

/** The parcel text sealed with AES-256-GCM: "CLR1", a random nonce, the ciphertext and the tag. */
export function sealParcel(secret, text) {
  const nonce = randomBytes(nonceBytes);
  const cipher = createCipheriv('aes-256-gcm', derive(secret, 'key'), nonce);
  cipher.setAAD(sealedAs);
  const sealed = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return Buffer.concat([magic, nonce, sealed, cipher.getAuthTag()]);
}

const notOpened = 'This code does not open what the relay holds. Nothing was stored.';

/** The parcel bytes from a sealed parcel, or an InputError when the secret or the bytes are wrong. */
export function openParcel(secret, sealed) {
  if (sealed.length < magic.length + nonceBytes + tagBytes + 1 || !sealed.subarray(0, magic.length).equals(magic)) {
    throw new InputError(notOpened);
  }
  const nonce = sealed.subarray(magic.length, magic.length + nonceBytes);
  const decipher = createDecipheriv('aes-256-gcm', derive(secret, 'key'), nonce);
  decipher.setAAD(sealedAs);
  decipher.setAuthTag(sealed.subarray(sealed.length - tagBytes));
  try {
    return Buffer.concat([decipher.update(sealed.subarray(magic.length + nonceBytes, sealed.length - tagBytes)), decipher.final()]);
  } catch {
    throw new InputError(notOpened);
  }
}

const badAddress = 'The relay address must be an http or https address with no path, such as http://192.168.1.20:4319.';

/** The origin of a relay address a person typed, or an InputError. */
export function relayOrigin(text) {
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new InputError(badAddress);
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash || !url.hostname) {
    throw new InputError(badAddress);
  }
  return url.origin;
}

/** True when only this machine can reach the address. */
export function isLoopback(origin) {
  const { hostname } = new URL(origin);
  return /^(?:[^.]+\.)*localhost\.?$/u.test(hostname) || hostname === '[::1]' || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/u.test(hostname)
    || /^127\.\d+\.\d+\.\d+$/u.test(hostname);
}

/** The one line a sender passes on: the relay address with the secret as its fragment. */
export const formatCode = (origin, secret) => `${origin}/#${secret.toString('base64url')}`;

const badCode = 'That is not a Context Ledger relay code.';

/** The relay origin and the secret of a code, or an InputError. */
export function parseCode(code) {
  const at = typeof code === 'string' ? code.indexOf('#') : -1;
  if (at < 0) throw new InputError(badCode);
  const fragment = code.slice(at + 1);
  if (!secretPattern.test(fragment)) throw new InputError(badCode);
  const secret = Buffer.from(fragment, 'base64url');
  // Only the canonical spelling of 32 bytes, so one secret has one code.
  if (secret.length !== 32 || secret.toString('base64url') !== fragment) throw new InputError(badCode);
  let origin;
  try {
    origin = relayOrigin(code.slice(0, at));
  } catch {
    throw new InputError(badCode);
  }
  return { origin, secret };
}

const unreachable = 'Cannot reach the relay. Check the address and that the relay is running.';
const tooSlow = 'The relay did not finish in time. Try again, or use a relay on a faster connection.';
// A whole parcel may travel in one call; a health check is a few bytes.
const transferMs = 180_000;
const healthMs = 10_000;

// A redirect is never followed, so a relay cannot send a token or a parcel elsewhere. The
// answer is asked for as it is, so a small reply cannot unpack into a large one.
async function call(origin, path, init = {}, timeoutMs = transferMs) {
  try {
    return await fetch(origin + path, {
      ...init, headers: { 'Accept-Encoding': 'identity', ...init.headers }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(error?.name === 'TimeoutError' ? tooSlow : unreachable);
  }
}

/** The body of an answer, or null once it passes `limit` bytes; an unreadable body rejects. */
async function readBody(response, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > limit) {
      await response.body.cancel().catch(() => {});
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const authorized = secret => ({ Authorization: `Bearer ${accessToken(secret)}` });

/** Throws unless the address answers as a relay of this version. */
export async function checkRelay(origin) {
  const response = await call(origin, '/v1/health', {}, healthMs);
  let data = null;
  try {
    // A relay's answer is a few dozen bytes; nothing longer is read.
    const body = response.ok ? await readBody(response, 1024) : null;
    data = body && JSON.parse(body.toString('utf8'));
  } catch {
    data = null;
  }
  if (data?.relay !== relayName || data?.version !== relayVersion) {
    throw new Error('That address does not answer as a Context Ledger relay.');
  }
}

/**
 * Puts a sealed parcel in the box of this secret. When the relay may have stored it but
 * did not say so, the box is deleted again, because nobody will hold its code.
 */
export async function sendSealed(origin, secret, sealed) {
  let response;
  try {
    response = await call(origin, '/v1/parcel', {
      method: 'PUT', headers: { ...authorized(secret), 'Content-Type': 'application/octet-stream' }, body: sealed,
    });
  } catch (error) {
    await deleteSealed(origin, secret);
    throw error;
  }
  if (response.status === 201) return;
  if (response.status === 413) throw new Error('The parcel is too large for the relay.');
  if (response.status === 507) throw new Error('The relay is full. Try again later, or use another relay.');
  throw new Error(`The relay returned HTTP ${response.status}.`);
}

/** The sealed parcel in the box of this secret; at most what a relay may hold is read. */
export async function fetchSealed(origin, secret) {
  const response = await call(origin, '/v1/parcel', { headers: authorized(secret) });
  if (response.status === 404) {
    throw new Error('The relay holds no parcel for this code. It may have been received already, or have expired.');
  }
  if (response.status !== 200 || !response.body) throw new Error(`The relay returned HTTP ${response.status}.`);
  let sealed;
  try {
    sealed = await readBody(response, maxSealedBytes);
  } catch (error) {
    throw new Error(error?.name === 'TimeoutError' ? tooSlow : unreachable);
  }
  if (sealed === null) throw new Error('The relay sent more than a parcel can hold. Nothing was stored.');
  return sealed;
}

/** Deletes the box of this secret; false when the relay could not be asked or said no. */
export async function deleteSealed(origin, secret) {
  try {
    const response = await call(origin, '/v1/parcel', { method: 'DELETE', headers: authorized(secret) }, healthMs);
    return response.status === 204 || response.status === 404;
  } catch {
    return false;
  }
}
