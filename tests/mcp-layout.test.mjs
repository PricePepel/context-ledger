import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { startMcp } from './mcp-client.mjs';

// The MCP adapter: the entry point clients start, and the modules in src/mcp/ (card H3).
async function adapterFiles() {
  const folder = new URL('../src/mcp/', import.meta.url);
  const names = (await readdir(folder)).filter(name => name.endsWith('.mjs')).sort();
  const files = [{ name: 'src/mcp.mjs', source: await readFile(new URL('../src/mcp.mjs', import.meta.url), 'utf8') }];
  for (const name of names) files.push({ name: `src/mcp/${name}`, source: await readFile(new URL(name, folder), 'utf8') });
  return files;
}

test('the adapter is split into files of at most 400 lines with no new dependency', async () => {
  const files = await adapterFiles();
  assert.ok(files.length >= 8, 'the adapter is split by responsibility');
  for (const { name, source } of files) {
    const lines = source.split('\n').length - (source.endsWith('\n') ? 1 : 0);
    assert.ok(lines <= 400, `${name} has ${lines} lines`);
    // Only relative modules, node built-ins and the package manifest; no package import.
    for (const [, specifier] of source.matchAll(/^import [^'"]*['"]([^'"]+)['"]/gm)) {
      assert.match(specifier, /^(?:\.\.?\/|node:)/, `${name} imports ${specifier}`);
    }
  }
});

test('no adapter file names the decisions route, and only the ledger client makes requests', async () => {
  for (const { name, source } of await adapterFiles()) {
    assert.doesNotMatch(source, /decisions/, `${name} never names the decisions route`);
    if (name !== 'src/mcp/ledger.mjs') assert.doesNotMatch(source, /\bfetch\(/, `${name} sends no request of its own`);
  }
});

// tests/mcp.test.mjs pins the tool names and order; this checks the entry point itself.
test('node src/mcp.mjs still starts the adapter, answers on stdout only and exits when stdin ends', async () => {
  const client = startMcp(1);
  const { result } = await client.request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  assert.equal(result.serverInfo.name, 'context-ledger');
  assert.ok((await client.request(2, 'tools/list')).result.tools.length > 0);
  assert.equal(await client.close(), 0);
  assert.deepEqual(client.nonProtocol(), []);
  assert.equal(client.stderr(), '');
});

test('an invalid PORT still stops the adapter before it reads stdin', async () => {
  const client = startMcp('x');
  const [code] = await client.exited;
  assert.equal(code, 1);
  assert.equal(client.stderr(), 'Invalid PORT.\n');
  assert.deepEqual(client.messages(), []);
});
