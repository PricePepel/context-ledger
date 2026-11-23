import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

// Cards D1 and D2: the integration guides name real files, sections and settings.
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/\r\n/gu, '\n');

test('D2: the Capy guide matches the code and the README', () => {
  const guide = read('docs/integrations/capy.md');
  const readme = read('README.md');
  // Capy keys: a lowercase letter, then lowercase letters, digits or hyphens.
  const key = guide.match(/\*\*Key\*\* `([^`]+)`/u)?.[1];
  assert.equal(key, 'context-ledger');
  assert.match(key, /^[a-z][a-z0-9-]*$/u);
  assert.ok(existsSync(new URL('../src/mcp.mjs', import.meta.url)), 'the guide points at src/mcp.mjs');
  assert.match(guide, /`src\/mcp\.mjs`/u);
  assert.match(readme, /^## Connect an agent over MCP$/mu, 'the README section the guide links to');
  assert.ok(guide.includes('../../README.md#connect-an-agent-over-mcp'));
  // The block sits inside a list item, so its lines are compared without their indent.
  const toml = guide.match(/```toml\n([\s\S]*?)```/u)?.[1].split('\n').map(line => line.trim()).filter(Boolean);
  assert.ok(toml && readme.includes(toml.join('\n')), 'the TOML block is the README\'s');
  const links = [...guide.matchAll(/\]\((https?:[^)]+)\)/gu)].map(match => match[1]);
  assert.ok(links.length >= 8);
  for (const link of links) assert.match(link, /^https:\/\/docs\.capy\.ai\//u, link);
  assert.match(guide, /Only you/u);
  assert.match(guide, /Not checked yet/u);
  // Review round 1: the guide says first that tool output is stored in Capy's cloud.
  assert.ok(guide.indexOf('## Read this first: what leaves your computer') > 0);
  assert.ok(guide.indexOf('what leaves your computer') < guide.indexOf('## Steps'));
  assert.match(guide, /tool output" in its cloud/u);
  assert.match(readme, /^## Negotiation room$/mu, 'the README section on room decisions the guide links to');
  assert.ok(guide.includes('../../README.md#negotiation-room'));
  // The note for AGENTS.md names only tools the server has.
  const note = guide.match(/```markdown\n([\s\S]*?)```/u)?.[1] ?? '';
  const adapter = ['graphs', 'sessions'].map(file => read(`src/mcp/${file}.mjs`)).join('\n');
  const named = note.match(/\b[a-z]+_[a-z_]+\b/gu) ?? [];
  assert.ok(named.length >= 3);
  for (const tool of named) assert.ok(adapter.includes(`'${tool}'`), tool);
});
