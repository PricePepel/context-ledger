// P1e and P1f: the browser signs in with a one-time link, keeps a session secret in the
// ledger origin's own storage and sends it as a header; it never holds a cookie, so a
// page on another local port receives nothing.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, ledgerToken, test } from './fixtures.mjs';

const signInHelp = 'Search failed. Sign in first: run npm run ledger -- login and open the link it prints.';
const storageKey = 'context-ledger-session';
const searchDone = /^(\d+ transcripts?|The archive is empty\. Add a transcript to get started\.)$/u;

async function mint(request) {
  const minted = await request.post('/api/login');
  expect(minted.status()).toBe(200);
  const { path } = await minted.json();
  expect(path).toMatch(/^\/login\?code=[A-Za-z0-9_-]{43}$/u);
  return path;
}

test('a browser without a session is told how to sign in; a one-time link signs it in once', async ({ browser, request, baseURL }) => {
  const visitor = await browser.newContext();
  // A P1e cookie left from before P1f is removed at sign-in.
  await visitor.addCookies([{ name: 'context_ledger_4318', value: 'A'.repeat(43), domain: '127.0.0.1', path: '/' }]);
  const page = await visitor.newPage();
  await page.goto(baseURL + '/');
  await expect(page.locator('#search-status')).toHaveText(signInHelp);

  const path = await mint(request);
  expect(path).not.toContain(await ledgerToken());
  await page.goto(baseURL + path);
  await expect(page).toHaveURL(baseURL + '/');
  // A successful search: a count or the empty archive, never an error (specs share one database).
  await expect(page.locator('#search-status')).toHaveText(searchDone);
  expect(await visitor.cookies()).toEqual([]);
  const stored = await page.evaluate(key => localStorage.getItem(key), storageKey);
  expect(stored).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(stored).not.toBe(await ledgerToken());
  // The code left the address bar and the history entry.
  await page.goBack();
  expect(page.url()).not.toContain('code=');

  // The link is used up: a second browser stays signed out and holds nothing.
  const other = await browser.newContext();
  const late = await other.newPage();
  await late.goto(baseURL + path);
  await expect(late.locator('#sign-in-status')).toHaveText('This sign-in link was already used, has expired or is not valid. Run npm run ledger -- login for a new one.');
  expect(late.url()).toBe(baseURL + '/login');
  expect(await late.evaluate(key => localStorage.getItem(key), storageKey)).toBeNull();
  await late.goto(baseURL + '/');
  await expect(late.locator('#search-status')).toHaveText(signInHelp);
  expect(await other.cookies()).toEqual([]);

  // A session the ledger no longer knows (a restart) is forgotten after its first 401.
  await late.evaluate(key => localStorage.setItem(key, 'B'.repeat(43)), storageKey);
  await late.reload();
  await expect(late.locator('#search-status')).toHaveText(signInHelp);
  expect(await late.evaluate(key => localStorage.getItem(key), storageKey)).toBeNull();
  await visitor.close();
  await other.close();
});

test('a page on another local port receives no credential and cannot read the session', async ({ page, baseURL }) => {
  // The fixture signed this page in. Another local program serves a page on its own port.
  await page.goto(baseURL + '/');
  await expect(page.locator('#search-status')).toHaveText(searchDone);
  const session = await page.evaluate(key => localStorage.getItem(key), storageKey);
  expect(session).toMatch(/^[A-Za-z0-9_-]{43}$/u);

  const seen = [];
  const other = createServer((request, response) => {
    seen.push(request.headers);
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>Another local page</title><p>Synthetic page.</p>');
  });
  other.listen(0, '127.0.0.1');
  await once(other, 'listening');
  try {
    const foreign = `http://127.0.0.1:${other.address().port}`;
    await page.goto(foreign + '/');
    // Back and forth, still signed in: under P1e each visit carried the ledger's cookie.
    await page.goto(baseURL + '/');
    await expect(page.locator('#search-status')).toHaveText(searchDone);
    await page.goto(foreign + '/');
    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const headers of seen) {
      expect(headers.cookie).toBeUndefined();
      expect(headers['x-context-ledger-session']).toBeUndefined();
      expect(JSON.stringify(headers)).not.toContain(session);
    }
    // The other origin's storage is its own.
    expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBeNull();
  } finally {
    other.close();
  }
});
