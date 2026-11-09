#!/usr/bin/env node
// Claude Code UserPromptSubmit hook: a one-line reminder, added to the context of each
// user message, that subagent handoffs go through Context Ledger. It saves the parent
// from writing subagent prompts that the PreToolUse hook would refuse. Nothing is added
// when the message itself opts out of Context Ledger or cannot be read.
import { pathToFileURL } from 'node:url';
import { optOut } from './require-ledger-handoff.mjs';

export const reminder = 'Context Ledger is on in this session: before you delegate to subagents, load handoff_publish ' +
  '(ToolSearch query "select:mcp__context-ledger__handoff_publish"), publish one graph of what they need, and start ' +
  'each subagent prompt with the line it returns. Subagent prompts without a graph ID are refused unless the user ' +
  'asked to work without Context Ledger.';

export function reminderFor(input) {
  const prompt = input?.prompt;
  if (typeof prompt !== 'string' || optOut.test(prompt)) return '';
  return reminder;
}

async function main() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 4 * 1024 * 1024) return;
    chunks.push(chunk);
  }
  let input;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return;
  }
  const text = reminderFor(input);
  if (text) process.stdout.write(text + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch(() => {});
}
