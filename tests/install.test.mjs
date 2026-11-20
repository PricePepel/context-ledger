import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { startMcp } from './mcp-client.mjs';
import { agentTargets, blockLines, endMarker, findCommand, homeOf, mcpPath, runAgent, setupAgents, startMarker, withBlock, withoutBlock } from '../src/install.mjs';

// Card G8. Every test uses a fake home folder and stub agent CLIs, so the real Claude
// Code and Codex configuration is never read or changed.
const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(repo, 'src', 'cli.mjs');
const windows = process.platform === 'win32';
const nl = String.fromCodePoint(10);
const crlf = String.fromCodePoint(13, 10);
const bom = Buffer.from([0xef, 0xbb, 0xbf]);

// The stubs follow each CLI closely enough to catch an argument in the wrong place or a
// misread answer. Claude: options -e (takes every value up to the next option), -s or
// --scope, -t or --transport; entries per scope, and get shows the local one before the
// user one; add refuses a name that its scope has. Codex: --env and --json; one global
// table, and add replaces an entry of the same name. Both print their real "no such
// server" answers. Every call is logged.
const stubSource = `
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
const [agent, ...args] = process.argv.slice(2);
const stateFile = process.env.STUB_STATE + '.' + agent + '.json';
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};
appendFileSync(process.env.STUB_STATE + '.log', JSON.stringify([agent, ...args]) + '\\n');
if (process.env.STUB_ENV) appendFileSync(process.env.STUB_STATE + '.env', process.env[process.env.STUB_ENV] + '\\n');
if (process.env.STUB_BROKEN === agent) { console.error('config file is broken'); process.exit(1); }
const save = () => writeFileSync(stateFile, JSON.stringify(state));
const fail = message => { console.error(message); process.exit(1); };
if (args[0] !== 'mcp') fail('unknown command');
const [, action, ...rest] = args;
const known = agent === 'claude' ? ['-e', '-s', '--scope', '-t', '--transport'] : ['--env', '--json'];
const options = { env: {} };
const positional = [];
for (let i = 0; i < rest.length; i += 1) {
  const arg = rest[i];
  if (arg === '--') { positional.push(...rest.slice(i + 1)); break; }
  if (arg.startsWith('-') && !known.includes(arg)) fail('error: unknown option ' + arg);
  const pair = value => { const [key, ...v] = value.split('='); if (!/^[A-Z_]+$/.test(key) || !v.length) fail('bad env ' + value); options.env[key] = v.join('='); };
  if (arg === '-e') { while (rest[i + 1] !== undefined && !rest[i + 1].startsWith('-')) pair(rest[++i]); }
  else if (arg === '--env') pair(rest[++i]);
  else if (arg === '-s' || arg === '--scope') options.scope = rest[++i];
  else if (arg === '-t' || arg === '--transport') options.transport = rest[++i];
  else if (arg === '--json') options.json = true;
  else positional.push(arg);
}
const [name, command, ...commandArgs] = positional;
const table = scope => (state[scope] ??= {});
if (agent === 'claude') {
  if (action === 'get') {
    const scope = ['local', 'user'].find(s => table(s)[name]);
    if (!scope) fail('No MCP server found with name: "' + name + '". Configured servers: other');
    const e = table(scope)[name];
    const env = Object.entries(e.env).map(([k, v]) => '    ' + k + '=' + v).join('\\n');
    console.log(name + ':\\n  Scope: ' + (scope === 'user' ? 'User config (available in all your projects)' : 'Local config (private to you in this project)')
      + '\\n  Status: ok\\n  Type: stdio\\n  Command: ' + e.command + '\\n  Args: ' + e.args.join(' ') + '\\n  Environment:\\n' + (env ? env + '\\n' : '')
      + '\\nTo remove this server, run: claude mcp remove "' + name + '" -s ' + scope);
    process.exit(0);
  }
  if (action === 'add') {
    if (!name || !command) fail('error: missing required argument');
    const scope = options.scope ?? 'local';
    if (table(scope)[name]) fail('MCP server ' + name + ' already exists in ' + scope + ' config');
    table(scope)[name] = { command, args: commandArgs, env: options.env };
    save(); process.exit(0);
  }
  if (action === 'remove') {
    const scope = options.scope ?? ['local', 'user'].find(s => table(s)[name]);
    if (!scope || !table(scope)[name]) fail('No MCP server named ' + name);
    delete table(scope)[name]; save(); process.exit(0);
  }
} else {
  const servers = table('global');
  if (action === 'get') {
    if (!servers[name]) fail("Error: No MCP server named '" + name + "' found.");
    const e = servers[name];
    console.log(JSON.stringify({ name, enabled: true, transport: { type: 'stdio', command: e.command, args: e.args, env: Object.keys(e.env).length ? e.env : null } }));
    process.exit(0);
  }
  if (action === 'add') {
    if (!name || !command) fail('error: missing required argument');
    servers[name] = { command, args: commandArgs, env: options.env };
    save(); process.exit(0);
  }
  if (action === 'remove') {
    if (!servers[name]) fail("Error: No MCP server named '" + name + "' found.");
    delete servers[name]; save(); process.exit(0);
  }
}
fail('unknown action');
`;

function sandbox(t, { codexHome } = {}) {
  // A space and a ! in every path: the CLIs, the home folder and the instruction files.
  const root = mkdtempSync(join(tmpdir(), 'ledger g8 '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home dir!x');
  const bin = join(root, 'bin dir!x');
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  const stub = join(bin, 'stub.mjs');
  writeFileSync(stub, stubSource);
  const wrapper = agent => {
    if (windows) {
      const path = join(bin, `${agent}.cmd`);
      writeFileSync(path, `@"${process.execPath}" "${stub}" ${agent} %*${crlf}`);
      return path;
    }
    const path = join(bin, agent);
    writeFileSync(path, `#!/bin/sh${nl}exec "${process.execPath}" "${stub}" ${agent} "$@"${nl}`);
    chmodSync(path, 0o755);
    return path;
  };
  const state = join(root, 'stub');
  const kept = Object.fromEntries(['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'ComSpec', 'TEMP', 'TMP', 'windir']
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  const env = { ...kept, HOME: home, USERPROFILE: home, STUB_STATE: state,
    CONTEXT_LEDGER_CLAUDE_BIN: wrapper('claude'), CONTEXT_LEDGER_CODEX_BIN: wrapper('codex') };
  if (codexHome) {
    env.CODEX_HOME = join(root, codexHome);
    mkdirSync(env.CODEX_HOME, { recursive: true });
  }
  const codexDir = env.CODEX_HOME ?? join(home, '.codex');
  const files = { claude: join(home, '.claude', 'CLAUDE.md'), codex: join(codexDir, 'AGENTS.md') };
  const ledger = (...args) => spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8' });
  const calls = () => (existsSync(state + '.log') ? readFileSync(state + '.log', 'utf8').trim().split(nl).filter(Boolean).map(line => JSON.parse(line)) : []);
  const writes = () => calls().filter(([, , action]) => action !== 'get');
  const servers = agent => (existsSync(`${state}.${agent}.json`) ? JSON.parse(readFileSync(`${state}.${agent}.json`, 'utf8')) : {});
  const seed = (agent, value) => writeFileSync(`${state}.${agent}.json`, JSON.stringify(value));
  const write = (path, content) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };
  const envSeen = () => (existsSync(state + '.env') ? readFileSync(state + '.env', 'utf8').trim().split(/\r?\n/u) : []);
  return { root, home, env, files, ledger, calls, writes, servers, seed, write, envSeen };
}

// Card G8 incident: in-process tests once took the home folder from os.homedir() and
// wrote the block into the real files. These are read now and checked by the last test.
const realHome = homedir();
const realFiles = [join(realHome, '.claude', 'CLAUDE.md'), join(realHome, '.codex', 'AGENTS.md')];
const realBefore = realFiles.map(path => (existsSync(path) ? readFileSync(path) : null));

const block = lineEnd => blockLines.map(line => line + lineEnd).join('');
const ours = (env = {}) => ({ command: 'node', args: [mcpPath], env });

test('install on an empty home registers both servers at user scope and writes one block each', t => {
  const box = sandbox(t);
  const result = box.ledger('install');
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(readFileSync(box.files.claude, 'utf8'), block(nl));
  assert.equal(readFileSync(box.files.codex, 'utf8'), block(nl));
  assert.deepEqual(box.writes(), [
    ['claude', 'mcp', 'add', '--scope', 'user', 'context-ledger', '--', 'node', mcpPath],
    ['codex', 'mcp', 'add', 'context-ledger', '--', 'node', mcpPath],
  ]);
  // Claude is never asked with mcp get, which can start project servers for a health check.
  assert.deepEqual(box.calls().filter(call => call[0] === 'claude' && call[2] === 'get'), []);
  assert.deepEqual(box.servers('claude').user['context-ledger'], ours());
  assert.deepEqual(box.servers('codex').global['context-ledger'], ours());
  assert.match(result.stdout, /Claude Code\n {2}MCP server: ran /u);
  assert.match(result.stdout, /Instructions: created /u);
  assert.deepEqual(readdirSync(dirname(box.files.claude)), ['CLAUDE.md'], 'no temporary file is left');
});

test('install twice changes nothing the second time', t => {
  const box = sandbox(t);
  assert.equal(box.ledger('install').status, 0);
  const first = [readFileSync(box.files.claude), readFileSync(box.files.codex), JSON.stringify(box.servers('claude')), JSON.stringify(box.servers('codex'))];
  const again = box.ledger('install');
  assert.equal(again.status, 0, again.stdout);
  assert.deepEqual([readFileSync(box.files.claude), readFileSync(box.files.codex), JSON.stringify(box.servers('claude')), JSON.stringify(box.servers('codex'))], first);
  assert.equal(again.stdout.match(/context-ledger is already registered; left as it is/gu).length, 2);
  assert.match(again.stdout, /already has the block/u);
  assert.equal(box.writes().filter(call => call[0] === 'codex').length, 1, 'Codex add replaces, so it is not called again');
});

test('install leaves an entry the person registered, whatever it runs', t => {
  const elsewhere = { command: 'node', args: ['/elsewhere/src/mcp.mjs'], env: { PORT: '4400' } };
  const box = sandbox(t);
  box.seed('codex', { global: { 'context-ledger': elsewhere } });
  box.seed('claude', { user: { 'context-ledger': elsewhere } });
  const result = box.ledger('install');
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.stdout.match(/already registered; left as it is/gu).length, 2);
  assert.deepEqual(box.servers('codex').global['context-ledger'], elsewhere);
  assert.deepEqual(box.servers('claude').user['context-ledger'], elsewhere);
  assert.deepEqual(box.writes().filter(call => call[0] === 'codex'), [], 'Codex add is not called over an entry');
});

test('uninstall removes the blocks, never a server, and prints the remove commands', t => {
  const box = sandbox(t);
  assert.equal(box.ledger('install').status, 0);
  const servers = [JSON.stringify(box.servers('claude')), JSON.stringify(box.servers('codex'))];
  const calls = box.calls().length;
  const result = box.ledger('uninstall');
  assert.equal(result.status, 0, result.stdout);
  assert.equal(existsSync(box.files.claude), false, 'a file holding only the block is removed');
  assert.equal(existsSync(box.files.codex), false);
  assert.equal(box.calls().length, calls, 'uninstall calls no CLI');
  assert.deepEqual([JSON.stringify(box.servers('claude')), JSON.stringify(box.servers('codex'))], servers);
  assert.match(result.stdout, /not removed by this command\. If install registered it, remove it with: .*claude.* mcp remove --scope user context-ledger/u);
  assert.match(result.stdout, /remove it with: .*codex.* mcp remove context-ledger/u);
  const again = box.ledger('uninstall');
  assert.equal(again.status, 0);
  assert.match(again.stdout, /no block in /u);
});

test('install and uninstall give back the bytes of a file that ended in a line break, with CRLF or BOMs', t => {
  for (const before of [`# My rules${crlf}${crlf}Be brief.${crlf}`, `Notes${nl}${nl}`, `One line${nl}`, `Indented    ${nl}    ${nl}`]) {
    const box = sandbox(t);
    box.write(box.files.claude, before);
    assert.equal(box.ledger('install', '--agent', 'claude').status, 0);
    assert.ok(readFileSync(box.files.claude, 'utf8').startsWith(before));
    assert.equal(box.ledger('uninstall', '--agent', 'claude').status, 0);
    assert.equal(readFileSync(box.files.claude, 'utf8'), before, JSON.stringify(before));
  }
  // The one byte install cannot give back: a final line break the file did not have.
  const plain = sandbox(t);
  plain.write(plain.files.claude, 'Be brief.');
  plain.ledger('install', '--agent', 'claude');
  plain.ledger('uninstall', '--agent', 'claude');
  assert.equal(readFileSync(plain.files.claude, 'utf8'), `Be brief.${nl}`);

  // A file that held only a BOM keeps it: its bytes were never empty.
  const bomOnly = sandbox(t);
  bomOnly.write(bomOnly.files.claude, bom);
  bomOnly.ledger('install', '--agent', 'claude');
  bomOnly.ledger('uninstall', '--agent', 'claude');
  assert.deepEqual(readFileSync(bomOnly.files.claude), bom);

  const box = sandbox(t);
  const withBoms = Buffer.concat([bom, bom, Buffer.from(`Rules${crlf}`)]);
  box.write(box.files.claude, withBoms);
  assert.equal(box.ledger('install', '--agent', 'claude').status, 0);
  const installed = readFileSync(box.files.claude);
  assert.ok(installed.subarray(0, 6).equals(Buffer.concat([bom, bom])), 'both BOMs kept');
  assert.ok(installed.toString('utf8').includes(startMarker + crlf), "the block uses the file's CRLF");
  assert.equal(box.ledger('uninstall', '--agent', 'claude').status, 0);
  assert.deepEqual(readFileSync(box.files.claude), withBoms);
  assert.equal(existsSync(box.files.codex), false, '--agent claude leaves Codex alone');
  assert.deepEqual(box.calls().filter(call => call[0] === 'codex'), []);
});

test('a line of spaces before a block is the person\'s, and stays', () => {
  const text = `Notes${nl}   ${nl}${block(nl)}`;
  assert.equal(withoutBlock(text), `Notes${nl}   ${nl}`);
});

test('--dry-run changes no file, runs no command that writes and never asks Claude', t => {
  const box = sandbox(t);
  const result = box.ledger('install', '--dry-run');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Claude Code \(dry run\)\n {2}MCP server: would run .*refuses it when the name is already registered/u);
  assert.match(result.stdout, /Codex \(dry run\)\n {2}MCP server: would run /u);
  assert.match(result.stdout, /Instructions: would create /u);
  assert.equal(existsSync(join(box.home, '.claude')), false);
  assert.equal(existsSync(join(box.home, '.codex')), false);
  assert.deepEqual(box.writes(), []);
  assert.deepEqual(box.calls().filter(call => call[0] === 'claude'), [], 'no Claude call at all');

  assert.equal(box.ledger('install').status, 0);
  const snapshot = [readFileSync(box.files.claude), JSON.stringify(box.servers('claude'))];
  const dry = box.ledger('uninstall', '--dry-run');
  assert.equal(dry.status, 0);
  assert.match(dry.stdout, /Instructions: would remove /u);
  assert.deepEqual([readFileSync(box.files.claude), JSON.stringify(box.servers('claude'))], snapshot);
  assert.equal(box.writes().length, 2);
});

test('unmatched or edited markers, UTF-16 with a BOM, NUL bytes and invalid UTF-8 are refused before any CLI call', t => {
  const cases = [
    [Buffer.from(`Notes${nl}${startMarker}${nl}half a block${nl}`), /unmatched Context Ledger markers/u],
    [Buffer.from(block(nl).replace('## Context Ledger', '## My heading')), /was edited by hand/u],
    [Buffer.from([0xff, 0xfe, 0x41, 0x00, 0x0a, 0x00]), /is not UTF-8 text/u],
    [Buffer.from([0x41, 0x00, 0x0a, 0x00]), /is not UTF-8 text/u],
    [Buffer.from([0x41, 0xff, 0x0a]), /is not valid UTF-8/u],
  ];
  for (const [content, message] of cases) {
    const box = sandbox(t);
    box.write(box.files.codex, content);
    for (const mode of ['install', 'uninstall']) {
      const result = box.ledger(mode, '--agent', 'codex');
      assert.equal(result.status, 1, mode);
      assert.match(result.stdout, message);
      assert.match(result.stdout, /Nothing changed for Codex: /u);
    }
    assert.deepEqual(readFileSync(box.files.codex), content);
    assert.deepEqual(box.calls(), [], 'the CLI was not even asked');
  }
});

test('a missing CLI skips its registration, still writes the block and fails install; uninstall needs no CLI', t => {
  const box = sandbox(t);
  box.env.CONTEXT_LEDGER_CODEX_BIN = join(box.root, 'no such dir', 'codex');
  box.env.CONTEXT_LEDGER_CLAUDE_BIN = join(box.root, 'no such dir', 'claude');
  const result = box.ledger('install');
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Codex\n {2}MCP server: .*codex was not found, so the server was not registered\. .*CONTEXT_LEDGER_CODEX_BIN/u);
  assert.match(result.stdout, /Claude Code\n {2}MCP server: .*claude was not found/u);
  assert.equal(readFileSync(box.files.codex, 'utf8'), block(nl));
  assert.match(box.ledger('install', '--agent', 'claude', '--dry-run').stdout, /claude was not found/u);
  const removed = box.ledger('uninstall');
  assert.equal(removed.status, 0);
  assert.equal(existsSync(box.files.codex), false);
  assert.deepEqual(box.calls(), []);
});

test('a CLI that answers with an error is not taken as "not registered", and the file is left alone', t => {
  for (const agent of ['claude', 'codex']) {
    const box = sandbox(t);
    box.write(box.files[agent], `Rules${nl}`);
    box.env.STUB_BROKEN = agent;
    const result = box.ledger('install', '--agent', agent);
    assert.equal(result.status, 1, agent);
    assert.match(result.stdout, /failed \(config file is broken\)/u);
    assert.match(result.stdout, /Instructions: left as they are, because the server step failed/u);
    assert.equal(readFileSync(box.files[agent], 'utf8'), `Rules${nl}`);
  }
});

test('a Codex answer of the wrong shape is a failure, not a present or absent server', async t => {
  const box = sandbox(t);
  for (const stdout of ['{}', '[]', 'not json', JSON.stringify({ name: 'context-ledger', transport: { command: 'node' } })]) {
    const run = (bin, args) => (args[1] === 'get' ? { status: 0, stdout, output: stdout } : assert.fail('no add after a bad answer'));
    const { ok, lines } = setupAgents({ mode: 'install', agents: ['codex'], env: box.env, run });
    assert.equal(ok, false, stdout);
    assert.match(lines.join(nl), /could not be read/u);
  }
  assert.equal(existsSync(box.files.codex), false);
});

test('a PORT other than 4317 is passed to both servers in a place each CLI parses', t => {
  const box = sandbox(t);
  box.env.PORT = '4400';
  const result = box.ledger('install');
  assert.equal(result.status, 0, result.stdout);
  assert.deepEqual(box.writes(), [
    ['claude', 'mcp', 'add', '-e', 'PORT=4400', '--scope', 'user', 'context-ledger', '--', 'node', mcpPath],
    ['codex', 'mcp', 'add', 'context-ledger', '--env', 'PORT=4400', '--', 'node', mcpPath],
  ]);
  assert.deepEqual(box.servers('claude').user['context-ledger'], ours({ PORT: '4400' }));
  assert.deepEqual(box.servers('codex').global['context-ledger'], ours({ PORT: '4400' }));
  for (const port of ['4317x', '0', '65536', '99999']) {
    box.env.PORT = port;
    assert.equal(box.ledger('install').status, 1, port);
  }
});

test('P5b: CONTEXT_LEDGER_DB is passed to both servers as an absolute path, beside PORT', t => {
  const box = sandbox(t);
  // Relative to the folder install runs in; the agents start the adapter elsewhere.
  const database = join(box.root, 'data dir!x', 'custom.sqlite');
  box.env.CONTEXT_LEDGER_DB = database;
  const dry = box.ledger('install', '--dry-run');
  assert.equal(dry.status, 0, dry.stdout);
  // The path holds no control character, so it is printed as it is, once per agent.
  assert.equal(dry.stdout.split(`CONTEXT_LEDGER_DB=${database}`).length, 3, dry.stdout);
  assert.deepEqual(box.writes(), [], 'a dry run calls no add');
  box.env.PORT = '4400';
  const result = box.ledger('install');
  assert.equal(result.status, 0, result.stdout);
  assert.deepEqual(box.writes(), [
    ['claude', 'mcp', 'add', '-e', 'PORT=4400', '-e', `CONTEXT_LEDGER_DB=${database}`, '--scope', 'user', 'context-ledger', '--', 'node', mcpPath],
    ['codex', 'mcp', 'add', 'context-ledger', '--env', 'PORT=4400', '--env', `CONTEXT_LEDGER_DB=${database}`, '--', 'node', mcpPath],
  ]);
  assert.deepEqual(box.servers('claude').user['context-ledger'], ours({ PORT: '4400', CONTEXT_LEDGER_DB: database }));
  assert.deepEqual(box.servers('codex').global['context-ledger'], ours({ PORT: '4400', CONTEXT_LEDGER_DB: database }));
});

test('P5b: a relative CONTEXT_LEDGER_DB is resolved where install runs; empty adds nothing; bad values are refused', t => {
  const box = sandbox(t);
  box.env.CONTEXT_LEDGER_DB = join('data', 'relative.sqlite');
  const run = spawnSync(process.execPath, [cli, 'install', '--agent', 'codex'], { env: box.env, encoding: 'utf8', cwd: box.root });
  assert.equal(run.status, 0, run.stdout);
  assert.deepEqual(box.writes().at(-1), ['codex', 'mcp', 'add', 'context-ledger', '--env', `CONTEXT_LEDGER_DB=${join(realpathSync(box.root), 'data', 'relative.sqlite')}`, '--', 'node', mcpPath]);

  const empty = sandbox(t);
  empty.env.CONTEXT_LEDGER_DB = '';
  assert.equal(empty.ledger('install').status, 0);
  assert.deepEqual(empty.writes(), [
    ['claude', 'mcp', 'add', '--scope', 'user', 'context-ledger', '--', 'node', mcpPath],
    ['codex', 'mcp', 'add', 'context-ledger', '--', 'node', mcpPath],
  ]);

  for (const value of [':memory:', `a${nl}b.sqlite`, `a${String.fromCodePoint(0x1b)}[31m.sqlite`]) {
    const refused = sandbox(t);
    refused.env.CONTEXT_LEDGER_DB = value;
    const result = refused.ledger('install');
    assert.equal(result.status, 1, value);
    assert.match(result.stderr + result.stdout, /Invalid CONTEXT_LEDGER_DB: give the path of the database file\./u);
    assert.ok(!(result.stderr + result.stdout).includes(String.fromCodePoint(0x1b)), 'nothing raw is printed');
    assert.deepEqual(refused.calls(), [], 'no CLI runs');
    assert.equal(existsSync(refused.files.claude), false);
  }
});

test('P5b review: a database path cmd.exe cannot take is refused alike by the dry run and the install', { skip: !windows && 'Only Windows runs the CLIs through cmd.exe.' }, t => {
  for (const name of ['100%.sqlite', 'say"hi.sqlite']) {
    const box = sandbox(t);
    box.env.CONTEXT_LEDGER_DB = join(box.root, name);
    for (const args of [['install', '--dry-run'], ['install']]) {
      const result = box.ledger(...args);
      assert.equal(result.status, 1, `${name} ${args}: ${result.stdout}`);
      assert.equal(result.stdout.match(/a path holds " or %, which cmd\.exe cannot be given safely/gu)?.length, 2, result.stdout);
      assert.doesNotMatch(result.stdout, /would run|ran /u);
    }
    assert.deepEqual(box.writes(), [], 'no add ran');
    assert.equal(existsSync(box.files.claude), false, 'the instruction step stops with the server step');
  }
});

test('P5b review: uninstall does not read CONTEXT_LEDGER_DB, so a bad value cannot stop it', t => {
  const box = sandbox(t);
  assert.equal(box.ledger('install').status, 0);
  box.env.CONTEXT_LEDGER_DB = ':memory:';
  const result = box.ledger('uninstall');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(existsSync(box.files.claude), false);
  assert.equal(existsSync(box.files.codex), false);
});

test('P5b: the adapter started as registered reaches a ledger on a custom database and port', async t => {
  const box = sandbox(t);
  // Its own folder, removed by the one cleanup that first stops the server and adapters
  // (Windows cannot remove an open database).
  const data = mkdtempSync(join(tmpdir(), 'ledger p5b '));
  const database = join(data, 'custom', 'ledger.sqlite');
  const server = spawn(process.execPath, [join(repo, 'src', 'server.mjs')], {
    env: { ...process.env, PORT: '0', CONTEXT_LEDGER_DB: database }, stdio: ['ignore', 'pipe', 'ignore'],
  });
  const clients = [];
  t.after(async () => {
    await Promise.all(clients.map(client => client.close()));
    if (server.exitCode === null && server.signalCode === null) {
      server.kill();
      await once(server, 'exit');
    }
    rmSync(data, { recursive: true, force: true });
  });
  let output = '';
  const port = await new Promise((resolve, reject) => {
    server.stdout.setEncoding('utf8');
    server.stdout.on('data', chunk => {
      output += chunk;
      const match = /listening at http:\/\/127\.0\.0\.1:(\d+)/u.exec(output);
      if (match) resolve(match[1]);
    });
    server.once('exit', code => reject(new Error(`The server exited (${code}) before listening: ${output}`)));
  });
  box.env.PORT = port;
  box.env.CONTEXT_LEDGER_DB = database;
  assert.equal(box.ledger('install', '--agent', 'codex').status, 0);
  const registered = box.servers('codex').global['context-ledger'];
  assert.deepEqual(registered.env, { PORT: port, CONTEXT_LEDGER_DB: database });
  // The registered environment alone (no repository default) finds the token.
  const client = startMcp(Number(port), registered.env);
  clients.push(client);
  await client.request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  const result = await client.call(2, 'session_search', { query: 'vela' });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  // Without the database path, as G8 registered it, the same call finds no token.
  const before = startMcp(Number(port), { PORT: port });
  clients.push(before);
  await before.request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  assert.equal((await before.call(2, 'session_search', { query: 'vela' })).isError, true);
});

test('CODEX_HOME moves the Codex instruction file', t => {
  const box = sandbox(t, { codexHome: 'codex home' });
  assert.equal(box.ledger('install', '--agent', 'codex').status, 0);
  assert.equal(readFileSync(join(box.root, 'codex home', 'AGENTS.md'), 'utf8'), block(nl));
});

test('printed paths and parser messages are escaped, so they cannot drive the terminal', t => {
  const rlo = String.fromCodePoint(0x202e);
  const box = sandbox(t, { codexHome: `codex${rlo}home` });
  const result = box.ledger('install', '--agent', 'codex', '--dry-run');
  assert.equal(result.status, 0);
  assert.ok(!result.stdout.includes(rlo));
  assert.ok(result.stdout.includes(`codex${String.fromCodePoint(0x5c)}u202ehome`));
  const option = box.ledger('install', `--x${rlo}y`);
  assert.equal(option.status, 1);
  assert.ok(!option.stderr.includes(rlo));
  assert.match(option.stderr, /Unknown option/u);
});

test('bad arguments print the usage and change nothing', t => {
  const box = sandbox(t);
  for (const args of [['install', '--agent', 'cursor'], ['install', '--agent='], ['install', 'extra'], ['uninstall', '--force']]) {
    const result = box.ledger(...args);
    assert.equal(result.status, 1, args.join(' '));
    assert.match(result.stderr, /Usage:|Unknown option/u);
  }
  assert.deepEqual(box.calls(), []);
});

test('a symbolic link stays a link, and a file keeps its mode', t => {
  const box = sandbox(t);
  const target = join(box.root, 'dotfiles', 'AGENTS.md');
  box.write(target, `Shared rules${nl}`);
  mkdirSync(dirname(box.files.codex), { recursive: true });
  try {
    symlinkSync(target, box.files.codex);
  } catch (error) {
    if (error.code === 'EPERM') return t.skip('symbolic links need extra rights on this Windows account');
    throw error;
  }
  if (!windows) chmodSync(target, 0o600);
  assert.equal(box.ledger('install', '--agent', 'codex').status, 0);
  assert.ok(readFileSync(target, 'utf8').includes(startMarker), 'written through the link');
  if (!windows) assert.equal(statSync(target).mode & 0o777, 0o600);
  assert.equal(box.ledger('uninstall', '--agent', 'codex').status, 0);
  assert.equal(readFileSync(target, 'utf8'), `Shared rules${nl}`);
});

test('arguments with spaces, ! and shell characters reach the CLI exactly; quotes and percent signs are refused on Windows', t => {
  const box = sandbox(t);
  const args = ['mcp', 'add', '-s', 'user', 'x', '--', 'node', join(box.root, 'a b!PATH!', 'mcp.mjs'), 'a&b|c', '(x)', '^caret'];
  assert.equal(runAgent(box.env.CONTEXT_LEDGER_CLAUDE_BIN, args, { env: box.env }).status, 0);
  assert.deepEqual(box.calls().at(-1), ['claude', ...args]);
  if (windows) {
    assert.deepEqual(runAgent(box.env.CONTEXT_LEDGER_CLAUDE_BIN, ['say "hi"'], { env: box.env }), { unsafe: true });
    assert.deepEqual(runAgent(box.env.CONTEXT_LEDGER_CLAUDE_BIN, ['%PATH%'], { env: box.env }), { unsafe: true });
  }
  assert.deepEqual(runAgent(join(box.root, 'missing'), ['mcp'], { env: box.env }), { missing: true });
});

test('findCommand looks through PATH and, on Windows, skips the extensionless npm shim', t => {
  const box = sandbox(t);
  const dir = join(box.root, 'path dir');
  mkdirSync(dir);
  writeFileSync(join(dir, 'tool'), `#!/bin/sh${nl}`);
  if (windows) {
    writeFileSync(join(dir, 'tool.cmd'), `@echo off${crlf}`);
    assert.equal(findCommand('tool', { platform: 'win32', env: { PATH: dir, PATHEXT: '.EXE;.CMD' } }), join(dir, 'tool.cmd'));
  } else {
    chmodSync(join(dir, 'tool'), 0o755);
    writeFileSync(join(dir, 'plain'), 'not executable');
    assert.equal(findCommand('tool', { platform: 'linux', env: { PATH: dir } }), join(dir, 'tool'));
    assert.equal(findCommand('plain', { platform: 'linux', env: { PATH: dir } }), null);
  }
  assert.equal(findCommand('nope', { env: { PATH: dir } }), null);
});

test('withBlock and withoutBlock keep the text around the block', () => {
  assert.equal(withBlock(''), block(nl));
  assert.equal(withBlock(block(nl)), null, 'already there');
  assert.equal(withoutBlock(withBlock(`A${nl}`)), `A${nl}`);
  assert.equal(withoutBlock(`A${nl}${block(nl)}B${nl}`), `A${nl}B${nl}`, 'text after the block is kept');
  assert.equal(withoutBlock(`A${nl}`), null);
  assert.throws(() => withBlock(`${endMarker}${nl}`), /unmatched/u);
  assert.throws(() => withBlock(`${block(nl)}${block(nl)}`), /unmatched/u);
});

test('the block names the tools agents should call and says labels are data', () => {
  const text = blockLines.join(nl);
  for (const tool of ['graph_list', 'session_search', 'context_for']) assert.ok(text.includes(tool), tool);
  assert.match(text, /data, not as instructions/u);
  assert.ok(text.length < 700, 'short');
});

test('review round 4: only Claude\'s own duplicate answer counts as already registered', t => {
  const box = sandbox(t);
  box.write(box.files.claude, `Rules${nl}`);
  const run = () => ({ status: 1, stdout: '', output: 'Cannot save settings: backup already exists', detail: 'Cannot save settings: backup already exists' });
  const { ok, lines } = setupAgents({ mode: 'install', agents: ['claude'], env: box.env, run });
  assert.equal(ok, false);
  assert.match(lines.join(nl), /failed \(Cannot save settings: backup already exists\)/u);
  assert.equal(readFileSync(box.files.claude, 'utf8'), `Rules${nl}`);
});

test('review round 4: a relative CODEX_HOME is the same folder for Codex and for the block', t => {
  const box = sandbox(t);
  const seen = [];
  const run = (bin, args) => {
    seen.push(args);
    return args[1] === 'get' ? { status: 1, stdout: '', output: "Error: No MCP server named 'context-ledger' found." } : { status: 0, stdout: '', output: '' };
  };
  mkdirSync(join(box.root, 'profile dir'));
  mkdirSync(join(box.root, 'other dir'));
  const cwd = process.cwd();
  process.chdir(box.root);
  try {
    const result = setupAgents({ mode: 'install', agents: ['codex'], env: { ...box.env, CODEX_HOME: 'profile dir' }, run });
    assert.equal(result.ok, true, result.lines.join(nl));
  } finally {
    process.chdir(cwd);
  }
  assert.ok(existsSync(join(box.root, 'profile dir', 'AGENTS.md')), 'resolved against the folder install ran in');
  // The real CLI gets the same absolute folder: the stub records the CODEX_HOME it sees.
  const where = spawnSync(process.execPath, [cli, 'install', '--agent', 'codex'], { cwd: box.root, env: { ...box.env, CODEX_HOME: 'other dir', STUB_ENV: 'CODEX_HOME' }, encoding: 'utf8' });
  assert.equal(where.status, 0, where.stdout + where.stderr);
  assert.ok(existsSync(join(box.root, 'other dir', 'AGENTS.md')));
  assert.deepEqual([...new Set(box.envSeen())], [join(box.root, 'other dir')]);
});

test('review round 4: an existing Codex HTTP entry is recognised and left alone', t => {
  const box = sandbox(t);
  const stdout = JSON.stringify({ name: 'context-ledger', enabled: true, transport: { type: 'streamable_http', url: 'http://127.0.0.1:9/mcp' } });
  const run = (bin, args) => (args[1] === 'get' ? { status: 0, stdout, output: stdout } : assert.fail('no add over an entry'));
  const { ok, lines } = setupAgents({ mode: 'install', agents: ['codex'], env: box.env, run });
  assert.equal(ok, true, lines.join(nl));
  assert.match(lines.join(nl), /already registered; left as it is/u);
  assert.equal(readFileSync(box.files.codex, 'utf8'), block(nl));
});

test('review round 4: a file swapped for one with the same bytes, or given another mode, during install is not overwritten', t => {
  // The new file is written beside the old one and renamed over it, so it cannot reuse
  // the old inode (Linux reuses a freed inode at once, which CI showed).
  const swaps = [['same bytes, new file', path => {
    const fresh = `${path}.fresh`;
    writeFileSync(fresh, readFileSync(path));
    renameSync(fresh, path);
  }]];
  if (!windows) swaps.push(['mode changed', path => chmodSync(path, 0o600)]);
  for (const [what, swap] of swaps) {
    const box = sandbox(t);
    box.write(box.files.claude, `Rules${nl}`);
    const run = () => {
      swap(box.files.claude);
      return { status: 0, stdout: '', output: '' };
    };
    const { ok, lines } = setupAgents({ mode: 'install', agents: ['claude'], env: box.env, run });
    assert.equal(ok, false, what);
    assert.match(lines.join(nl), /changed while it was being updated; nothing was written to it/u, what);
    assert.equal(readFileSync(box.files.claude, 'utf8'), `Rules${nl}`, what);
  }
});

test('the home folder comes from the environment passed in, never from the real one', t => {
  const box = sandbox(t);
  assert.equal(homeOf(box.env), box.home);
  assert.equal(agentTargets(box.env).claude.instructions, join(box.home, '.claude', 'CLAUDE.md'));
  assert.throws(() => homeOf({ PATH: '' }), /No home folder/u, 'an environment without one is refused, not filled from the real home');
});

// Runs last: no test in this file may have touched the real instruction files.
test('the real ~/.claude/CLAUDE.md and ~/.codex/AGENTS.md are byte for byte as they were', () => {
  assert.deepEqual(realFiles.map(path => (existsSync(path) ? readFileSync(path) : null)), realBefore);
});

test('review round 5: a CODEX_HOME that does not exist is refused before Codex is asked', t => {
  const box = sandbox(t);
  box.env.CODEX_HOME = join(box.root, 'no such profile');
  const result = box.ledger('install', '--agent', 'codex');
  assert.equal(result.status, 1);
  assert.match(result.stdout, /CODEX_HOME is set to .*no such profile, which does not exist; Codex refuses it/u);
  assert.deepEqual(box.calls(), []);
  assert.equal(existsSync(box.env.CODEX_HOME), false);
});

test('review round 5: a longer message that contains Claude\'s duplicate line does not count', t => {
  const box = sandbox(t);
  box.write(box.files.claude, `Rules${nl}`);
  for (const output of ['MCP server context-ledger already exists in user config backup', 'Note: MCP server context-ledger already exists in user config']) {
    const run = () => ({ status: 1, stdout: '', output, detail: output });
    const { ok } = setupAgents({ mode: 'install', agents: ['claude'], env: box.env, run });
    assert.equal(ok, false, output);
  }
  const exact = () => ({ status: 1, stdout: '', output: 'MCP server context-ledger already exists in user config', detail: '' });
  assert.equal(setupAgents({ mode: 'install', agents: ['claude'], env: box.env, run: exact }).ok, true);
});

test('review round 5: the printed Codex remove command names the CODEX_HOME it is for', t => {
  const box = sandbox(t, { codexHome: 'codex profile' });
  const result = box.ledger('uninstall', '--agent', 'codex');
  assert.match(result.stdout, /remove it with CODEX_HOME set to .*codex profile with: /u);
});
