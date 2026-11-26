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
import { dirname, join, resolve } from 'node:path';
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
    if (!feature.path.startsWith('/')) throw new Error(`${where}: path must start with "/".`);
    if (!Array.isArray(feature.steps) || feature.steps.length === 0) throw new Error(`${where}: steps are required.`);
    for (const step of feature.steps) {
      const kinds = Object.keys(step ?? {});
      if (kinds.length !== 1 || !stepKinds.has(kinds[0])) throw new Error(`${where}: each step is one of ${[...stepKinds].join(', ')}.`);
    }
    if (feature.proof !== undefined && typeof feature.proof !== 'string') throw new Error(`${where}: proof is a selector.`);
  }
  return map.features;
}

/** Runs a feature's steps on a signed-in page at the ledger's origin. */
export async function openFeature(page, origin, feature) {
  const timeout = feature.timeoutMs ?? 30_000;
  await page.goto(new URL(feature.path, origin).href);
  for (const step of feature.steps) {
    const [kind, value] = Object.entries(step)[0];
    if (kind === 'select') await page.locator(value[0]).selectOption(value[1], { timeout });
    else if (kind === 'upload') await page.locator(value[0]).setInputFiles(join(repo, value[1]), { timeout });
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
      const timer = setTimeout(() => reject(new Error(`The ledger did not start: ${output}`)), 30_000);
      child.on('exit', code => reject(new Error(`The ledger stopped (${code}): ${output}`)));
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
  const response = await fetch(new URL('/api/login', origin), { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Sign-in was refused (HTTP ${response.status}); check CONTEXT_LEDGER_TOKEN.`);
  const { path } = await response.json();
  return new URL(path, origin).href;
}

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
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
    await page.goto(ledger.link);
    const target = await openFeature(page, ledger.origin, feature);
    await target.screenshot(target === page ? { path: out, fullPage: true } : { path: out });
    console.log(`drive: ${feature.id} saved to ${terminalLabel(out)}`);
  } finally {
    await browser.close();
    await ledger.stop();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`drive: ${terminalLabel(error.message)}`);
    process.exitCode = 1;
  });
}
