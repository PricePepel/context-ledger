#!/usr/bin/env node
// Claude Code PreToolUse hook: every delegation to a subagent goes through a Context
// Ledger graph unless the user opted out. A subagent prompt must carry a graph ID or the
// marker [no-ledger]; otherwise the call is refused (exit 2) and Claude reads why on
// stderr. Anything else, including input this hook cannot read, is let through.
import { pathToFileURL } from 'node:url';

const delegationTools = new Set(['Agent', 'Task']);
const maxInputBytes = 4 * 1024 * 1024;

export function verdict(input) {
  if (typeof input !== 'object' || input === null || !delegationTools.has(input.tool_name)) return { allow: true };
  const prompt = input.tool_input?.prompt;
  if (typeof prompt !== 'string') return { allow: true };
  if (/\[no-ledger\]/iu.test(prompt) || /\b[a-f0-9]{64}\b/u.test(prompt)) return { allow: true };
  return {
    allow: false,
    reason: 'Context Ledger: hand context to this subagent through a graph. Call handoff_publish (context-ledger) with ' +
      'what the subagent needs, citing evidenceQuotes from this session, then put the line it returns, with the graph ID, ' +
      'in the subagent prompt. Reuse one graph ID for all subagents of the same task. If the user asked not to use ' +
      'Context Ledger, write [no-ledger] in the subagent prompt instead.',
  };
}

async function main() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > maxInputBytes) return;
    chunks.push(chunk);
  }
  let input;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return;
  }
  const { allow, reason } = verdict(input);
  if (!allow) {
    process.stderr.write(reason + '\n');
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch(() => {});
}
