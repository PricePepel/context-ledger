// Card H11: open one feature of the browser app and save a screenshot, so a change can
// carry proof of what it looks like. The features are listed in docs/features.json.
//   node scripts/drive.mjs --list
//   node scripts/drive.mjs <feature> [--out proof.png] [--url http://127.0.0.1:4317]
// Without --url it starts its own ledger on an empty temporary database (live swarm runs
// off) and stops it afterwards. With --url it signs in to that ledger with the token in
// CONTEXT_LEDGER_TOKEN. Uses the Playwright devDependency; not part of the package.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { terminalLabel } from '../src/text.mjs';

export const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stepKinds = new Set(['select', 'upload', 'fill', 'click', 'waitFor']);

/** The feature map, checked enough that a broken entry fails loudly. */
export function loadFeatures(path = join(repo, 'docs', 'features.json')) {
  const map = JSON.parse(readFileSync(path, 'utf8'));
  if (map.version !== 1 || !Array.isArray(map.features)) throw new Error(`${path}: expected version 1 with a features list.`);
  const ids = new Set();
  for (const feature of map.features) {
    const where = `${path}: feature ${JSON.stringify(feature?.id)}`;
    if (typeof feature?.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(feature.id)) throw new Error(`${where}: id must be lowercase words joined by hyphens.`);
    if (ids.has(feature.id)) throw new Error(`${where}: id used twice.`);
    ids.add(feature.id);
    for (const key of ['name', 'what', 'path']) if (typeof feature[key] !== 'string' || feature[key] === '') throw new Error(`${where}: ${key} is required.`);
    // A path on the ledger itself: "/x", never "//host" or "/\host" (H11 review).
    if (!/^\/(?![/\\])/u.test(feature.path)) throw new Error(`${where}: path must start with "/" and stay on the ledger.`);
    if (!Array.isArray(feature.steps) || feature.steps.length === 0) throw new Error(`${where}: steps are required.`);
    for (const step of feature.steps) {
      const kinds = Object.keys(step ?? {});
      if (kinds.length !== 1 || !stepKinds.has(kinds[0])) throw new Error(`${where}: each step is one of ${[...stepKinds].join(', ')}.`);
      if (kinds[0] === 'upload') uploadPath(step.upload[1], where);
    }
    if (feature.proof !== undefined && typeof feature.proof !== 'string') throw new Error(`${where}: proof is a selector.`);
  }
  return map.features;
}

// Uploads come only from the repository's synthetic fixtures (H11 review: no "../").
const fixtureRoots = ['demo/', 'tests/fixtures/', 'evals/'];

export function uploadPath(file, where = 'upload') {
  const full = resolve(repo, String(file));
  const inside = relative(repo, full).split(sep).join('/');
  if (inside.startsWith('..') || isAbsolute(inside) || !fixtureRoots.some(root => inside.startsWith(root))) {
    throw new Error(`${where}: upload ${JSON.stringify(file)} must be a fixture under ${fixtureRoots.join(', ')}.`);
  }
  return full;
}

/** A URL on the ledger's own origin, or an error: nothing leaves the ledger. */
export function onOrigin(origin, path) {
  const url = new URL(path, origin);
  if (url.origin !== new URL(origin).origin) throw new Error('A sign-in or feature URL pointed away from the ledger.');
  return url.href;
}

/** Runs a feature's steps on a signed-in page at the ledger's origin. */
export async function openFeature(page, origin, feature) {
  const timeout = feature.timeoutMs ?? 30_000;
  await page.goto(onOrigin(origin, feature.path));
  for (const step of feature.steps) {
    const [kind, value] = Object.entries(step)[0];
    if (kind === 'select') await page.locator(value[0]).selectOption(value[1], { timeout });
    else if (kind === 'upload') await page.locator(value[0]).setInputFiles(uploadPath(value[1]), { timeout });
    else if (kind === 'fill') await page.locator(value[0]).fill(value[1], { timeout });
    else if (kind === 'click') await page.locator(value).click({ timeout });
    else if (kind === 'waitFor') await page.locator(value).first().waitFor({ state: 'visible', timeout });
  }
  return feature.proof ? page.locator(feature.proof) : page;
}

/** Starts a ledger on an empty temporary database; resolves to its origin and sign-in link. */
export async function startLedger() {
  const folder = await mkdtemp(join(tmpdir(), 'ledger-drive-'));
  const child = spawn(process.execPath, [join(repo, 'src', 'server.mjs')], {
    cwd: repo,
    env: { ...process.env, PORT: '0', CONTEXT_LEDGER_DB: join(folder, 'ledger.sqlite'), SWARM_URLS: 'off' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stop = async () => {
    if (child.exitCode === null) {
      child.kill();
      await once(child, 'exit');
    }
    await rm(folder, { recursive: true, force: true });
  };
  let output = '';
  try {
    const ready = await new Promise((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error(`The ledger did not start: ${redact(output)}`)), 30_000);
      child.on('exit', code => reject(new Error(`The ledger stopped (${code}): ${redact(output)}`)));
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        output += chunk;
        const origin = /listening at (http:\/\/127\.0\.0\.1:\d+)/u.exec(output)?.[1];
        const link = /(http:\/\/127\.0\.0\.1:\d+\/login\?code=[A-Za-z0-9_-]+)/u.exec(output)?.[1];
        if (origin && link) {
          clearTimeout(timer);
          resolveReady({ origin, link });
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => { output += chunk; });
    });
    return { ...ready, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

/** A one-time sign-in link for a running ledger, minted with its access token. */
export async function signInLink(origin, token) {
  // The token goes to this origin only: no redirect is followed (H11 review).
  const response = await fetch(new URL('/api/login', origin), { method: 'POST', redirect: 'manual', headers: { Authorization: `Bearer ${token}` } });
  if (response.status !== 200) throw new Error(`Sign-in was refused (HTTP ${response.status}); check CONTEXT_LEDGER_TOKEN.`);
  const { path } = await response.json();
  if (typeof path !== 'string' || !/^\/login\?code=[A-Za-z0-9_-]+$/u.test(path)) throw new Error('The ledger answered sign-in with an unexpected link.');
  return onOrigin(origin, path);
}

// One-time sign-in codes never reach output (H11 review).
export const redact = text => String(text ?? '').replace(/code=[A-Za-z0-9_-]+/gu, 'code=<redacted>');

function parse(argv) {
  const options = { out: undefined, url: undefined, list: false, feature: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--list') options.list = true;
    else if (argument === '--out' || argument === '--url') {
      if (argv[index + 1] === undefined) throw new Error(`${argument} needs a value.`);
      options[argument.slice(2)] = argv[index += 1];
    } else if (argument.startsWith('--')) throw new Error(`Unknown option ${terminalLabel(argument)}.`);
    else if (options.feature === undefined) options.feature = argument;
    else throw new Error('Name one feature.');
  }
  return options;
}

async function main(argv) {
  const options = parse(argv);
  const features = loadFeatures();
  if (options.list || options.feature === undefined) {
    for (const feature of features) console.log(`${feature.id.padEnd(16)} ${feature.name}: ${feature.what}`);
    if (!options.list) console.log('\nUsage: node scripts/drive.mjs <feature> [--out proof.png] [--url http://127.0.0.1:4317]');
    return;
  }
  const feature = features.find(entry => entry.id === options.feature);
  if (!feature) throw new Error(`No feature ${terminalLabel(JSON.stringify(options.feature))}; node scripts/drive.mjs --list names them.`);
  if (options.url !== undefined && !/^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/?$/u.test(options.url)) throw new Error('--url must be a loopback ledger, such as http://127.0.0.1:4317.');
  // A local file: a screenshot of a ledger never goes to a network share (H11 review).
  if (options.out !== undefined && /^(?:\\\\|\/\/)/u.test(options.out)) throw new Error('--out must be a local file, not a network path.');
  const out = resolve(options.out ?? `${feature.id}.png`);

  const { chromium } = await import('@playwright/test');
  let ledger;
  if (options.url === undefined) ledger = await startLedger();
  else {
    const token = process.env.CONTEXT_LEDGER_TOKEN;
    if (!token) throw new Error('With --url, set CONTEXT_LEDGER_TOKEN to the ledger\'s access token.');
    const origin = new URL(options.url).origin;
    ledger = { origin, link: await signInLink(origin, token), stop: async () => {} };
  }
  // The ledger is stopped whatever fails, a browser that will not launch included.
  let browser;
  try {
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1300, height: 900 } });
    // The page may talk to the ledger only; anything else is aborted (H11 review).
    await context.route('**/*', route => (new URL(route.request().url()).origin === ledger.origin ? route.continue() : route.abort()));
    const page = await context.newPage();
    await page.goto(ledger.link);
    const target = await openFeature(page, ledger.origin, feature);
    await target.screenshot(target === page ? { path: out, fullPage: true } : { path: out });
    console.log(`drive: ${feature.id} saved to ${terminalLabel(out)}`);
  } finally {
    try {
      await browser?.close();
    } finally {
      await ledger.stop();
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`drive: ${terminalLabel(redact(error.message))}`);
    process.exitCode = 1;
  });
}
