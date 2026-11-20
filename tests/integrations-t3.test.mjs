import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

// Card D1: the T3 Code guide gives commands that match the README and the code.
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/\r\n/gu, '\n');

test('D1: the T3 Code guide matches the code and the README', () => {
  const guide = read('docs/integrations/t3code.md');
  const readme = read('README.md');
  assert.ok(existsSync(new URL('../src/mcp.mjs', import.meta.url)));
  // Every registration command names the server context-ledger and runs node with src/mcp.mjs.
  // Full commands only: lines that register a server and run node.
  const commands = guide.split('\n').filter(line => /mcp add/u.test(line) && /-- node /u.test(line));
  assert.ok(commands.length >= 2);
  assert.ok(commands.length >= 4);
  for (const line of commands) assert.match(line, /mcp add (?:--scope user )?context-ledger -- node \S*\/src\/mcp\.mjs/u, line);
  // Review round 1: discovery in T3 sessions is labelled unverified, and step 5 checks it.
  assert.match(guide, /That is likely, but unverified/u);
  assert.match(guide, /Check it from a T3 thread, once per instance/u);
  assert.ok(guide.includes('../../README.md#negotiation-room'));
  assert.match(readme, /^## Negotiation room$/mu);
  assert.match(readme, /^## Connect an agent over MCP$/mu);
  assert.ok(guide.includes('../../README.md#connect-an-agent-over-mcp'));
  assert.ok(guide.includes('../competitive-t3code-capy.md'));
  const links = [...guide.matchAll(/\]\((https?:[^)]+)\)/gu)].map(match => match[1]);
  assert.ok(links.length >= 8);
  for (const link of links) assert.match(link, /^https:\/\/github\.com\/pingdotgg\/t3code(?:\/|$)/u, link);
  assert.match(guide, /Not built yet: an importer/u);
  assert.match(guide, /Not checked yet/u);
});
