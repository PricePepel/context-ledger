#!/usr/bin/env node
// Add or remove the Context Ledger delegation hook in ~/.claude/settings.json.
//
//   node claude/install.mjs            add the hook (a backup of settings.json is kept)
//   node claude/install.mjs --remove   remove it
//
// The MCP server itself is added with `claude mcp add` (see README); this only installs
// the hook that makes every subagent delegation go through a graph.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const settingsPath = process.env.CLAUDE_SETTINGS_PATH ?? join(homedir(), '.claude', 'settings.json');
const hookScript = fileURLToPath(new URL('./hooks/require-ledger-handoff.mjs', import.meta.url));
const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(hookScript)}`;
const marker = 'require-ledger-handoff.mjs';
const remove = process.argv.includes('--remove');

const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {};
if (existsSync(settingsPath)) copyFileSync(settingsPath, `${settingsPath}.bak-${Date.now()}`);

settings.hooks ??= {};
const groups = (settings.hooks.PreToolUse ?? [])
  .map(group => ({ ...group, hooks: (group.hooks ?? []).filter(hook => !String(hook.command ?? '').includes(marker)) }))
  .filter(group => group.hooks.length > 0);
if (!remove) groups.push({ matcher: 'Agent|Task', hooks: [{ type: 'command', command, timeout: 10 }] });
if (groups.length) settings.hooks.PreToolUse = groups;
else delete settings.hooks.PreToolUse;
if (!Object.keys(settings.hooks).length) delete settings.hooks;

mkdirSync(dirname(settingsPath), { recursive: true });
writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
console.log(remove
  ? `Removed the Context Ledger delegation hook from ${settingsPath}.`
  : `Added the Context Ledger delegation hook to ${settingsPath}. New Claude Code sessions pick it up.`);
