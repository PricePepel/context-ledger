// P1e: the fixtures send the access token and sign the page in.
import { test, expect } from './fixtures.mjs';

// P1d: the reader's Delete button. Synthetic transcripts; the e2e server has its own database.
const transcript = text => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });

async function importSession(request, baseURL, source, text) {
  const response = await request.post('/api/import', { headers: { origin: baseURL }, data: { provider: 'claude', source, transcript: transcript(text) } });
  expect(response.ok()).toBe(true);
  return (await response.json()).session;
}

async function openFromSearch(page, word, title) {
  await page.getByLabel('Search transcripts').fill(word);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('button', { name: title, exact: true }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
}

test('deleting the open transcript asks first, and cancel keeps it', async ({ page, request, baseURL }) => {
  const title = 'Pelican synthetic delete check';
  const session = await importSession(request, baseURL, 'pelican.jsonl', title);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Delete transcript' })).toBeHidden();
  await openFromSearch(page, 'pelican', title);
  const deletes = [];
  page.on('request', sent => {
    if (sent.method() === 'DELETE') deletes.push(sent.url());
  });

  const dialogs = [];
  page.once('dialog', dialog => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  await page.getByRole('button', { name: 'Delete transcript' }).click();
  expect(dialogs).toEqual(['Delete this transcript from the ledger? This cannot be undone.']);
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  expect((await request.get(`/api/sessions/${session.id}`)).status()).toBe(200);
  expect(deletes).toEqual([]);

  page.once('dialog', dialog => void dialog.accept());
  await page.getByRole('button', { name: 'Delete transcript' }).click();
  await expect(page.getByText('Transcript deleted.', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No transcript selected' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete transcript' })).toBeHidden();
  await expect(page.getByText('No matching transcripts.')).toBeVisible();
  expect((await request.get(`/api/sessions/${session.id}`)).status()).toBe(404);
  expect(deletes).toEqual([`${baseURL}/api/sessions/${session.id}`]);
});

test('a refusal message is shown as text, never as markup', async ({ page, request, baseURL }) => {
  const title = 'Ibis synthetic markup check';
  const session = await importSession(request, baseURL, 'ibis.jsonl', title);
  await page.route(`**/api/sessions/${session.id}`, route => (route.request().method() === 'DELETE'
    ? route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: '<img src=x id=injected><b>bold</b>', graphs: 1 }) })
    : route.continue()));
  await page.goto('/');
  await openFromSearch(page, 'ibis', title);
  page.once('dialog', dialog => void dialog.accept());
  await page.getByRole('button', { name: 'Delete transcript' }).click();
  await expect(page.locator('#reader-status')).toHaveText('Delete failed. <img src=x id=injected><b>bold</b>');
  await expect(page.locator('#injected, #reader-status b, #reader-status img')).toHaveCount(0);
  expect((await request.get(`/api/sessions/${session.id}`)).status()).toBe(200);
});

test('a transcript a graph cites is not deleted, and the reader says why', async ({ page, request, baseURL }) => {
  const title = 'Heron synthetic cited check <b>bold</b>';
  const session = await importSession(request, baseURL, 'heron.jsonl', title);
  const graph = await request.post('/api/graphs', { headers: { origin: baseURL }, data: {
    version: 1, sessionId: session.id, nodes: [{ id: 'goal', kind: 'goal', label: 'Heron goal', evidenceLines: [1] }], edges: [],
  } });
  expect(graph.ok()).toBe(true);
  await page.goto('/');
  await openFromSearch(page, 'heron', title);

  page.once('dialog', dialog => void dialog.accept());
  await page.getByRole('button', { name: 'Delete transcript' }).click();
  await expect(page.getByText('Delete failed. This session is cited by 1 graph, so it cannot be deleted.', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await expect(page.locator('b')).toHaveCount(0);
  expect((await request.get(`/api/sessions/${session.id}`)).status()).toBe(200);
});
