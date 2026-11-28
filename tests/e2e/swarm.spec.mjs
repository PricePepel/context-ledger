import { loadFeatures } from '../../scripts/drive.mjs';
import { checkFeature, featureTitle } from './feature-check.mjs';
import { expect, test } from './fixtures.mjs';

// The ledger runs one swarm at a time, and a test that stops watching a run leaves it running
// for a few seconds. Before each test, wait until the ledger accepts a run again: start a
// one-agent run (retrying while one is going) and wait for it to end.
test.beforeEach(async ({ request, baseURL }) => {
  let id;
  await expect(async () => {
    const started = await request.post('/api/swarm/runs', { headers: { origin: baseURL }, data: { agents: 1, mode: 'simulated' } });
    expect(started.status()).toBe(200);
    ({ run: { id } } = await started.json());
  }).toPass({ timeout: 20_000 });
  await expect.poll(async () => (await (await request.get(`/api/swarm/runs/${id}`)).json()).run.state, { timeout: 20_000 }).toBe('done');
});

// Card S1: the swarm page with the labelled simulation (the e2e ledger has no model server).
test('a simulated 100-agent run finishes, shows the answer and one agent’s proof', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 900 });
  await page.goto('/swarm/');
  await expect(page.locator('#mode-live')).toBeDisabled();
  await expect(page.locator('#mode-simulated')).toBeChecked();
  await expect(page.locator('#live-reason')).toContainText('timings are made up');
  await expect(page.locator('#live-reason')).toContainText('Live runs are turned off (SWARM_URLS=off).');
  await expect(page.locator('#stats')).toBeHidden();

  await page.getByRole('button', { name: 'Run' }).click();
  await expect(page.locator('#mode-badge')).toHaveText('Simulated');
  await expect(page.locator('.tile')).toHaveCount(100);
  await expect(page.locator('body')).toHaveAttribute('data-run-state', 'done', { timeout: 30_000 });
  await expect(page.locator('.tile[data-state="done"]')).toHaveCount(100);
  await expect(page.locator('#status')).toContainText('Done: 100 agents');
  await expect(page.locator('#status')).toContainText('(simulated)');
  await expect(page.locator('#stats')).toContainText('100 / 100');
  await expect(page.locator('#stats')).toContainText('not measured');
  // Card S1b: a simulated run shows no speed-up at all, not a made-up one.
  await expect(page.locator('#stats .stat', { hasText: 'Speed-up' })).toContainText('not measured');
  await expect(page.locator('#stats .stat', { hasText: 'KV cache peak' })).toContainText('not measured');
  await expect(page.locator('#answer')).toContainText('Truth from the generator');

  // An unverified agent: its quote is not in its report, and the page says so.
  const unverified = page.locator('.tile[data-verified="false"]').first();
  await unverified.click();
  await expect(page.locator('#detail')).toContainText('Not found in the report');

  // A verified agent: its quote is marked inside its report.
  await page.locator('.tile[data-verified="true"]').first().click();
  await expect(page.locator('#detail mark')).toHaveCount(1);
  await expect(page.locator('#detail')).toContainText('Found in the report');
  await expect(page.locator('#detail .detail-meta')).toContainText('out (simulated)');
  const marked = await page.locator('#detail mark').textContent();
  expect(await page.locator('#detail .report').textContent()).toContain(marked);
});

test('a run the ledger no longer keeps stops the page polling and frees the Run button', async ({ page }) => {
  await page.goto('/swarm/');
  let polls = 0;
  await page.route(/\/api\/swarm\/runs\/[a-f0-9]{64}$/u, route => {
    polls += 1;
    return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Not found.' }) });
  });
  await page.getByRole('button', { name: 'Run' }).click();
  await expect(page.locator('#status')).toContainText('no longer kept');
  await expect(page.getByRole('button', { name: 'Run' })).toBeEnabled();
  const seen = polls;
  await page.waitForTimeout(1000);
  expect(polls).toBe(seen);
});

// Card U7: the same swarm, run from the console's swarm room. It lives in this file because the
// ledger runs one swarm at a time, and tests in one file run one after another.
test('U7: the console runs the simulated swarm in its own room and shows honest numbers', async ({ page, request, baseURL }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const swarmCalls = [];
  const writes = [];
  page.on('request', item => {
    const path = new URL(item.url()).pathname;
    if (path.startsWith('/api/swarm')) swarmCalls.push(`${item.method()} ${path}`);
    if (item.method() !== 'GET') writes.push(`${item.method()} ${path}`);
  });
  // A graph in the ledger, so the test sees the rest of the console keep working.
  const marker = `u7-${Date.now()}`;
  const transcript = JSON.stringify({ type: 'user', message: { role: 'user', content: `Ship the ${marker} demo.` } });
  const imported = await request.post('/api/import', { headers: { origin: baseURL }, data: { provider: 'claude', source: `${marker}.jsonl`, transcript } });
  expect(imported.ok(), await imported.text()).toBe(true);
  const { session } = await imported.json();
  const published = await request.post('/api/graphs', { headers: { origin: baseURL },
    data: { version: 2, sessionId: session.id, party: `u7-${Date.now().toString(36)}`, edges: [], nodes: [{ id: 'goal', kind: 'goal', label: `Ship ${marker}`, evidenceLines: [1] }] } });
  expect(published.ok(), await published.text()).toBe(true);

  await page.goto('/console/');
  const room = page.locator('#swarm');
  await expect(room.getByRole('heading', { name: 'Local swarm' })).toBeVisible();
  await expect(room.locator('#swarm-mode')).toHaveText('Simulated');
  await expect(room.locator('#swarm-status')).toContainText('timings are made up');
  // Card U11: the room gives the server's reason (the e2e ledger runs with SWARM_URLS=off).
  await expect(room.locator('#swarm-status')).toContainText('Live runs are turned off (SWARM_URLS=off).');
  const runButton = room.getByRole('button', { name: 'Run 100 agents' });
  await expect(runButton).toBeEnabled();
  await expect(room.getByRole('link', { name: 'Open the swarm page' })).toHaveAttribute('href', '/swarm/');
  // Before Run, the room only asks which mode the server offers.
  expect(swarmCalls).toEqual(['GET /api/swarm']);

  await runButton.click();
  await expect(room.locator('#swarm-grid li')).toHaveCount(100);
  await expect(room).toHaveAttribute('data-run-state', 'done', { timeout: 30_000 });
  await expect(runButton).toBeEnabled();
  await expect(room.locator('#swarm-status')).toContainText('Done: 100 agents');
  const stats = Object.fromEntries(await room.locator('#swarm-stats div').evaluateAll(boxes => boxes.map(box => [box.querySelector('dt').textContent, box.querySelector('dd').textContent])));
  const href = await room.locator('#swarm-open').getAttribute('href');
  const id = /^\/swarm\/#run=([a-f0-9]{64})$/u.exec(href)?.[1];
  expect(id, href).toBeTruthy();
  const { run } = await (await request.get(`/api/swarm/runs/${id}`)).json();
  expect(stats['Agents finished']).toBe('100 / 100');
  expect(stats['Speed-up']).toBe('not measured');
  expect(stats['Wall time']).toMatch(/ \(simulated\)$/u);
  expect(stats['Quotes verified']).toBe(`${run.counts.verified} / 100`);
  expect(stats['Answers correct']).toBe(`${run.counts.correct} / 100`);
  const states = await room.locator('#swarm-grid li').evaluateAll(tiles => tiles.map(tile => tile.dataset.state));
  expect(states.filter(state => state === 'verified')).toHaveLength(run.counts.verified);
  expect(states.every(state => ['verified', 'dropped', 'failed'].includes(state))).toBe(true);
  await expect(room.locator('#swarm-tally')).toHaveText(new RegExp(`^${run.counts.verified} checked, 0 working, 0 queued`, 'u'));
  // The console's only write is the run itself, and the graph still renders.
  expect(writes).toEqual(['POST /api/swarm/runs']);
  await expect(page.locator('.node', { hasText: marker })).toBeVisible();

  // The link opens this same run on the swarm page.
  await room.getByRole('link', { name: 'Open the swarm page' }).click();
  await expect(page).toHaveURL(new RegExp(`/swarm/#run=${id}$`, 'u'));
  await expect(page.locator('#grid .tile')).toHaveCount(100);
  await expect(page.locator('#status')).toContainText('Done: 100 agents');
});

test('U7: a run the ledger no longer keeps stops the room and lets the person run again', async ({ page }) => {
  await page.route(/\/api\/swarm\/runs\/[a-f0-9]{64}$/u, route => route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Not found."}' }));
  await page.goto('/console/');
  const room = page.locator('#swarm');
  const runButton = room.getByRole('button', { name: 'Run 100 agents' });
  await runButton.click();
  await expect(room.locator('#swarm-status')).toHaveText('This run is no longer kept by the ledger. Run again.');
  await expect(runButton).toBeEnabled();
  await page.unroute(/\/api\/swarm\/runs\/[a-f0-9]{64}$/u);
});

test('U7: in the recorded demo the swarm room is hidden and the console asks the API nothing', async ({ page }) => {
  const api = [];
  page.on('request', item => { if (new URL(item.url()).pathname.startsWith('/api/')) api.push(new URL(item.url()).pathname); });
  await page.goto('/console/?demo&autoplay=0');
  await expect(page.locator('body')).toHaveAttribute('data-demo', 'ready');
  await expect(page.locator('#swarm')).toBeHidden();
  await page.waitForLoadState('networkidle');
  expect(api).toEqual([]);
});

test('U7 review: Run stays off until the server says which mode it offers, then takes that mode', async ({ page }) => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await page.route('**/api/swarm', async route => { await held; await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ live: true, models: ['m'], concurrency: 4 }) }); });
  const posts = [];
  await page.route('**/api/swarm/runs', route => { posts.push(route.request().postDataJSON()); return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Not now."}' }); });
  await page.goto('/console/');
  const runButton = page.locator('#swarm-run');
  await expect(runButton).toBeDisabled();
  release();
  await expect(page.locator('#swarm-mode')).toHaveText('Live: m');
  await expect(runButton).toBeEnabled();
  await runButton.click();
  await expect(page.locator('#swarm-status')).toHaveText('Not now.');
  expect(posts).toEqual([{ agents: 100, mode: 'live' }]);
  await expect(runButton).toBeEnabled();
});

// Card U8: the swarm page tells the swarm's story in the console's pixel look.
test('U8: the swarm page shows the dataset and the task before a run, and pixel robots after', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const hosts = new Set();
  page.on('request', item => hosts.add(new URL(item.url()).host));
  await page.goto('/swarm/');
  // 1. The dataset, as text, before anything runs.
  await expect(page.locator('#dataset-note')).toContainText('100 incident reports');
  await expect(page.locator('#dataset-note')).toContainText('synthetic');
  await expect(page.locator('#dataset-sample li')).toHaveCount(3);
  await expect(page.locator('#dataset-sample li').first()).toContainText('Incident 1,');
  await page.locator('#agents').selectOption('25');
  await expect(page.locator('#dataset-note')).toContainText('25 incident reports');
  await page.locator('#agents').selectOption('100');
  // 2. The task every agent shares.
  await page.getByText('Read the instructions the agents share').click();
  await expect(page.locator('#task-text')).toContainText('You read one incident report and extract four facts.');
  await expect(page.locator('#runs-on')).toContainText('A simulated run has no model server');
  // The story is in the order a person would ask: data, task, run, agents, check, what it runs on, answer.
  const steps = await page.locator('main .step > h2, main .step > .part-head > h2').evaluateAll(headings => headings.map(heading => heading.textContent.trim()));
  expect(steps).toEqual(['1The dataset', '2The task', '3Run a swarm', '4The agents', '5The check', '6What it runs on', '7Combined answer']);
  // The pale swatches of the colour key have an outline, so they read on the white sheet.
  expect(await page.locator('.state-key i').first().evaluate(swatch => getComputedStyle(swatch).boxShadow)).not.toBe('none');
  // The console's look: its fonts and its framed sheet, all from this machine.
  const look = await page.evaluate(async () => {
    await document.fonts.ready;
    return {
      title: getComputedStyle(document.querySelector('.bar-title')).fontFamily,
      loaded: [...document.fonts].filter(font => font.status === 'loaded').map(font => font.family.replaceAll('"', '')).sort(),
      frame: getComputedStyle(document.querySelector('.sheet')).boxShadow !== 'none',
    };
  });
  expect(look.title).toContain('Jersey 15');
  expect(look.loaded).toEqual(expect.arrayContaining(['Inter Tight', 'Jersey 15', 'Silkscreen']));
  expect(look.frame).toBe(true);

  // 4 and 5. Robots, their states in words, and the check's counts.
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.locator('.tile svg.swarm-agent')).toHaveCount(100);
  await expect(page.locator('body')).toHaveAttribute('data-run-state', 'done', { timeout: 30_000 });
  const verified = await page.locator('.tile[data-verified="true"]').count();
  await expect(page.locator('#tally')).toHaveText(`${verified} checked, 0 working, 0 queued, ${100 - verified} left out, 0 failed.`);
  await expect(page.locator('#check-counts')).toContainText('Quote found');
  await expect(page.locator('#check-counts div').first().locator('dd')).toHaveText(String(verified));
  expect(await page.locator('.tile svg [style], .tile svg [fill]').count()).toBe(0);
  // Each robot is a real button inside a list item: its role, name and pressed state are announced,
  // and the keyboard opens its report.
  await expect(page.locator('#grid > li > button.tile')).toHaveCount(100);
  const first = page.getByRole('button', { name: /^Agent 1, (answer checked|quote not found, left out)$/u });
  await expect(first).toHaveAttribute('aria-pressed', 'false');
  await first.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#detail h3')).toHaveText('Agent 1');
  await expect(page.getByRole('button', { name: /^Agent 1, / })).toHaveAttribute('aria-pressed', 'true');
  expect([...hosts]).toEqual([new URL(page.url()).host]);
});

test('U8: the console\'s swarm room draws the same pixel robots', async ({ page }) => {
  await page.goto('/console/');
  await page.locator('#swarm-run').click();
  await expect(page.locator('#swarm-grid li svg.swarm-agent')).toHaveCount(100);
  await expect(page.locator('#swarm')).toHaveAttribute('data-run-state', 'done', { timeout: 30_000 });
  expect(await page.locator('#swarm-grid svg [style], #swarm-grid svg [fill]').count()).toBe(0);
});

// Card H14: feature map entries that start a swarm run, after the beforeEach above, one
// at a time with the other swarm tests (tests/e2e/features.spec.mjs skips them).
for (const feature of loadFeatures()) if (feature.runsSwarm) test(featureTitle(feature), checkFeature(feature));
