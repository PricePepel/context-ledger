// Card P5d: the clean-install eval. Packs this checkout (or takes a tarball), installs it
// globally into an empty prefix, and drives the installed `context-ledger` command from an
// empty folder with an empty home folder: usage, start, import, search, graph publish and
// read, login, and the MCP adapter. Node built-ins only; not part of the package.
//   node scripts/clean-install-check.mjs [package.tgz]
// npm runs with a cache and config of its own under the temporary folder, so nothing is
// written outside it, and everything the check starts is stopped and confirmed stopped.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const windows = process.platform === 'win32';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const step = text => console.log(`clean install: ${text}`);
// Sign-in codes never reach a log, even in a failure message (P5d review).
const redact = text => String(text ?? '').replace(/code=[A-Za-z0-9_-]+/gu, 'code=<redacted>');

// npm's own script, run with this node and no shell.
const npmCli = [
  join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
].find(existsSync);
assert.ok(npmCli, 'npm-cli.js next to this node');

const freePort = () => new Promise((done, fail) => {
  const server = createServer();
  server.once('error', fail);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => done(port));
  });
});

// True when something accepts a TCP connection on host:port within 2 s.
const accepts = (host, port) => new Promise(done => {
  const socket = connect({ host, port });
  const finish = value => { socket.destroy(); done(value); };
  socket.setTimeout(2000, () => finish(false));
  socket.once('connect', () => finish(true));
  socket.once('error', () => finish(false));
});

// A space in the folder exercises the quoting of every command line. cmd.exe expands
// %NAME% even inside quotes, so a folder with % (or a quote) cannot be handed to the .cmd
// shim safely: the check refuses to run there rather than test something else (P5d review).
// Checked before anything is created, so a refusal leaves nothing behind (P5d review round 2).
if (windows && /["%]/u.test(tmpdir())) throw new Error('The temporary folder holds " or %, which cmd.exe cannot be given safely; set TEMP to another folder.');
// npm's own project config would apply to npm pack in the checkout; the repository has none.
assert.ok(!existsSync(join(repo, '.npmrc')), 'no .npmrc in the checkout');
const root = await mkdtemp(join(tmpdir(), 'ledger clean install '));
const prefix = join(root, 'prefix');
const home = join(root, 'home');
const work = join(root, 'work');
const npmCache = join(root, 'npm-cache');
const npmConfig = join(root, 'npmrc');
const npmGlobalConfig = join(root, 'npmrc-global');
for (const folder of [prefix, home, work, npmCache]) await mkdir(folder);
await writeFile(npmConfig, '');
await writeFile(npmGlobalConfig, '');
// Inherited npm settings (registry, offline, any case) are dropped, so only these apply.
const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^npm_/iu.test(name)));
const npmEnv = {
  ...inherited, npm_config_cache: npmCache, npm_config_userconfig: npmConfig, npm_config_globalconfig: npmGlobalConfig,
  npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false', npm_config_logs_dir: join(npmCache, '_logs'),
};
const npm = (args, options) => run(process.execPath, [npmCli, ...args], { encoding: 'utf8', timeout: 300_000, env: npmEnv, ...options });

// Every process now: pid -> { parent, start }, where start is the creation time, so a
// process is known by its ID and when it began. PIDs are reused, and a process ID alone
// can name an unrelated program later (P5d review round 3).
async function processTable() {
  const rows = windows
    ? (await run(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Process | Where-Object { $_.CreationDate } | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.CreationDate.ToFileTimeUtc())" }'],
      { encoding: 'utf8', timeout: 30_000 })).stdout
    : (await run('ps', ['-A', '-o', 'pid=,ppid=,lstart='], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, LC_ALL: 'C' } })).stdout;
  const table = new Map();
  for (const line of rows.split(/\r?\n/u)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(line);
    if (!match) continue;
    const start = windows ? Number(match[3]) : Date.parse(match[3]);
    if (Number.isFinite(start)) table.set(Number(match[1]), { parent: Number(match[2]), start });
  }
  return table;
}

// The tree under a running process, from the table: a child counts only when it began
// after its parent, so a parent ID that an exited process left behind, now held by
// another program, adds nothing. Entries are { pid, start }.
async function treeOf(pid) {
  const table = await processTable();
  const root = table.get(pid);
  if (!root) return [];
  const tree = [{ pid, start: root.start }];
  for (let index = 0; index < tree.length; index += 1) {
    for (const [child, info] of table) {
      if (info.parent === tree[index].pid && info.start >= tree[index].start && !tree.some(entry => entry.pid === child)) {
        tree.push({ pid: child, start: info.start });
      }
    }
  }
  return tree;
}

const started = []; // { child, ended, running, tree } for every process the check starts
const startChild = (file, list, options) => {
  const child = spawn(file, list, { ...options, detached: !windows });
  const ended = once(child, 'exit').catch(() => {});
  const entry = { child, ended, running: true, tree: [] };
  // The tree is read every 2 s while the launcher runs, so a descendant is known even
  // when a step fails before its readiness check (P5d review round 3).
  const watch = setInterval(() => {
    if (entry.running) treeOf(child.pid).then(tree => remember(entry, tree), () => {});
  }, 2000);
  watch.unref();
  ended.then(() => { entry.running = false; clearInterval(watch); });
  started.push(entry);
  return entry;
};
function remember(entry, tree) {
  for (const item of tree) if (!entry.tree.some(known => known.pid === item.pid && known.start === item.start)) entry.tree.push(item);
}

// Stops a child and everything it started, and confirms they are gone. While the launcher
// still runs, its tree is read again and the whole tree is stopped through it (taskkill /T
// on Windows, where the .cmd shim's node is a grandchild; the process group elsewhere).
// A process seen in the tree is then killed by ID only while the same ID still has the
// same creation time, so nothing that merely reuses an ID is touched. Fails unless all are
// gone within 15 s.
async function stopTree(entry) {
  if (entry.running) {
    remember(entry, await treeOf(entry.child.pid).catch(() => []));
    if (windows) {
      await run(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/pid', String(entry.child.pid), '/T', '/F'], { timeout: 15_000 }).catch(() => {});
    } else {
      try { process.kill(-entry.child.pid, 'SIGTERM'); } catch { /* already gone */ }
    }
  }
  const ours = table => entry.tree.filter(item => table.get(item.pid)?.start === item.start);
  let left = [];
  for (let waited = 0; waited <= 15_000; waited += 500) {
    left = ours(await processTable());
    if (!left.length) return;
    if (waited >= 5000) for (const item of left) { try { process.kill(item.pid, 'SIGKILL'); } catch { /* gone */ } }
    await new Promise(done => setTimeout(done, 500));
  }
  throw new Error(`Processes ${left.map(item => item.pid).join(', ')} were still running after the check stopped them.`);
}

let port;
let failure;
try {
  let tarball = process.argv[2] && resolve(process.argv[2]);
  if (!tarball) {
    const { stdout } = await npm(['pack', '--silent', '--pack-destination', root], { cwd: repo });
    tarball = join(root, stdout.trim().split(/\r?\n/u).at(-1));
  }
  step(`installing ${tarball.split(/[\\/]/u).at(-1)} into an empty prefix`);
  await npm(['install', '--global', '--prefix', prefix, tarball], { cwd: work });

  // The installed command: the .cmd shim on Windows (through cmd.exe), the bin link elsewhere.
  const command = windows ? join(prefix, 'context-ledger.cmd') : join(prefix, 'bin', 'context-ledger');
  assert.ok(existsSync(command), `the installed command at ${command}`);
  port = await freePort();
  const env = { ...process.env, HOME: home, USERPROFILE: home, PORT: String(port) };
  delete env.CONTEXT_LEDGER_DB;
  const argv = args => (windows
    ? [process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${[command, ...args].map(arg => `"${arg}"`).join(' ')}"`], { windowsVerbatimArguments: true }]
    : [command, args, {}]);
  const ledger = async (args, { expectCode = 0 } = {}) => {
    const [file, list, extra] = argv(args);
    const result = await run(file, list, { env, cwd: work, encoding: 'utf8', timeout: 120_000, ...extra })
      .then(({ stdout, stderr }) => ({ code: 0, stdout, stderr }), error => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }));
    assert.equal(result.code, expectCode, redact(`context-ledger ${args.join(' ')}: ${result.stderr}`));
    return result;
  };

  const usage = await ledger([], { expectCode: 1 });
  assert.match(usage.stderr, /^Usage: /u);
  step('no arguments prints the usage');

  const [file, list, extra] = argv(['start']);
  const server = startChild(file, list, { env, cwd: work, stdio: ['ignore', 'pipe', 'pipe'], ...extra });
  let output = '';
  await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error(redact('The ledger did not start within 60 s: ' + output))), 60_000);
    server.child.stdout.setEncoding('utf8');
    server.child.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes(`listening at http://127.0.0.1:${port}`)) { clearTimeout(timer); done(); }
    });
    server.ended.then(() => { clearTimeout(timer); fail(new Error(redact('The ledger exited before listening: ' + output))); });
  });
  remember(server, await treeOf(server.child.pid));
  // Loopback only: the port answers on 127.0.0.1 and on none of this machine's other
  // addresses (P5d review: the banner alone does not prove the bind address).
  assert.ok(await accepts('127.0.0.1', port), 'the ledger answers on 127.0.0.1');
  const others = Object.values(networkInterfaces()).flat().filter(entry => entry && !entry.internal && entry.family === 'IPv4').map(entry => entry.address);
  for (const address of others) assert.equal(await accepts(address, port), false, `the ledger does not answer on ${address}`);
  const data = join(home, '.context-ledger');
  assert.deepEqual((await readdir(data)).filter(name => name.endsWith('.token') || name.endsWith('.sqlite')).sort(),
    ['ledger.sqlite', `ledger.sqlite.${port}.token`]);
  step(`started on port ${port}, loopback only (${others.length} other addresses refused), with its database and token file in the home folder`);

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
  assert.ok(new RegExp(`http://127\\.0\\.0\\.1:${port}/login\\?code=[A-Za-z0-9_-]{43}`, 'u').test(login.stdout), redact(`login printed: ${login.stdout}`));
  step('login prints a one-time sign-in link');

  const [mcpFile, mcpList, mcpExtra] = argv(['mcp']);
  const adapter = startChild(mcpFile, mcpList, { env, cwd: work, stdio: ['pipe', 'pipe', 'pipe'], ...mcpExtra });
  // Whole lines only, since a pipe can split a reply anywhere; a closed stdout fails the
  // wait once its last line has been read.
  let buffered = '';
  let closed = false;
  const messages = [];
  adapter.child.stdout.setEncoding('utf8');
  adapter.child.stdout.on('data', chunk => {
    buffered += chunk;
    let end;
    while ((end = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, end).trim();
      buffered = buffered.slice(end + 1);
      try { messages.push(JSON.parse(line)); } catch { /* not a protocol line */ }
    }
  });
  adapter.child.stdout.once('close', () => { closed = true; });
  const reply = id => new Promise((done, fail) => {
    const finish = result => { clearTimeout(timer); clearInterval(poll); result(); };
    const timer = setTimeout(() => finish(() => fail(new Error(`No MCP reply ${id} within 60 s.`))), 60_000);
    const poll = setInterval(() => {
      const message = messages.find(candidate => candidate?.id === id);
      if (message) finish(() => done(message));
      else if (closed) finish(() => fail(new Error(`The MCP adapter closed its output before reply ${id}.`)));
    }, 50);
  });
  const send = message => adapter.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } });
  assert.equal((await reply(1)).result.serverInfo.name, 'context-ledger');
  remember(adapter, await treeOf(adapter.child.pid));
  send({ id: 2, method: 'tools/list' });
  assert.ok((await reply(2)).result.tools.some(tool => tool.name === 'session_search'));
  send({ id: 3, method: 'tools/call', params: { name: 'session_search', arguments: { query: 'adapter' } } });
  const found = (await reply(3)).result;
  assert.equal(found.isError, undefined, JSON.stringify(found));
  assert.deepEqual(JSON.parse(found.content[0].text).sessions.map(row => row.id), [session.id]);
  adapter.child.stdin.end();
  await Promise.race([adapter.ended, new Promise(done => setTimeout(done, 15_000).unref())]);
  step('the MCP adapter answers and finds the session');
} catch (error) {
  failure = error;
} finally {
  // Everything started is stopped, whatever failed above, and the server's port must be
  // free afterwards: a stop that leaves it listening fails the eval (P5d review).
  for (const entry of started.reverse()) await stopTree(entry).catch(error => { failure ??= error; });
  if (port !== undefined) {
    let free = false;
    for (let attempt = 0; attempt < 30 && !free; attempt += 1) {
      free = !(await accepts('127.0.0.1', port));
      if (!free) await new Promise(done => setTimeout(done, 500));
    }
    if (!free) failure ??= new Error(`The ledger still listens on port ${port} after it was stopped.`);
  }
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(error => { failure ??= error; });
}
if (failure) throw failure;
step('stopped (the port is free), and the temporary folder is removed');
