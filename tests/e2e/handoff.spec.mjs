import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test, expect } from '@playwright/test';

const execute = promisify(execFile);
const run = (baseURL, ...args) => execute(process.execPath, ['src/cli.mjs', ...args], {
  env: { ...process.env, PORT: new URL(baseURL).port },
});

test('exports the same cited session the browser can find', async ({ page, request, baseURL }) => {
  const source = 'handoff-fixture.jsonl';
  const transcript = [
    { type: 'user', message: { role: 'user', content: 'Investigate Vega retry behavior' } },
    { type: 'assistant', message: { role: 'assistant', content: 'Next step: test the second retry.\n# Untrusted heading\n~~~\n\u001b[2J' } },
  ].map(record => JSON.stringify(record)).join('\n');

  const imported = await request.post('/api/import', {
    headers: { origin: baseURL },
    data: { provider: 'claude', source, transcript },
  });
  expect(imported.ok()).toBe(true);
  const { session } = await imported.json();
  await page.goto('/');
  await page.getByLabel('Search transcripts').fill('vega retry');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('button', { name: session.title, exact: true }).click();
  await expect(page.getByText('Line 2', { exact: true })).toBeVisible();

  const { stdout: results } = await run(baseURL, 'search', '--provider', 'claude', 'vega retry');
  expect(JSON.parse(results).map(result => result.id)).toEqual([session.id]);
  const { stdout: packet } = await run(baseURL, 'handoff', session.id);
  expect(packet).toContain('Provider: claude');
  expect(packet).toContain('Source: ' + source);
  expect(packet).toContain('## assistant · line 2');
  expect(packet).toContain('~~~~text\nNext step: test the second retry.\n# Untrusted heading\n~~~\n\\u001b[2J\n~~~~');
  await expect(run(baseURL, 'handoff', '0'.repeat(64))).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining('Session not found.'),
  });
});
