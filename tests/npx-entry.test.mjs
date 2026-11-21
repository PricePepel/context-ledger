// Card P5c: the context-ledger bin, the publishable package and install through npx.
// Synthetic data only; every ledger here runs on a temporary home folder.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { mcpPath, mcpServerCommand } from '../src/install.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(repo, 'bin', 'context-ledger.mjs');
const cli = join(repo, 'src', 'cli.mjs');
const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
const run = promisify(execFile);

// npm's own scripts, run with this node and no shell (a .cmd shim needs cmd.exe).
const npmScript = name => [
  join(dirname(process.execPath), 'node_modules', 'npm', 'bin', name),
  join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', name),
].find(existsSync);

async function scratch(t, prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const cleanups = [];
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  return { directory, later: cleanup => cleanups.push(cleanup) };
}

const freePort = () => new Promise((done, fail) => {
  const server = createServer();
  server.once('error', fail);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => done(port));
  });
});

// A home folder of its own: HOME and USERPROFILE, with no CONTEXT_LEDGER_DB.
const homeEnv = (home, extra = {}) => {
  const env = { ...process.env, HOME: home, USERPROFILE: home, ...extra };
  delete env.CONTEXT_LEDGER_DB;
  return env;
};

const exec = (file, args, options) => run(process.execPath, [file, ...args], { encoding: 'utf8', timeout: 120_000, ...options })
  .then(({ stdout, stderr }) => ({ code: 0, stdout, stderr }), error => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }));

// npx starts the bin in a child of its own, which a plain kill of npx leaves running (on
// Windows it then holds the folder open). So the whole tree stops: taskkill /T on Windows,
// the process group elsewhere.
async function startBin(t, later, args, env, cwd) {
  const windows = process.platform === 'win32';
  const child = spawn(process.execPath, [...args], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: !windows });
  const ended = once(child, 'exit').catch(() => {});
  let running = true;
  ended.then(() => { running = false; });
  later(async () => {
    if (windows) {
      await run(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/T', '/F']).catch(() => {});
    } else {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
    }
    if (running) await ended;
  });
  let output = '';
  await new Promise((done, fail) => {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      if (/listening at http:\/\/127\.0\.0\.1:\d+/u.test(output)) done();
    });
    ended.then(() => fail(new Error('The ledger exited before listening: ' + output)));
  });
}

test('P5c: the package is publishable, and the tarball holds only the allowlist', async () => {
  assert.equal(pkg.private, undefined);
  assert.equal(pkg.license, 'MIT');
  assert.deepEqual(pkg.bin, { 'context-ledger': 'bin/context-ledger.mjs' });
  assert.equal(pkg.repository.url, 'git+https://github.com/PricePepel/context-ledger.git');
  assert.equal(pkg.engines.node, '>=22.14.0');
  assert.deepEqual(Object.keys(pkg.dependencies), ['ajv'], 'no new runtime dependency');
  assert.match(readFileSync(bin, 'utf8'), /^#!\/usr\/bin\/env node\n/u);
  const { stdout } = await run(process.execPath, [npmScript('npm-cli.js'), 'pack', '--dry-run', '--json'], { cwd: repo, encoding: 'utf8', timeout: 120_000 });
  const files = JSON.parse(stdout)[0].files.map(file => file.path.replaceAll('\\', '/')).sort();
  const allowed = path => ['LICENSE', 'README.md', 'package.json', 'rules/latent-rules.json'].includes(path)
    || ['bin/', 'src/', 'public/', 'schemas/'].some(prefix => path.startsWith(prefix));
  assert.deepEqual(files.filter(path => !allowed(path)), []);
  for (const path of files) {
    assert.doesNotMatch(path, /(?:^|\/)(?:tests?|fixtures|docs|demo|runtime)\/|\.(?:sqlite|env|pem|key|token)$|(?:^|\/)\.env/u, path);
  }
  for (const needed of ['bin/context-ledger.mjs', 'src/server.mjs', 'src/mcp.mjs', 'src/cli.mjs', 'public/index.html', 'schemas/semantic-graph-v2.schema.json']) {
    assert.ok(files.includes(needed), needed);
  }
});

test('P5c: every other argument list runs the CLI exactly as npm run ledger does', async t => {
  const { directory } = await scratch(t, 'ledger-p5c-cli-');
  const env = { ...process.env, PORT: String(await freePort()), CONTEXT_LEDGER_DB: join(directory, 'ledger.sqlite') };
  for (const args of [[], ['search', 'vela'], ['graph', 'read', 'x'], ['nope']]) {
    const viaBin = await exec(bin, args, { env, cwd: directory });
    const viaCli = await exec(cli, args, { env, cwd: directory });
    assert.deepEqual(viaBin, viaCli, args.join(' '));
    assert.equal(viaBin.code, 1, args.join(' '));
  }
  // start and mcp take nothing after them; anything after is the CLI's to refuse.
  assert.deepEqual(await exec(bin, ['start', 'now'], { env, cwd: directory }), await exec(cli, ['start', 'now'], { env, cwd: directory }));
});

test('P5c: under the bin the server, CLI and MCP adapter share the per-user database from any folder', async t => {
  const { directory, later } = await scratch(t, 'ledger-p5c-home-');
  const home = join(directory, 'home');
  const elsewhere = join(directory, 'elsewhere');
  await mkdir(home);
  await mkdir(elsewhere);
  const port = await freePort();
  const env = homeEnv(home, { PORT: String(port) });
  await startBin(t, later, [bin, 'start'], env, directory);
  const database = join(home, '.context-ledger', 'ledger.sqlite');
  assert.ok(existsSync(database), 'the database is in the home folder');
  assert.ok((await readdir(join(home, '.context-ledger'))).includes(`ledger.sqlite.${port}.token`));
  const transcript = join(elsewhere, 'vela.jsonl');
  await writeFile(transcript, JSON.stringify({ type: 'user', message: { role: 'user', content: 'Vela: synthetic launch notes' } }) + '\n');
  const searched = await exec(bin, ['search', 'vela'], { env, cwd: elsewhere });
  assert.deepEqual([searched.code, searched.stdout], [0, '[]\n'], searched.stderr);
  const imported = await exec(bin, ['import', '--provider', 'claude', transcript], { env, cwd: elsewhere });
  assert.equal(imported.code, 0, imported.stderr);
  const found = await exec(bin, ['search', 'vela'], { env, cwd: elsewhere });
  assert.equal(JSON.parse(found.stdout).length, 1);
  // The MCP adapter through the bin, started in another folder, finds the token too.
  const adapter = spawn(process.execPath, [bin, 'mcp'], { env: { ...env }, cwd: elsewhere, stdio: ['pipe', 'pipe', 'pipe'] });
  later(async () => { if (adapter.exitCode === null) { adapter.kill(); await once(adapter, 'exit'); } });
  let lines = '';
  adapter.stdout.setEncoding('utf8');
  const reply = id => new Promise(done => {
    const check = () => {
      const line = lines.split('\n').find(text => text.includes(`"id":${id}`));
      if (line) { adapter.stdout.off('data', onData); done(JSON.parse(line)); }
    };
    const onData = chunk => { lines += chunk; check(); };
    adapter.stdout.on('data', onData);
    check();
  });
  adapter.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } }) + '\n');
  await reply(1);
  adapter.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'session_search', arguments: { query: 'vela' } } }) + '\n');
  const result = (await reply(2)).result;
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.equal(JSON.parse(result.content[0].text).sessions.length, 1);
  // A database the person names is kept.
  const named = join(directory, 'named.sqlite');
  const kept = await exec(bin, ['import', '--provider', 'claude', transcript], { env: { ...env, CONTEXT_LEDGER_DB: named }, cwd: elsewhere });
  assert.equal(kept.code, 0, kept.stderr);
  assert.ok(existsSync(named));
});

test('P5c: install registers npx when run through it, and node with this file otherwise', () => {
  assert.deepEqual(mcpServerCommand({}), ['node', mcpPath], 'a checkout');
  assert.deepEqual(mcpServerCommand({ npm_command: 'exec' }), ['node', mcpPath], 'npm exec outside the npx cache');
  const cached = join('C:', 'Users', 'leo', 'AppData', 'Local', 'npm-cache', '_npx', '4e59c1e0bc7fa72b', 'node_modules', pkg.name, 'src', 'mcp.mjs');
  const spec = 'github:PricePepel/context-ledger';
  assert.deepEqual(mcpServerCommand({ npm_command: 'exec', npm_config_package: spec }, { file: cached, platform: 'linux' }),
    ['npx', '-y', '--package', spec, 'context-ledger', 'mcp']);
  assert.deepEqual(mcpServerCommand({ npm_command: 'exec', npm_config_package: spec }, { file: cached, platform: 'win32' }),
    ['cmd', '/c', 'npx', '-y', '--package', spec, 'context-ledger', 'mcp']);
  for (const odd of [undefined, '', 'a b', `a${String.fromCodePoint(10)}b`, 'x%PATH%', 'say"hi', 'x'.repeat(501)]) {
    assert.deepEqual(mcpServerCommand({ npm_command: 'exec', npm_config_package: odd }, { file: cached, platform: 'darwin' }),
      ['npx', '-y', '--package', `${pkg.name}@${pkg.version}`, 'context-ledger', 'mcp'], JSON.stringify(odd));
  }
  assert.deepEqual(mcpServerCommand({ npm_command: 'run-script' }, { file: cached }), ['node', cached], 'not npx');
});

test('P5c: from a packed tarball in an empty folder, npx starts the ledger, imports, publishes and reads', async t => {
  const { directory, later } = await scratch(t, 'ledger-p5c-pack-');
  const packed = await run(process.execPath, [npmScript('npm-cli.js'), 'pack', '--silent', '--pack-destination', directory], { cwd: repo, encoding: 'utf8', timeout: 120_000 });
  const tarball = join(directory, packed.stdout.trim().split(/\r?\n/u).at(-1));
  const empty = join(directory, 'empty');
  const home = join(directory, 'home');
  await mkdir(empty);
  await mkdir(home);
  const port = await freePort();
  const env = homeEnv(home, { PORT: String(port), npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' });
  const npx = [npmScript('npx-cli.js'), '-y', '--package', tarball, 'context-ledger'];
  await startBin(t, later, [...npx, 'start'], env, empty);
  const transcript = join(empty, 'leo.jsonl');
  await writeFile(transcript, JSON.stringify({ type: 'user', message: { role: 'user', content: 'Leo: ship the synthetic adapter on port 4317.' } }) + '\n');
  const call = async args => {
    const result = await exec(npx[0], [...npx.slice(1), ...args], { env, cwd: empty });
    assert.equal(result.code, 0, `${args.join(' ')}: ${result.stderr}`);
    return result.stdout;
  };
  await call(['import', '--provider', 'claude', transcript]);
  const [session] = JSON.parse(await call(['search', 'adapter']));
  const packet = join(empty, 'packet.json');
  await writeFile(packet, JSON.stringify({ version: 2, sessionId: session.id, party: 'leo', nodes: [{ id: 'port', kind: 'decision', label: 'Port 4317', evidenceLines: [1] }], edges: [] }));
  const published = JSON.parse(await call(['graph', 'publish', packet]));
  const read = JSON.parse(await call(['graph', 'read', published.graph.id]));
  assert.equal(read.graph.packet.nodes[0].label, 'Port 4317');
  assert.ok(existsSync(join(home, '.context-ledger', 'ledger.sqlite')));
});
