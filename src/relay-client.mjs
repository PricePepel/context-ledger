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
  return hostname === 'localhost' || hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/u.test(hostname);
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

async function call(origin, path, init = {}) {
  try {
    return await fetch(origin + path, { ...init, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new Error(unreachable);
  }
}

const authorized = secret => ({ Authorization: `Bearer ${accessToken(secret)}` });

/** Throws unless the address answers as a relay of this version. */
export async function checkRelay(origin) {
  const response = await call(origin, '/v1/health');
  const data = response.ok ? await response.json().catch(() => null) : null;
  if (data?.relay !== relayName || data?.version !== relayVersion) {
    throw new Error('That address does not answer as a Context Ledger relay.');
  }
}

/** Puts a sealed parcel in the box of this secret. */
export async function sendSealed(origin, secret, sealed) {
  const response = await call(origin, '/v1/parcel', {
    method: 'PUT', headers: { ...authorized(secret), 'Content-Type': 'application/octet-stream' }, body: sealed,
  });
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
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maxSealedBytes) throw new Error('too large');
      chunks.push(chunk);
    }
  } catch {
    throw new Error(size > maxSealedBytes ? 'The relay sent more than a parcel can hold. Nothing was stored.' : unreachable);
  }
  return Buffer.concat(chunks);
}

/** Deletes the box of this secret; false when the relay could not be asked or said no. */
export async function deleteSealed(origin, secret) {
  try {
    const response = await call(origin, '/v1/parcel', { method: 'DELETE', headers: authorized(secret) });
    return response.status === 204 || response.status === 404;
  } catch {
    return false;
  }
}
