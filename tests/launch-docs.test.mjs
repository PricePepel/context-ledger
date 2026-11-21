// Card P5e: the README's Install section says only what the package does. Every
// context-ledger command it shows is one the bin runs, the ones that need a server run
// against a temporary home, and the npm and npx lines name this package and its bin.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(repo, 'bin', 'context-ledger.mjs');
const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
const readme = readFileSync(join(repo, 'README.md'), 'utf8').split('\r\n').join('\n');
const install = readme.slice(readme.indexOf('## Install\n'), readme.indexOf('\n## ', readme.indexOf('## Install\n') + 3));
const run = promisify(execFile);

test('P5e: the Install section names this package and its command', () => {
  assert.ok(install.length > 500, 'there is an Install section');
  const [command] = Object.keys(pkg.bin);
  assert.equal(command, 'context-ledger');
  assert.ok(install.includes(`\`${pkg.name}\``), 'the package name');
  // Every npx line runs this package's bin, from npm or from the repository.
  const npx = [...install.matchAll(/npx -y --package (\S+) (\S+)/gu)];
  assert.ok(npx.length >= 2);
  for (const [, spec, name] of npx) {
    assert.equal(name, command, spec);
    assert.ok(spec === 'github:PricePepel/context-ledger' || spec === pkg.name || spec.startsWith(`${pkg.name}@`), spec);
  }
  for (const [, name] of install.matchAll(/npm (?:install|uninstall) --global ([^\s`]+)/gu)) assert.equal(name, pkg.name);
  assert.match(pkg.repository.url, /github\.com\/PricePepel\/context-ledger\.git$/u);
  // The data folder it names is the one the bin uses.
  assert.match(readFileSync(bin, 'utf8'), /join\(homeOf\(\), '\.context-ledger', 'ledger\.sqlite'\)/u);
  assert.ok(install.includes('`.context-ledger` in your home folder'));
});

test('P5e: every context-ledger command the Install section shows is one the bin runs', async t => {
  const usage = await run(process.execPath, [bin], { encoding: 'utf8' }).then(() => '', error => error.stderr);
  // The command at the start of a code span or line, not a package path ending in its name.
  const shown = new Set([...install.matchAll(/(?:^|`)context-ledger (\w[\w-]*)/gmu)].map(match => match[1]));
  for (const word of ['start', 'login', 'import', 'search', 'install', 'uninstall']) assert.ok(shown.has(word), word);
  for (const word of shown) {
    if (word === 'start' || word === 'mcp') continue;
    assert.match(usage, new RegExp(`(?:-- |\\|)${word}\\b`, 'u'), `${word} is a CLI command`);
  }

  // The ones that need a running ledger, as the section shows them, on a temporary home.
  const directory = await mkdtemp(join(tmpdir(), 'ledger-p5e-'));
  const home = join(directory, 'home');
  await mkdir(home);
  const port = await new Promise((done, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => { const { port: free } = server.address(); server.close(() => done(free)); });
  });
  const env = { ...process.env, HOME: home, USERPROFILE: home, PORT: String(port) };
  delete env.CONTEXT_LEDGER_DB;
  const child = spawn(process.execPath, [bin, 'start'], { env, cwd: directory, stdio: ['ignore', 'pipe', 'ignore'] });
  const ended = once(child, 'exit').catch(() => {});
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await ended; }
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  let output = '';
  await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error('No start within 60 s: ' + output)), 60_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes(`listening at http://127.0.0.1:${port}`) && /login\?code=/u.test(output)) { clearTimeout(timer); done(); }
    });
    ended.then(() => { clearTimeout(timer); fail(new Error('The ledger exited: ' + output)); });
  });
  const ledger = (...args) => run(process.execPath, [bin, ...args], { env: { ...env, CONTEXT_LEDGER_CLAUDE_BIN: process.execPath }, cwd: directory, encoding: 'utf8' });
  const transcript = join(directory, 'session.jsonl');
  await writeFile(transcript, JSON.stringify({ type: 'user', message: { role: 'user', content: 'Synthetic launch words.' } }) + '\n');
  assert.match((await ledger('login')).stdout, /\/login\?code=/u);
  await ledger('import', '--provider', 'claude', transcript);
  assert.equal(JSON.parse((await ledger('search', 'launch', 'words')).stdout).length, 1);
  assert.match((await ledger('install', '--dry-run', '--agent', 'claude')).stdout, /would run/u);
});
