#!/usr/bin/env node
// Add or remove the Context Ledger hooks in ~/.claude/settings.json: a PreToolUse hook that
// sends every subagent delegation through a graph, and a UserPromptSubmit reminder.
//
//   node claude/install.mjs            add the hooks (a backup of settings.json is kept)
//   node claude/install.mjs --remove   remove them
//
// The MCP server itself is added with `claude mcp add` (see README).
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const settingsPath = process.env.CLAUDE_SETTINGS_PATH ?? join(homedir(), '.claude', 'settings.json');
const script = name => fileURLToPath(new URL(`./hooks/${name}`, import.meta.url));
const command = name => `${JSON.stringify(process.execPath)} ${JSON.stringify(script(name))}`;
// Each event gets one hook of ours; reinstalling replaces it, --remove takes it out.
const ours = [
  { event: 'PreToolUse', matcher: 'Agent|Task', file: 'require-ledger-handoff.mjs' },
  { event: 'UserPromptSubmit', file: 'ledger-reminder.mjs' },
];
const remove = process.argv.includes('--remove');

const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {};
if (existsSync(settingsPath)) copyFileSync(settingsPath, `${settingsPath}.bak-${Date.now()}`);

settings.hooks ??= {};
for (const { event, matcher, file } of ours) {
  const groups = (settings.hooks[event] ?? [])
    .map(group => ({ ...group, hooks: (group.hooks ?? []).filter(hook => !String(hook.command ?? '').includes(file)) }))
    .filter(group => group.hooks.length > 0);
  if (!remove) groups.push({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: command(file), timeout: 10 }] });
  if (groups.length) settings.hooks[event] = groups;
  else delete settings.hooks[event];
}
if (!Object.keys(settings.hooks).length) delete settings.hooks;

mkdirSync(dirname(settingsPath), { recursive: true });
writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
console.log(remove
  ? `Removed the Context Ledger hooks from ${settingsPath}.`
  : `Added the Context Ledger hooks (subagent handoffs through graphs, and a one-line reminder per message) to ${settingsPath}.`);
