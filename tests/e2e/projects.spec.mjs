import { mkdir } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

// Card U5: the library's project picker. Synthetic transcripts only.
const turn = text => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
const codexTurn = text => JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });

async function upload(page, { provider = 'claude', project = '', name, transcript }) {
  await page.getByLabel('Source agent').selectOption(provider);
  await page.getByLabel('Project', { exact: true }).fill(project);
  await page.getByLabel('Transcript file').setInputFiles({ name, mimeType: 'application/x-ndjson', buffer: Buffer.from(transcript) });
  await page.getByRole('button', { name: 'Import transcript' }).click();
}

test('import into projects, filter by project and agent, and refuse a bad slug before sending', async ({ page }) => {
  const tag = `u5${Date.now().toString(36)}`;
  const posts = [];
  page.on('request', request => { if (request.method() === 'POST') posts.push(request.postDataJSON()); });
  await page.goto('/');

  await upload(page, { project: `${tag}-orbit`, name: `${tag}-a.jsonl`, transcript: turn(`${tag} orbit plan`) });
  await expect(page.locator('#import-status')).toHaveText(`Imported ${tag}-a.jsonl into ${tag}-orbit.`);
  await expect(page.locator('#reader-source')).toContainText(`project ${tag}-orbit`);
  await upload(page, { provider: 'codex', project: `${tag}-orbit`, name: `${tag}-b.jsonl`, transcript: codexTurn(`${tag} orbit review`) });
  await expect(page.locator('#import-status')).toHaveText(`Imported ${tag}-b.jsonl into ${tag}-orbit.`);
  await upload(page, { project: `${tag}-atlas`, name: `${tag}-c.jsonl`, transcript: turn(`${tag} atlas plan`) });
  await expect(page.locator('#import-status')).toHaveText(`Imported ${tag}-c.jsonl into ${tag}-atlas.`);

  // A bad slug is refused in the browser, before any request.
  const before = posts.length;
  await upload(page, { project: 'Not A Slug', name: `${tag}-d.jsonl`, transcript: turn(`${tag} bad`) });
  await expect(page.locator('#import-status')).toHaveText('Import failed. A project is at most 64 lowercase letters, digits and single hyphens.');
  await expect(page.getByLabel('Project', { exact: true })).toBeFocused();
  expect(posts.length).toBe(before);

  // The filter lists the projects with their counts.
  const filter = page.getByLabel('Filter by project');
  await expect(filter.locator('option', { hasText: `${tag}-orbit (2)` })).toHaveCount(1);
  await expect(filter.locator('option', { hasText: `${tag}-atlas (1)` })).toHaveCount(1);

  await page.getByLabel('Search transcripts').fill(tag);
  await filter.selectOption(`${tag}-orbit`);
  const results = page.locator('#search-results li');
  await expect(results).toHaveCount(2);
  await expect(results.locator('.result-meta').first()).toContainText(`· ${tag}-orbit`);

  await page.getByLabel('Filter by agent').selectOption('codex');
  await expect(results).toHaveCount(1);
  await expect(results).toContainText(`${tag} orbit review`);

  await page.getByLabel('Filter by agent').selectOption('');
  await filter.selectOption(`${tag}-atlas`);
  await expect(results).toHaveCount(1);
  await expect(results).toContainText(`${tag} atlas plan`);

  await filter.selectOption('');
  await expect(results).toHaveCount(3);

  // An empty project field imports into default, and the message stays as before.
  await upload(page, { name: `${tag}-e.jsonl`, transcript: turn(`${tag} loose`) });
  await expect(page.locator('#import-status')).toHaveText(`Imported ${tag}-e.jsonl.`);
  expect(posts.at(-1).project).toBeUndefined();
  for (const slug of [`${tag}-orbit`, `${tag}-atlas`, 'default']) {
    await expect(page.locator(`#project-names option[value="${slug}"]`)).toHaveCount(1);
  }

  await filter.selectOption(`${tag}-orbit`);
  await expect(results).toHaveCount(2);
  if (process.env.LIBRARY_SHOTS_DIR) await mkdir(process.env.LIBRARY_SHOTS_DIR, { recursive: true });
  if (process.env.LIBRARY_SHOTS_DIR) await page.screenshot({ path: `${process.env.LIBRARY_SHOTS_DIR}/project-picker.png`, fullPage: true });
});
