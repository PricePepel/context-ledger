// Card P5d: the clean-install eval. Packs this checkout (or takes a tarball), installs it
// globally into an empty prefix, and drives the installed `context-ledger` command from an
// empty folder with an empty home folder: usage, start, import, search, graph publish and
// read, login, and the MCP adapter. Node built-ins only; not part of the package.
//   node scripts/clean-install-check.mjs [package.tgz]
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const windows = process.platform === 'win32';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const step = text => console.log(`clean install: ${text}`);

// npm's own script, run with this node and no shell.
const npmCli = [
  join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
].find(existsSync);
assert.ok(npmCli, 'npm-cli.js next to this node');
const npm = (args, options) => run(process.execPath, [npmCli, ...args], { encoding: 'utf8', timeout: 300_000, ...options });

const freePort = () => new Promise((done, fail) => {
  const server = createServer();
  server.once('error', fail);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => done(port));
  });
});

const root = await mkdtemp(join(tmpdir(), 'ledger-clean-install-'));
const prefix = join(root, 'prefix');
const home = join(root, 'home');
const work = join(root, 'work');
for (const folder of [prefix, home, work]) await mkdir(folder);
let server;

try {
  let tarball = process.argv[2] && resolve(process.argv[2]);
  if (!tarball) {
    const { stdout } = await npm(['pack', '--silent', '--pack-destination', root], { cwd: repo });
    tarball = join(root, stdout.trim().split(/\r?\n/u).at(-1));
  }
  step(`installing ${tarball.split(/[\\/]/u).at(-1)} into an empty prefix`);
  const quiet = { npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' };
  await npm(['install', '--global', '--prefix', prefix, tarball], { cwd: work, env: { ...process.env, ...quiet } });

  // The installed command: the .cmd shim on Windows (through cmd.exe), the bin link elsewhere.
  const command = windows ? join(prefix, 'context-ledger.cmd') : join(prefix, 'bin', 'context-ledger');
  assert.ok(existsSync(command), `the installed command at ${command}`);
  const port = await freePort();
  const env = { ...process.env, HOME: home, USERPROFILE: home, PORT: String(port) };
  delete env.CONTEXT_LEDGER_DB;
  const argv = args => (windows
    ? [process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${[command, ...args].map(arg => `"${arg}"`).join(' ')}"`], { windowsVerbatimArguments: true }]
    : [command, args, {}]);
  const ledger = async (args, { expectCode = 0 } = {}) => {
    const [file, list, extra] = argv(args);
    const result = await run(file, list, { env, cwd: work, encoding: 'utf8', timeout: 120_000, ...extra })
      .then(({ stdout, stderr }) => ({ code: 0, stdout, stderr }), error => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }));
    assert.equal(result.code, expectCode, `context-ledger ${args.join(' ')}: ${result.stderr}`);
    return result;
  };

  const usage = await ledger([], { expectCode: 1 });
  assert.match(usage.stderr, /^Usage: /u);
  step('no arguments prints the usage');

  const [file, list, extra] = argv(['start']);
  server = spawn(file, list, { env, cwd: work, stdio: ['ignore', 'pipe', 'pipe'], detached: !windows, ...extra });
  const ended = once(server, 'exit').catch(() => {});
  let output = '';
  await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error('The ledger did not start within 60 s: ' + output)), 60_000);
    server.stdout.setEncoding('utf8');
    server.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes(`listening at http://127.0.0.1:${port}`)) { clearTimeout(timer); done(); }
    });
    ended.then(() => { clearTimeout(timer); fail(new Error('The ledger exited before listening: ' + output)); });
  });
  const data = join(home, '.context-ledger');
  assert.deepEqual((await readdir(data)).filter(name => name.endsWith('.token') || name.endsWith('.sqlite')).sort(),
    ['ledger.sqlite', `ledger.sqlite.${port}.token`]);
  step(`started on port ${port}, with its database and token file in the home folder`);

  const transcript = join(work, 'leo.jsonl');
  await writeFile(transcript, JSON.stringify({ type: 'user', message: { role: 'user', content: 'Leo: ship the synthetic adapter on port 4317.' } }) + '\n');
  await ledger(['import', '--provider', 'claude', transcript]);
  const [session] = JSON.parse((await ledger(['search', 'adapter'])).stdout);
  assert.equal(session.source, 'leo.jsonl');
  const packet = join(work, 'packet.json');
  await writeFile(packet, JSON.stringify({ version: 2, sessionId: session.id, party: 'leo', nodes: [{ id: 'port', kind: 'decision', label: 'Port 4317', evidenceLines: [1] }], edges: [] }));
  const { graph } = JSON.parse((await ledger(['graph', 'publish', packet])).stdout);
  const read = JSON.parse((await ledger(['graph', 'read', graph.id])).stdout);
  assert.equal(read.graph.packet.nodes[0].label, 'Port 4317');
  step('import, search, graph publish and graph read');

  const login = await ledger(['login']);
  assert.match(login.stdout, new RegExp(`http://127\\.0\\.0\\.1:${port}/login\\?code=[A-Za-z0-9_-]{43}`, 'u'));
  step('login prints a one-time sign-in link');

  const [mcpFile, mcpList, mcpExtra] = argv(['mcp']);
  const adapter = spawn(mcpFile, mcpList, { env, cwd: work, stdio: ['pipe', 'pipe', 'pipe'], ...mcpExtra });
  let lines = '';
  adapter.stdout.setEncoding('utf8');
  adapter.stdout.on('data', chunk => { lines += chunk; });
  const reply = id => new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`No MCP reply ${id}: ${lines}`)), 60_000);
    const check = () => {
      const line = lines.split('\n').find(text => text.startsWith('{') && JSON.parse(text).id === id);
      if (line) { clearTimeout(timer); clearInterval(poll); done(JSON.parse(line)); }
    };
    const poll = setInterval(check, 50);
  });
  const send = message => adapter.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } });
  assert.equal((await reply(1)).result.serverInfo.name, 'context-ledger');
  send({ id: 2, method: 'tools/list' });
  assert.ok((await reply(2)).result.tools.some(tool => tool.name === 'session_search'));
  send({ id: 3, method: 'tools/call', params: { name: 'session_search', arguments: { query: 'adapter' } } });
  const found = (await reply(3)).result;
  assert.equal(found.isError, undefined, JSON.stringify(found));
  assert.deepEqual(JSON.parse(found.content[0].text).sessions.map(row => row.id), [session.id]);
  adapter.stdin.end();
  await once(adapter, 'exit');
  step('the MCP adapter answers and finds the session');
} finally {
  if (server && server.exitCode === null && server.signalCode === null) {
    if (windows) {
      await run(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/pid', String(server.pid), '/T', '/F']).catch(() => {});
    } else {
      try { process.kill(-server.pid, 'SIGTERM'); } catch { /* already gone */ }
    }
    await once(server, 'exit').catch(() => {});
  }
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
step('stopped, and the temporary folder is removed');
