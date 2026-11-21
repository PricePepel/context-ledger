import { mkdir, writeFile } from 'node:fs/promises';
// P1e: the fixtures send the access token and sign the page in.
import { expect, test } from './fixtures.mjs';

// Card U1: the console. The demo replays the bundled synthetic recording; the live
// check publishes its own synthetic graph. Screenshots and the weight and paint
// numbers go to CONSOLE_SHOTS_DIR (default test-results/console).
const shotsDir = process.env.CONSOLE_SHOTS_DIR ?? 'test-results/console';
const rlo = String.fromCodePoint(0x202e);

/** Fail the test if the page sends anything but GET. */
function watchRequests(page) {
  const methods = [];
  page.on('request', request => methods.push(`${request.method()} ${new URL(request.url()).pathname}`));
  const writes = () => methods.filter(entry => !entry.startsWith('GET '));
  writes.paths = () => methods.map(entry => entry.slice(entry.indexOf(' ') + 1));
  return writes;
}

test('the demo plays from empty to finished, and one click shows the proof', async ({ page }) => {
  await mkdir(shotsDir, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  const writes = watchRequests(page);
  await page.goto('/console/?demo&autoplay=0&speed=1.5');
  await expect(page.locator('body')).toHaveAttribute('data-demo', 'ready');
  await expect(page.locator('.brain-empty')).toBeVisible();
  await expect(page.locator('.office-agent')).toHaveCount(0);
  await page.screenshot({ path: `${shotsDir}/01-empty.png` });

  await page.getByRole('button', { name: 'Play demo' }).click();
  // Mid-run: Ali's second publish links to two of Leo's nodes, so a read line flashes.
  await expect(page.locator('.flash-line.flash-read').first()).toBeVisible({ timeout: 20_000 });
  // Visible means drawn: a coloured stroke that has not faded out yet.
  // The line fades in, so wait for it to reach a drawn opacity rather than sample once.
  const flashLine = page.locator('.flash-line.flash-read').first();
  await expect.poll(() => flashLine.evaluate(line => Number(getComputedStyle(line).opacity)), { timeout: 2000, intervals: [50] })
    .toBeGreaterThan(0.5);
  expect(await flashLine.evaluate(line => getComputedStyle(line).stroke)).not.toBe('none');
  await expect(page.locator('.office-agent[data-state="working"]')).toHaveCount(1);
  await page.screenshot({ path: `${shotsDir}/02-mid-run.png` });

  await expect(page.locator('body')).toHaveAttribute('data-demo', 'finished', { timeout: 30_000 });
  await expect(page.locator('.flash-line')).toHaveCount(0);
  await expect(page.locator('#n-handoffs')).toHaveText('6');
  await expect(page.locator('#n-tokens')).toHaveText('≈ 1,546');
  await expect(page.locator('#n-superseded')).toHaveText('1');
  await expect(page.locator('.office-agent')).toHaveCount(2);
  await expect(page.locator('.office-agent[data-state="waiting"]')).toHaveAttribute('aria-label', /leo/u);
  await expect(page.locator('.node')).toHaveCount(11);
  await expect(page.locator('.node.is-superseded')).toContainText('port 4400');
  await expect(page.locator('.node[data-mark="none"]')).toHaveCount(11);
  await page.screenshot({ path: `${shotsDir}/03-finished.png`, fullPage: true });

  // Keyboard: focus the node and press Enter; focus stays on the node.
  const node = page.getByRole('button', { name: /The ledger stays on port 4317/u });
  await node.focus();
  await page.keyboard.press('Enter');
  await expect(node).toBeFocused();
  await expect(node).toHaveAttribute('aria-pressed', 'true');
  const evidence = page.locator('#evidence');
  await expect(evidence.locator('#evidence-heading')).toHaveText('The ledger stays on port 4317');
  await expect(evidence.locator('.turn.is-cited')).toHaveCount(2);
  await expect(evidence.locator('.turn.is-cited mark')).toContainText(['Change of plan: the ledger stays on port 4317', 'supersedes the earlier choice']);
  await expect(evidence.locator('.turn-line').first()).toHaveText('L26');
  await expect(evidence).toContainText('leo-orbit.jsonl');
  await page.screenshot({ path: `${shotsDir}/04-evidence.png`, fullPage: true });

  // Replay starts again from empty, with the evidence panel cleared.
  await page.getByRole('button', { name: 'Replay demo' }).click();
  await expect(page.locator('.brain-empty')).toBeVisible();
  await expect(evidence.locator('.turn')).toHaveCount(0);
  expect(writes()).toEqual([]);
  // The demo needs no ledger: it never calls the API.
  expect(writes.paths().filter(path => !path.startsWith('/console'))).toEqual([]);
});

test('the page is under 300 KB and paints in under a second', async ({ page }) => {
  await mkdir(shotsDir, { recursive: true });
  const files = {};
  page.on('response', async response => {
    const body = await response.body().catch(() => Buffer.alloc(0));
    files[new URL(response.url()).pathname] = body.length;
  });
  await page.goto('/console/?demo&autoplay=0', { waitUntil: 'load' });
  await expect(page.locator('body')).toHaveAttribute('data-demo', 'ready');
  await page.waitForLoadState('networkidle');
  const timing = await page.evaluate(async () => {
    const [navigation] = performance.getEntriesByType('navigation');
    // A buffered observer also returns paint entries recorded before it was made.
    const entries = await new Promise(resolve => {
      new PerformanceObserver((list, observer) => { observer.disconnect(); resolve(list.getEntries()); })
        .observe({ type: 'paint', buffered: true });
      setTimeout(() => resolve(performance.getEntriesByType('paint')), 2000);
    });
    const paint = Object.fromEntries(entries.map(entry => [entry.name, entry.startTime]));
    return {
      firstPaintMs: Math.round(paint['first-paint']),
      firstContentfulPaintMs: Math.round(paint['first-contentful-paint']),
      domContentLoadedMs: Math.round(navigation.domContentLoadedEventEnd),
      loadMs: Math.round(navigation.loadEventEnd),
    };
  });
  const totalBytes = Object.values(files).reduce((sum, size) => sum + size, 0);
  const report = {
    measuredAt: new Date().toISOString(),
    how: 'Playwright Chromium against the loopback server, demo mode, cache off (the server sends no-store). Bytes are response bodies, uncompressed.',
    totalBytes,
    totalKiB: Math.round(totalBytes / 102.4) / 10,
    files,
    ...timing,
  };
  await writeFile(`${shotsDir}/perf.json`, JSON.stringify(report, null, 2) + '\n');
  expect(Object.keys(files).every(path => path === '/console/' || path.startsWith('/console/'))).toBe(true);
  expect(totalBytes).toBeLessThan(300 * 1024);
  expect(timing.firstContentfulPaintMs).toBeLessThan(1000);
});

test('live mode shows a graph published while the page is open, and renders its text as text', async ({ page, request, baseURL }) => {
  const writes = watchRequests(page);
  await page.goto('/console/');
  await expect(page.locator('#status')).toContainText('Live: watching the ledger');

  const marker = `console-live-${Date.now()}`;
  // Labels may not hold bidi controls (the schema refuses them); transcripts may.
  const hostile = '<img src=x onerror="window.__pwned=1">';
  const codexTurn = (role, text) => JSON.stringify({
    type: 'response_item',
    payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] },
  });
  const transcript = [codexTurn('user', `Plan the ${marker} check.`), codexTurn('assistant', `Decided ${hostile} ${rlo}evil for ${marker}.`)].join('\n');
  const imported = await request.post('/api/import', { headers: { origin: baseURL }, data: { provider: 'codex', source: `${marker}.jsonl`, transcript } });
  expect(imported.ok(), await imported.text()).toBe(true);
  const { session } = await imported.json();
  const party = `live-${Date.now().toString(36)}`;
  const published = await request.post('/api/graphs', {
    headers: { origin: baseURL },
    data: { version: 2, sessionId: session.id, party, nodes: [{ id: 'hostile', kind: 'decision', label: `Use ${hostile}`, evidenceLines: [2] }], edges: [] },
  });
  expect(published.ok(), await published.text()).toBe(true);

  const node = page.locator('.node', { hasText: 'onerror' });
  await expect(node).toBeVisible({ timeout: 3500 });
  await expect(page.locator(`.office-agent[aria-label*="${party}"]`)).toHaveAttribute('data-state', 'working');
  await expect(page.locator('#activity')).toContainText(`${party} (Codex) published: 1 new`);
  await node.click();
  await expect(page.locator('.turn.is-cited mark')).toContainText('<img src=x onerror=');
  // The right-to-left override is shown as an escape, so it cannot reorder the proof.
  await expect(page.locator('.turn.is-cited mark')).toContainText(`${String.fromCodePoint(0x5c)}u202eevil`);
  await expect(page.locator('.turn.is-cited mark')).not.toContainText(rlo);
  expect(await page.locator('main img, #evidence img').count()).toBe(0);
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  expect(writes()).toEqual([]);
});

test('on a phone the parts stack with no sideways scroll', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/console/?demo&speed=8');
  await expect(page.locator('body')).toHaveAttribute('data-demo', 'finished', { timeout: 15_000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  const office = await page.locator('.office').boundingBox();
  const brain = await page.locator('.brain').boundingBox();
  const evidence = await page.locator('.evidence').boundingBox();
  expect(brain.y).toBeGreaterThan(office.y + office.height - 1);
  expect(evidence.y).toBeGreaterThan(brain.y + brain.height - 1);
  await expect(page.locator('.flash-line')).toHaveCount(0);
  if (process.env.CONSOLE_SHOTS_DIR) await page.screenshot({ path: `${shotsDir}/05-phone.png`, fullPage: true });
});

test('P2b review: a version 3 node that cites only an artifact shows it in the evidence panel, as text', async ({ page, request, baseURL }) => {
  const writes = watchRequests(page);
  await page.goto('/console/');
  await expect(page.locator('#status')).toContainText('Live: watching the ledger');
  const marker = `console-artifact-${Date.now()}`;
  const imported = await request.post('/api/import', { headers: { origin: baseURL },
    data: { provider: 'claude', source: `${marker}.jsonl`, transcript: JSON.stringify({ type: 'user', message: { role: 'user', content: `Write the ${marker} doc.` } }) } });
  expect(imported.ok(), await imported.text()).toBe(true);
  const { session } = await imported.json();
  const registered = await request.post('/api/artifacts', { headers: { origin: baseURL },
    data: { kind: 'file', repo: 'orbit-labs/adapter', ref: `docs/<b>${marker}</b>.md` } });
  expect(registered.ok(), await registered.text()).toBe(true);
  const { artifact } = await registered.json();
  const party = `art-${Date.now().toString(36)}`;
  const published = await request.post('/api/graphs', { headers: { origin: baseURL },
    data: { version: 3, sessionId: session.id, party, nodes: [{ id: 'doc', kind: 'goal', label: `Doc for ${marker}`, evidence: [{ artifact: artifact.id }] }], edges: [] } });
  expect(published.ok(), await published.text()).toBe(true);
  const node = page.locator('.node', { hasText: marker });
  await expect(node).toBeVisible({ timeout: 3500 });
  await node.click();
  await expect(page.locator('#evidence-meta .evidence-artifact')).toHaveText(`cites file orbit-labs/adapter@docs/<b>${marker}</b>.md`);
  await expect(page.locator('#evidence-status')).toHaveText('This node cites artifacts only, listed above; no transcript line.');
  expect(await page.locator('#evidence b').count()).toBe(0);
  expect(writes()).toEqual([]);
});
