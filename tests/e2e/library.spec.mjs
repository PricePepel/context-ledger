import { test, expect } from '@playwright/test';

const asJsonl = (...records) => records.map(record => JSON.stringify(record)).join('\n');
const claude = asJsonl(
  { type: 'user', message: { role: 'user', content: 'How do we deploy Atlas?' } },
  { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'PRIVATE TOOL OUTPUT' }] } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Use the staging lane. <script>unsafe()</script>' }] } },
);
const codex = asJsonl(
  { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'PRIVATE DEVELOPER NOTE' }] } },
  { type: 'response_item', payload: { type: 'message', role: 'user', content: [
    { type: 'input_text', text: '<environment_context>\nPRIVATE ENVIRONMENT NOTE\n</environment_context>' },
    { type: 'input_text', text: 'Atlas deployment checklist' },
  ] } },
  { type: 'response_item', payload: { type: 'message', role: 'user', content: [
    { type: 'input_text', text: '# AGENTS.md instructions\n\n<INSTRUCTIONS>PRIVATE BOOTSTRAP NOTE</INSTRUCTIONS>' },
  ] } },
  { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Add the smoke test.' }] } },
);

async function upload(page, provider, filename, transcript) {
  await page.getByLabel('Source agent').selectOption(provider);
  await page.getByLabel('Transcript file').setInputFiles({
    name: filename,
    mimeType: 'application/x-ndjson',
    buffer: Buffer.from(transcript),
  });
  await page.getByRole('button', { name: 'Import transcript' }).click();
  await expect(page.getByText(`Imported ${filename}.`, { exact: true })).toBeVisible();
}

test('imports both agents, searches across messages and opens a cited transcript', async ({ page }) => {
  await page.goto('/');
  await upload(page, 'claude', 'atlas-claude.jsonl', claude);
  await expect(page.getByText('Line 3', { exact: true })).toBeVisible();
  await expect(page.getByText('Use the staging lane. <script>unsafe()</script>')).toBeVisible();
  await expect(page.getByText('PRIVATE TOOL OUTPUT')).toHaveCount(0);
  await upload(page, 'codex', 'atlas-codex.jsonl', codex);
  await expect(page.getByText('Line 2', { exact: true })).toBeVisible();
  await expect(page.getByText('PRIVATE DEVELOPER NOTE')).toHaveCount(0);
  await expect(page.getByText(/PRIVATE (ENVIRONMENT|BOOTSTRAP) NOTE/)).toHaveCount(0);

  await page.getByLabel('Search transcripts').fill('ATLAS staging');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('button', { name: 'How do we deploy Atlas?', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Atlas deployment checklist', exact: true })).toHaveCount(0);

  await page.getByLabel('Search transcripts').fill('atlas');
  await page.getByLabel('Filter by agent').selectOption('codex');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('button', { name: 'Atlas deployment checklist', exact: true }).click();
  await expect(page.getByText('Add the smoke test.')).toBeVisible();

  await page.getByLabel('Search transcripts').fill('no such deployment');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByText('No matching transcripts.')).toBeVisible();
});

test('makes imports idempotent and rejects a malformed or foreign-origin import atomically', async ({ request, baseURL }) => {
  const transcript = asJsonl({ type: 'user', message: { role: 'user', content: 'Kepler uniqueness check' } });
  const data = { provider: 'claude', source: 'kepler.jsonl', transcript };
  const headers = { origin: baseURL };
  const first = await request.post('/api/import', { data, headers });
  const second = await request.post('/api/import', { data, headers });
  expect(first.ok()).toBe(true);
  expect(second.ok()).toBe(true);
  expect((await first.json()).session.id).toBe((await second.json()).session.id);

  const candidate = asJsonl({ type: 'user', message: { role: 'user', content: 'Discard this partial record' } });
  const malformed = await request.post('/api/import', {
    headers,
    data: { ...data, transcript: `${candidate}\n{invalid` },
  });
  expect(malformed.status()).toBe(400);
  const foreign = await request.post('/api/import', {
    headers: { origin: 'https://foreign.example' },
    data: { ...data, transcript: candidate },
  });
  expect(foreign.status()).toBe(403);
  const list = await request.get('/api/sessions?q=discard');
  expect((await list.json()).sessions).toEqual([]);
  const repeated = await request.get('/api/sessions?q=kepler');
  expect((await repeated.json()).sessions).toHaveLength(1);
});

// Cycle 10: list paging is opt-in, so the library still shows every match.
test('the library search lists all 150 matching transcripts', async ({ page, request, baseURL }) => {
  const keyword = `nebula${Date.now().toString(36)}`;
  for (let index = 0; index < 150; index += 1) {
    const transcript = asJsonl({ type: 'user', message: { role: 'user', content: `Synthetic ${keyword} transcript ${index}` } });
    const imported = await request.post('/api/import', { headers: { origin: baseURL }, data: { provider: 'claude', source: `n${index}.jsonl`, transcript } });
    expect(imported.ok()).toBe(true);
  }
  await page.goto('/');
  await page.getByLabel('Search transcripts').fill(keyword);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByText('150 transcripts', { exact: true })).toBeVisible();
});
