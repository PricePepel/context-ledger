import { createHash } from 'node:crypto';
import { test, expect } from './fixtures.mjs';

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

test('makes imports idempotent and rejects an unreadable or foreign-origin import atomically', async ({ request, baseURL }) => {
  const transcript = asJsonl({ type: 'user', message: { role: 'user', content: 'Kepler uniqueness check' } });
  const data = { provider: 'claude', source: 'kepler.jsonl', transcript };
  const headers = { origin: baseURL };
  const first = await request.post('/api/import', { data, headers });
  const second = await request.post('/api/import', { data, headers });
  expect(first.ok()).toBe(true);
  expect(second.ok()).toBe(true);
  expect((await first.json()).session.id).toBe((await second.json()).session.id);

  const candidate = asJsonl({ type: 'user', message: { role: 'user', content: 'Discard this partial record' } });
  // Card I2: a file with no readable JSON line is still refused as a whole.
  const malformed = await request.post('/api/import', {
    headers,
    data: { ...data, transcript: 'Discard this partial record\n{invalid' },
  });
  expect(malformed.status()).toBe(400);
  expect((await malformed.json()).error).toBe('Invalid JSONL at line 1.');
  const foreign = await request.post('/api/import', {
    headers: { origin: 'https://foreign.example' },
    data: { ...data, transcript: candidate },
  });
  expect(foreign.status()).toBe(403);
  const list = await request.get('/api/sessions?q=discard');
  expect((await list.json()).sessions).toEqual([]);
  // Review rounds 1 and 2: neither rejected file was stored under its own ID. Checked by ID,
  // not by comparing whole lists, because other workers share the database.
  for (const rejected of ['Discard this partial record\n{invalid', candidate]) {
    const id = createHash('sha256').update('claude\0').update(rejected).digest('hex');
    expect((await request.get(`/api/sessions/${id}`)).status()).toBe(404);
  }
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

test('I2: an import with unreadable lines keeps the readable messages and says which lines it skipped', async ({ page, request, baseURL }) => {
  const transcript = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'Where does the Cygnus log go?' } }),
    'not json at all',
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Into cygnus.log.' }] } }),
    '{"type":"assistant","mess',
  ].join('\n');
  const response = await request.post('/api/import', { headers: { origin: baseURL }, data: { provider: 'claude', source: 'cygnus-api.jsonl', transcript } });
  expect(response.ok()).toBe(true);
  const body = await response.json();
  expect(body.skipped).toEqual({ count: 2, lines: [2, 4] });
  expect(body.session.messageCount).toBe(2);
  expect(body.session.skipped).toBeUndefined();

  await page.goto('/');
  await page.getByLabel('Source agent').selectOption('claude');
  await page.getByLabel('Transcript file').setInputFiles({ name: 'cygnus.jsonl', mimeType: 'application/x-ndjson', buffer: Buffer.from(transcript + '\n') });
  await page.getByRole('button', { name: 'Import transcript' }).click();
  await expect(page.getByText('Partially imported cygnus.jsonl: kept 2 messages, skipped 2 unreadable lines (2, 4). Messages on those lines are missing.', { exact: true })).toBeVisible();
  await expect(page.getByText('Line 3', { exact: true })).toBeVisible();
});

test('I1: a transcript of 8 MiB or more is refused in the browser with the command that imports it', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Source agent').selectOption('codex');
  await page.getByLabel('Transcript file').setInputFiles({ name: 'huge.jsonl', mimeType: 'application/x-ndjson', buffer: Buffer.alloc(8 * 1024 * 1024, 0x20) });
  await page.getByRole('button', { name: 'Import transcript' }).click();
  await expect(page.getByText("Import failed. This import is over the browser's 8 MiB limit; import it with: npm run ledger -- import --provider codex <file>", { exact: true })).toBeVisible();
});

test('I1 review: a file under 8 MiB that is too large once quoted gets the same command hint', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Source agent').selectOption('claude');
  // Every quote doubles when the file is sent as JSON, so 5 MiB of quotes is a 10 MiB request.
  await page.getByLabel('Transcript file').setInputFiles({ name: 'quotes.jsonl', mimeType: 'application/x-ndjson', buffer: Buffer.alloc(5 * 1024 * 1024, 0x22) });
  await page.getByRole('button', { name: 'Import transcript' }).click();
  await expect(page.getByText("Import failed. This import is over the browser's 8 MiB limit; import it with: npm run ledger -- import --provider claude <file>", { exact: true })).toBeVisible();
});

test('I3: a Codex message between agents is shown with who sent it to whom', async ({ page }) => {
  const transcript = asJsonl(
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Audit the Draco build.' }] } },
    { type: 'response_item', payload: { type: 'agent_message', author: '/root/worker', recipient: '/root', content: [
      { type: 'input_text', text: 'Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/worker\nPayload:\nDraco audit is clean.' },
      { type: 'encrypted_content', encrypted_content: 'enc_synthetic' },
    ] } },
  );
  await page.goto('/');
  await upload(page, 'codex', 'draco-codex.jsonl', transcript);
  await expect(page.getByText('Agent /root/worker to /root', { exact: true })).toBeVisible();
  await expect(page.getByText('Line 2', { exact: true })).toBeVisible();
  await expect(page.getByText(/Draco audit is clean\./u)).toBeVisible();
  await expect(page.getByText(/enc_synthetic/u)).toHaveCount(0);
});

test('I3 review: an agent path with a bidi control is shown escaped', async ({ page }) => {
  const rlo = String.fromCodePoint(0x202e);
  const transcript = asJsonl(
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Audit Pyxis.' }] } },
    { type: 'response_item', payload: { type: 'agent_message', author: `/root/${rlo}evil`, recipient: '/root', content: [{ type: 'input_text', text: 'Pyxis is clean.' }] } },
  );
  await page.goto('/');
  await upload(page, 'codex', 'pyxis-codex.jsonl', transcript);
  await expect(page.getByText('Agent /root/\\u202eevil to /root', { exact: true })).toBeVisible();
});

// Card U8: the library takes the console's pixel look; nothing about how it works changes.
test('U8: the library loads the console fonts, sits in the framed sheet and links to the other pages', async ({ page }) => {
  const hosts = new Set();
  page.on('request', item => hosts.add(new URL(item.url()).host));
  await page.goto('/');
  const look = await page.evaluate(async () => {
    await document.fonts.ready;
    return {
      heading: getComputedStyle(document.querySelector('h1')).fontFamily,
      body: getComputedStyle(document.body).fontFamily,
      loaded: [...document.fonts].filter(font => font.status === 'loaded').map(font => font.family.replaceAll('"', '')).sort(),
      frame: getComputedStyle(document.querySelector('.shell')).boxShadow !== 'none',
      button: getComputedStyle(document.querySelector('#import-form .primary')).borderRadius,
    };
  });
  expect(look.heading).toContain('Jersey 15');
  expect(look.body).toContain('Inter Tight');
  expect(look.loaded).toEqual(expect.arrayContaining(['Inter Tight', 'Jersey 15']));
  expect(look.frame).toBe(true);
  expect(look.button).toBe('0px');
  await expect(page.getByRole('link', { name: 'Console' })).toHaveAttribute('href', '/console/');
  await expect(page.getByRole('link', { name: 'Swarm' })).toHaveAttribute('href', '/swarm/');
  // The page links stay direct children of the masthead: no new landmark was added.
  expect(await page.locator('.masthead > a.console-link').count()).toBe(2);
  expect(await page.locator('.masthead nav').count()).toBe(0);
  expect([...hosts]).toEqual([new URL(page.url()).host]);
  // On a phone the framed sheet still has no sideways scroll.
  await page.setViewportSize({ width: 390, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
