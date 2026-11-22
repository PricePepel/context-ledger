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
  // The sign-in page's own requests (its script, style and the redemption) carry no Referer.
  const fromSignIn = [];
  page.on('request', sent => { if (sent.frame() === page.mainFrame()) fromSignIn.push(sent); });
  await page.goto(baseURL + path);
  await expect(page).toHaveURL(baseURL + '/');
  // A successful search: a count or the empty archive, never an error (specs share one database).
  await expect(page.locator('#search-status')).toHaveText(searchDone);
  const signInRequests = fromSignIn.filter(sent => ['/login.js', '/session.js', '/styles.css', '/api/session'].includes(new URL(sent.url()).pathname));
  expect(signInRequests.map(sent => new URL(sent.url()).pathname).sort()).toEqual(expect.arrayContaining(['/api/session', '/login.js', '/session.js']));
  for (const sent of signInRequests) expect(await sent.headerValue('referer')).toBeNull();
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

  // A late 401 for an old session leaves a newer one in place (P1f review).
  expect(await late.evaluate(async key => {
    await ledgerSession.store('C'.repeat(43));
    await ledgerSession.forget({ 'X-Context-Ledger-Session': 'D'.repeat(43) });
    const kept = localStorage.getItem(key);
    localStorage.removeItem(key);
    return kept;
  }, storageKey)).toBe('C'.repeat(43));

  // A session the ledger no longer knows (a restart) is forgotten after its first 401.
  await late.evaluate(key => localStorage.setItem(key, 'B'.repeat(43)), storageKey);
  await late.reload();
  await expect(late.locator('#search-status')).toHaveText(signInHelp);
  expect(await late.evaluate(key => localStorage.getItem(key), storageKey)).toBeNull();
  await visitor.close();
  await other.close();
});

test('a page on another local port receives no credential and cannot read the session', async ({ page, request, baseURL }) => {
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

    // Script on that page, in the signed-in browser, can neither read the ledger's data,
    // nor redeem a code it got hold of, nor reach into a ledger window's storage.
    const path = await mint(request);
    const redemptions = [];
    page.on('response', answer => {
      if (new URL(answer.url()).pathname === '/api/session' && answer.request().method() === 'POST') redemptions.push(answer.status());
    });
    const tried = await page.evaluate(async ({ ledger, code, key }) => {
      const outcome = {};
      try { outcome.read = (await fetch(ledger + '/api/sessions')).status; } catch { outcome.read = 'blocked'; }
      try { outcome.redeem = (await fetch(ledger + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })).status; } catch { outcome.redeem = 'blocked'; }
      // A simple request is sent without a preflight; the ledger refuses its Origin unread.
      await fetch(ledger + '/api/session', { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ code }) }).catch(() => {});
      const opened = window.open(ledger + '/');
      await new Promise(resolve => setTimeout(resolve, 1500));
      try { outcome.storage = opened.localStorage.getItem(key); } catch { outcome.storage = 'denied'; }
      opened.close();
      return outcome;
    }, { ledger: baseURL, code: path.slice('/login?code='.length), key: storageKey });
    expect(tried).toEqual({ read: 'blocked', redeem: 'blocked', storage: 'denied' });
    // The simple POST reached the ledger and was refused for its Origin (the JSON one
    // never left the browser: its preflight failed).
    expect(redemptions).toEqual([403]);
    // The code was not used up: it still signs in from the ledger's own page.
    await page.goto(baseURL + path);
    await expect(page).toHaveURL(baseURL + '/');
    await expect(page.locator('#search-status')).toHaveText(searchDone);
  } finally {
    other.close();
  }
});
