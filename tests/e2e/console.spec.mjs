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
  // Card H14: the 34 s recording plays at speed 1.5, about 23 s of this test, so the
  // default 30 s left a loaded Windows runner too little for the rest.
  test.setTimeout(60_000);
  await mkdir(shotsDir, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  const writes = watchRequests(page);
  await page.goto('/console/?demo&autoplay=0&speed=1.5');
  await expect(page.locator('body')).toHaveAttribute('data-demo', 'ready');
  await expect(page.locator('.brain-empty')).toBeVisible();
  await expect(page.locator('.office-agent')).toHaveCount(0);
  await page.screenshot({ path: `${shotsDir}/01-empty.png` });

  // Card H14: a read line lives 2.4 s. Polling it from the test missed it on loaded Windows
  // runners, so the page records each read line as it is added, and samples it every frame
  // while it is drawn: whether one frame had it opaque, sized and stroked at once (review:
  // three separate maxima could come from different frames). The office is drawn
  // before the line, so the agents working at that moment are recorded too: polling for
  // exactly one working agent raced the four seconds each publish keeps an agent working.
  await page.evaluate(() => {
    window.readFlashes = [];
    new MutationObserver(records => {
      for (const record of records) {
        for (const line of record.addedNodes) {
          if (!(line instanceof SVGLineElement) || !line.classList.contains('flash-read')) continue;
          const working = [...document.querySelectorAll('.office-agent[data-state="working"]')].map(agent => agent.getAttribute('aria-label'));
          const seen = { visible: false, working };
          window.readFlashes.push(seen);
          const sample = () => {
            if (!line.isConnected) return;
            const style = getComputedStyle(line);
            const box = line.getBoundingClientRect();
            seen.visible ||= Number(style.opacity) > 0.5 && style.stroke !== 'none' && (box.width > 0 || box.height > 0);
            requestAnimationFrame(sample);
          };
          sample();
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
  await page.getByRole('button', { name: 'Play demo' }).click();
  // Mid-run: Ali's second publish links to two of Leo's nodes, so a read line flashes.
  // Visible means drawn: in one frame, a coloured stroke with a size that faded in.
  // Only Ali's second publish (20 s) and Leo's last (26 s) link to the other party, so the
  // first read line recorded is Ali's.
  await page.waitForFunction(() => window.readFlashes[0]?.visible, null, { timeout: 25_000 });
  const flash = await page.evaluate(() => window.readFlashes[0]);
  // Ali, who just published and read, is working; Leo may still be from his last publish.
  expect(flash.working.some(label => /ali/u.test(label))).toBe(true);
  // The screenshot comes after the wait, so it may show a later moment than the line.
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
  // Card U4: the rebuilt recording carries G7 marks, shown as a word as well as a colour.
  await expect(page.locator('.node[data-mark="quoted"]')).toHaveCount(11);
  await expect(page.locator('.node[data-mark="quoted"] .node-mark').first()).toHaveText(' · quoted');
  // Card U4: each agent is its source's pixel sprite.
  await expect(page.locator('.office-agent[data-sprite="claude"]')).toHaveCount(1);
  await expect(page.locator('.office-agent[data-sprite="codex"]')).toHaveCount(1);
  expect(await page.locator('.office-agent[data-sprite="claude"] .oa-sprite rect').count()).toBeGreaterThan(5);
  expect(await page.locator('.office-agent [style]').count()).toBe(0);
  // Card U4b: the furnished office and the logo.
  await expect(page.locator('.office-room')).toHaveCount(2);
  await expect(page.locator('.of-desk')).toHaveCount(12);
  await expect(page.locator('.office-standing .office-agent[data-state="waiting"]')).toHaveCount(1);
  expect(await page.locator('header img.brand').evaluate(img => img.naturalWidth)).toBeGreaterThan(0);
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', '/console/logo.svg');
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

  // By its own party, not its label: other e2e tests publish nodes with the same hostile label into the shared database.
  const node = page.locator(`.node[data-key="party:${party}/hostile"]`);
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

test('card U4: live nodes show the ledger\'s quoted or inferred mark', async ({ page, request, baseURL }) => {
  const writes = watchRequests(page);
  await page.goto('/console/');
  await expect(page.locator('#status')).toContainText('Live: watching the ledger');
  const marker = `console-u4-${Date.now()}`;
  const transcript = [
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `For ${marker}, the ledger stays on port 4317.` }] } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `For ${marker}, retry a few times.` }] } }),
  ].join('\n');
  const imported = await request.post('/api/import', { headers: { origin: baseURL }, data: { provider: 'codex', source: `${marker}.jsonl`, transcript } });
  expect(imported.ok(), await imported.text()).toBe(true);
  const { session } = await imported.json();
  const party = `u4-${Date.now().toString(36)}`;
  const published = await request.post('/api/graphs', {
    headers: { origin: baseURL },
    data: { version: 2, sessionId: session.id, party, edges: [], nodes: [
      { id: 'port', kind: 'decision', label: 'Use port 4317', evidenceLines: [1] },
      { id: 'retry', kind: 'decision', label: 'Retry 5 times', evidenceLines: [2] },
    ] },
  });
  expect(published.ok(), await published.text()).toBe(true);

  const quoted = page.getByRole('button', { name: /^decision, quoted: Use port 4317/u });
  const inferred = page.getByRole('button', { name: /^decision, inferred: Retry 5 times/u });
  await expect(quoted).toHaveAttribute('data-mark', 'quoted', { timeout: 3500 });
  await expect(inferred).toHaveAttribute('data-mark', 'inferred');
  await expect(inferred.locator('.node-mark')).toHaveText(' · inferred');
  await expect(page.locator(`.office-agent[aria-label*="${party}"]`)).toHaveAttribute('data-sprite', 'codex');
  await inferred.click();
  await expect(page.locator('.turn.is-cited mark')).toContainText('retry a few times');
  if (process.env.CONSOLE_SHOTS_DIR) await page.screenshot({ path: `${shotsDir}/06-marks-and-agent-turn.png`, fullPage: true });
  expect(writes()).toEqual([]);
});

// Card I3 (PR #34) brings Codex agent-to-agent turns into the store. Until it lands on
// the new message rows, the import keeps no agent turn, so this check waits for it.
test.fixme('card U4: a Codex agent turn says who sent it', async ({ page, request, baseURL }) => {
  const writes = watchRequests(page);
  await page.goto('/console/');
  await expect(page.locator('#status')).toContainText('Live: watching the ledger');
  const marker = `console-u4-${Date.now()}`;
  const transcript = [
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `For ${marker}, the ledger stays on port 4317.` }] } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'agent_message', author: '/root/worker', recipient: '/root', content: [{ type: 'input_text', text: `For ${marker}, retry a few times.` }] } }),
  ].join('\n');
  const imported = await request.post('/api/import', { headers: { origin: baseURL }, data: { provider: 'codex', source: `${marker}.jsonl`, transcript } });
  expect(imported.ok(), await imported.text()).toBe(true);
  const { session } = await imported.json();
  const party = `u4-${Date.now().toString(36)}`;
  const published = await request.post('/api/graphs', {
    headers: { origin: baseURL },
    data: { version: 2, sessionId: session.id, party, edges: [], nodes: [
      { id: 'port', kind: 'decision', label: 'Use port 4317', evidenceLines: [1] },
      { id: 'retry', kind: 'decision', label: 'Retry 5 times', evidenceLines: [2] },
    ] },
  });
  expect(published.ok(), await published.text()).toBe(true);

  const quoted = page.getByRole('button', { name: /^decision, quoted: Use port 4317/u });
  const inferred = page.getByRole('button', { name: /^decision, inferred: Retry 5 times/u });
  await expect(quoted).toHaveAttribute('data-mark', 'quoted', { timeout: 3500 });
  await expect(inferred).toHaveAttribute('data-mark', 'inferred');
  await expect(inferred.locator('.node-mark')).toHaveText(' · inferred');
  await expect(page.locator(`.office-agent[aria-label*="${party}"]`)).toHaveAttribute('data-sprite', 'codex');
  await inferred.click();
  await expect(page.locator('.turn.is-cited .turn-role')).toHaveText('Agent /root/worker to /root');
  await expect(page.locator('.turn.is-cited mark')).toContainText('retry a few times');
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

test('card U4b: working agents sit at a lit desk, waiting ones stand beside it, idle ones go to the lounge', async ({ page }) => {
  await mkdir(shotsDir, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  const writes = watchRequests(page);
  await page.goto('/console/?demo&autoplay=0');
  await expect(page.locator('body')).toHaveAttribute('data-demo', 'ready');
  // Drive a second office with every state and every role (synthetic labels only).
  const placed = await page.evaluate(async () => {
    const { createOffice } = await import('/console/office.mjs');
    const { seatAt, besideDesk, loungeSpot } = await import('/console/office-furniture.mjs');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = 'office-states';
    document.querySelector('.office').appendChild(svg);
    const office = createOffice(svg);
    const agents = [
      ['planner', 'working'], ['builder', 'working'], ['reviewer', 'waiting'], ['tests', 'working'], ['docs', 'idle'], ['scout', 'idle'],
    ].flatMap(([label, state], i) => ['claude', 'codex'].map(provider => ({ key: `${provider}-${i}`, provider, label, state })));
    office.update(agents);
    const at = node => node.style.getPropertyValue('transform');
    const px = ([x, y]) => `translate(${x}px, ${y}px)`;
    const agent = key => svg.querySelector(`.office-agent[data-key="${key}"]`);
    return {
      working: at(agent('claude-0')) === px(seatAt(0)) && agent('claude-0').parentNode.classList.contains('office-seated'),
      waiting: at(agent('codex-2')) === px(besideDesk(2)) && agent('codex-2').parentNode.classList.contains('office-standing'),
      idle: at(agent('claude-4')) === px(loungeSpot(0)) && at(agent('claude-5')) === px(loungeSpot(1)),
      lit: [...svg.querySelectorAll('.office-room-claude .of-desk')].map(desk => desk.classList.contains('is-lit')),
      roles: [0, 1, 2, 3, 4, 5].map(i => agent(`codex-${i}`).dataset.role),
      states: [0, 1, 2, 3, 4, 5].map(i => agent(`claude-${i}`).dataset.state),
      stateWords: [...svg.querySelectorAll('.office-room-claude .oa-state')].map(node => node.textContent).sort(),
      labels: agent('codex-2').getAttribute('aria-label'),
      styled: svg.querySelectorAll('.office-agent [style]').length,
    };
  });
  expect(placed.working).toBe(true);
  expect(placed.waiting).toBe(true);
  expect(placed.idle).toBe(true);
  expect(placed.lit).toEqual([true, true, false, true, false, false]);
  expect(placed.roles).toEqual(['planner', 'builder', 'reviewer', 'tester', 'writer', 'scout']);
  expect(placed.states).toEqual(['working', 'working', 'waiting', 'working', 'idle', 'idle']);
  expect(placed.stateWords).toEqual(['idle', 'idle', 'waiting', 'working', 'working', 'working']);
  expect(placed.labels).toBe('reviewer, Codex, waiting');
  expect(placed.styled).toBe(0);
  await expect(page.locator('#office-states .is-new')).toHaveCount(0);
  await page.locator('#office-states').scrollIntoViewIfNeeded();
  await page.locator('#office-states').screenshot({ path: `${shotsDir}/07-office-states.png` });
  // update() over time (review of U4b): desks stay put, a state change walks to the new spot,
  // and more than six agents in a room show a "+n" chip.
  const later = await page.evaluate(async () => {
    const { seatAt, loungeSpot } = await import('/console/office-furniture.mjs');
    const svg = document.getElementById('office-states');
    const { createOffice } = await import('/console/office.mjs');
    const office = createOffice(svg);
    const agent = key => svg.querySelector(`.office-agent[data-key="${key}"]`);
    const px = ([x, y]) => `translate(${x}px, ${y}px)`;
    office.update([0, 1, 2, 3].map(i => ({ key: `c${i}`, provider: 'claude', label: `agent ${i}`, state: 'working' })));
    await new Promise(resolve => setTimeout(resolve, 800));
    office.update([
      { key: 'c0', provider: 'claude', label: 'agent 0', state: 'idle' },
      { key: 'c3', provider: 'claude', label: 'agent 3', state: 'working' },
      ...Array.from({ length: 8 }, (_, i) => ({ key: `x${i}`, provider: 'codex', label: `codex ${i}`, state: 'working' })),
    ]);
    const walking = agent('c0').getAnimations().some(animation => animation.transitionProperty === 'transform');
    return {
      stayed: agent('c3').style.getPropertyValue('transform') === px(seatAt(3)),
      lounge: agent('c0').style.getPropertyValue('transform') === px(loungeSpot(0)) && agent('c0').parentNode.classList.contains('office-standing'),
      walking,
      lit: [...svg.querySelectorAll('.office-room-claude .of-desk')].map(desk => desk.classList.contains('is-lit')),
      gone: svg.querySelectorAll('.office-agent[data-key="c1"], .office-agent[data-key="c2"]').length,
      tags: svg.querySelectorAll('.office-room-claude .oa-tag').length,
      codex: svg.querySelectorAll('.office-room-codex .office-agent').length,
      more: svg.querySelector('.office-room-codex .office-more.is-shown text')?.textContent,
      hatless: agent('x0').dataset.role,
    };
  });
  expect(later).toEqual({
    stayed: true, lounge: true, walking: true, lit: [false, false, false, true, false, false],
    gone: 0, tags: 2, codex: 6, more: '+2', hatless: 'none',
  });
  expect(writes()).toEqual([]);
});

test('card U6: the pixel console loads its local fonts, shows counters instead of tiles, and the CTM band crew talks', async ({ page }) => {
  await mkdir(shotsDir, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  const writes = watchRequests(page);
  const hosts = new Set();
  page.on('request', request => hosts.add(new URL(request.url()).host));
  await page.goto('/console/?demo&speed=8');
  await expect(page.locator('body')).toHaveAttribute('data-demo', 'finished', { timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
  for (const face of ['16px "Jersey 15"', '16px "Inter Tight"', '10px "Silkscreen"']) {
    expect(await page.evaluate(font => document.fonts.check(font), face), face).toBe(true);
  }
  expect(await page.locator('h1').evaluate(h => getComputedStyle(h).fontFamily)).toContain('Jersey 15');
  expect(await page.locator('.activity li').first().evaluate(li => getComputedStyle(li).fontFamily)).toContain('Inter Tight');
  await expect(page.locator('html')).not.toHaveClass(/ctm-dark/u);

  await expect(page.locator('.numbers, .tile')).toHaveCount(0);
  await expect(page.locator('.counters #n-handoffs')).toHaveText('6');
  await expect(page.locator('.activity li').first()).toBeVisible();

  const band = page.locator('section.band');
  await band.scrollIntoViewIfNeeded();
  await expect(band).toHaveClass(/play/u);
  await page.waitForFunction(() => document.getAnimations().every(a => a.playState !== 'running' || a.effect?.getComputedTiming().iterations === Infinity));
  const ask = await page.locator('.band-ask').boundingBox();
  const strip = await page.locator('svg#band').boundingBox();
  expect(ask.y, 'the reviewer question box stays inside the band').toBeGreaterThanOrEqual(strip.y);
  await expect(page.locator('.band-letter')).toHaveCount(3);
  await expect(page.locator('.band-char')).toHaveCount(20);
  await expect(page.locator('.band-char[data-provider="claude"][data-role="builder"]')).toHaveCount(1);
  await expect(page.locator('.band-char[data-provider="kimi"] path')).not.toHaveCount(0);
  await page.locator('.band-char[data-provider="cursor"]').click();
  await expect(page.locator('.band-bubble text')).toHaveText('CURSOR');
  await page.locator('.band-char[data-provider="codex"][data-role="planner"]').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.band-bubble text')).toHaveText('CODEX · PLANNER');
  await expect(page.locator('#band-said')).toHaveText('Codex · planner');
  await page.locator('.band-char[data-provider="kimi"]').focus();
  await page.keyboard.press(' ');
  await expect(page.locator('#band-said')).toHaveText('Kimi Code');
  await band.screenshot({ path: `${shotsDir}/08-ctm-band.png` });

  expect([...hosts]).toEqual([new URL(page.url()).host]);
  expect(writes()).toEqual([]);
});

test('card U6: activity sits under the evidence, and both panels switch off and on', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/console/?demo&speed=8');
  await expect(page.locator('body')).toHaveAttribute('data-demo', 'finished', { timeout: 15_000 });
  const evidence = page.locator('#evidence');
  const feed = page.locator('#feed');
  const below = (await feed.boundingBox()).y - (await evidence.boundingBox()).y;
  expect(below, 'activity is below the evidence').toBeGreaterThan(0);
  expect(Math.abs((await feed.boundingBox()).x - (await evidence.boundingBox()).x)).toBeLessThan(2);

  const evidenceButton = page.getByRole('button', { name: 'Evidence', exact: true });
  const activityButton = page.getByRole('button', { name: 'Activity', exact: true });
  await activityButton.click();
  await expect(activityButton).toHaveAttribute('aria-pressed', 'false');
  await expect(feed).toBeHidden();
  await evidenceButton.click();
  await expect(evidence).toBeHidden();
  const wide = await page.locator('#brain').boundingBox();
  expect(wide.width, 'the graph takes the full width with both panels off').toBeGreaterThan(1200);
  await page.waitForFunction(() => document.querySelector('#flash-layer').childElementCount === 0);
  await page.screenshot({ path: `${shotsDir}/09-panels-off.png` });

  await page.reload();
  await expect(page.locator('body')).toHaveAttribute('data-demo', 'finished', { timeout: 15_000 });
  await expect(feed).toBeHidden();
  await page.locator('#brain .node').first().click();
  await expect(evidence).toBeVisible();
  await expect(evidenceButton).toHaveAttribute('aria-pressed', 'true');
  await activityButton.click();
  await expect(feed).toBeVisible();
});

test('card U6: bad or blocked panel storage keeps both panels on, and a phone crops the band', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ctm-console-panels', '"x"'));
  await page.goto('/console/?demo&autoplay=0');
  await expect(page.locator('#evidence')).toBeVisible();
  await expect(page.locator('#feed')).toBeVisible();
  for (const name of ['evidence', 'feed']) await expect(page.locator(`button[data-panel="${name}"]`)).toHaveAttribute('aria-controls', name);

  const blocked = await page.context().newPage();
  await blocked.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { get() { throw new Error('blocked'); } });
  });
  await blocked.setViewportSize({ width: 390, height: 844 });
  await blocked.goto('/console/?demo&autoplay=0');
  await expect(blocked.locator('#feed')).toBeVisible();
  await blocked.getByRole('button', { name: 'Activity', exact: true }).click();
  await expect(blocked.locator('#feed')).toBeHidden();
  const width = Number((await blocked.locator('svg#band').getAttribute('viewBox')).split(' ')[2]);
  expect(width, 'the narrow band crops to the word and its nearest crew').toBeLessThan(1100);
  expect(await blocked.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('office agents appear at their spot instead of sliding in from the room corner', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/console/?demo&speed=8');
  const agent = page.locator('#office .office-agent').first();
  await agent.waitFor();
  const start = await agent.evaluate(g => getComputedStyle(g).transform);
  await page.waitForTimeout(80);
  const soon = await agent.evaluate(g => getComputedStyle(g).transform);
  expect(start, 'a new agent is already at its spot on its first frame').toBe(soon);
  expect(start).not.toBe('none');
});

test('card U6: live activity shows today\'s earlier hand-offs as soon as the page opens', async ({ page, request, baseURL }) => {
  const marker = `console-u6-${Date.now()}`;
  const transcript = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `For ${marker}, ship the band.` }] } });
  const imported = await request.post('/api/import', { headers: { origin: baseURL }, data: { provider: 'codex', source: `${marker}.jsonl`, transcript } });
  expect(imported.ok(), await imported.text()).toBe(true);
  const { session } = await imported.json();
  const party = `u6-${Date.now().toString(36)}`;
  const published = await request.post('/api/graphs', {
    headers: { origin: baseURL },
    data: { version: 2, sessionId: session.id, party, edges: [], nodes: [{ id: 'band', kind: 'goal', label: 'Ship the band', evidenceLines: [1] }] },
  });
  expect(published.ok(), await published.text()).toBe(true);
  const { graph } = await published.json();

  await page.goto('/console/');
  await expect(page.locator('#status')).toContainText('Live: watching the ledger');
  const entry = page.locator('#activity li', { hasText: `${party} (Codex) published: 1 new` });
  await expect(entry).toHaveCount(1);
  const shown = Date.parse(await entry.locator('time').getAttribute('datetime'));
  expect(Math.abs(shown - Date.parse(graph.createdAt ?? new Date().toISOString())), 'the entry carries the publish time, not the page load time').toBeLessThan(5_000);
  const times = await page.locator('#activity li').evaluateAll(items => items.map(item => Number(item.dataset.at)));
  expect(times, 'newest first').toEqual([...times].sort((a, b) => b - a));
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
