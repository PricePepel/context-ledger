// P1e: the browser signs in with a one-time link and then holds only an HttpOnly cookie.
import { expect, ledgerToken, test } from './fixtures.mjs';

const signInHelp = 'Search failed. Sign in first: run npm run ledger -- login and open the link it prints.';

test('a browser without a session is told how to sign in; a one-time link signs it in once', async ({ browser, request, baseURL }) => {
  const visitor = await browser.newContext();
  const page = await visitor.newPage();
  await page.goto(baseURL + '/');
  await expect(page.locator('#search-status')).toHaveText(signInHelp);
  expect(await visitor.cookies()).toEqual([]);

  const minted = await request.post('/api/login');
  expect(minted.status()).toBe(200);
  const { path } = await minted.json();
  expect(path).toMatch(/^\/login\?code=[A-Za-z0-9_-]{43}$/u);
  expect(path).not.toContain(await ledgerToken());

  await page.goto(baseURL + path);
  await expect(page).toHaveURL(baseURL + '/');
  // A successful search: a count or the empty archive, never an error (specs share one database).
  await expect(page.locator('#search-status')).toHaveText(/^(\d+ transcripts?|The archive is empty\. Add a transcript to get started\.)$/u);
  const cookies = await visitor.cookies();
  expect(cookies).toHaveLength(1);
  expect(cookies[0]).toMatchObject({ name: 'context_ledger_4318', domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict' });
  expect(cookies[0].value).not.toBe(await ledgerToken());
  // Page scripts cannot read the cookie.
  expect(await page.evaluate(() => document.cookie)).toBe('');

  // The link is used up: a second browser gets 401 and no cookie.
  const other = await browser.newContext();
  const late = await other.newPage();
  const response = await late.goto(baseURL + path);
  expect(response.status()).toBe(401);
  expect(await other.cookies()).toEqual([]);
  await late.goto(baseURL + '/');
  await expect(late.locator('#search-status')).toHaveText(signInHelp);
  await visitor.close();
  await other.close();
});
