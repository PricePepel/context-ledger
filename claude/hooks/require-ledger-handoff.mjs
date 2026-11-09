#!/usr/bin/env node
// Claude Code PreToolUse hook: every delegation to a subagent goes through a Context
// Ledger graph unless the user opted out. A subagent prompt must carry a graph ID; the
// marker [no-ledger] is accepted only when the user's own words in this session opt out,
// or after Context Ledger reported its handoff limit or an outage. A refused call exits 2
// and Claude reads why on stderr. Anything else, including input this hook cannot read,
// is let through.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const delegationTools = new Set(['Agent', 'Task']);
const maxInputBytes = 4 * 1024 * 1024;
const maxTranscriptBytes = 64 * 1024 * 1024;

// "без Context Ledger", "не используй леджер", "without the ledger", "don't use Context Ledger", "[no-ledger]".
export const optOut = new RegExp(
  '\\[no-ledger\\]|(?:без|не\\s+(?:используй|использовать|нужен|надо)|отключи|выключи|without|don\'?t\\s+use|do\\s+not\\s+use|stop\\s+using|skip)' +
  '\\s+(?:the\\s+)?(?:context[\\s-]?ledger|ledger|леджер[а-яё]*|контекст[\\s-]?леджер[а-яё]*)', 'iu');
// Only Context Ledger writes these, when it cannot take a handoff.
const unavailable = /graph handoffs for this month are used up|cannot reach its usage service|Cannot reach Context Ledger|Context Ledger could not start|Context Ledger did not answer/u;
const notice = /^<(task-notification|local-command-caveat|local-command-stdout|local-command-stderr|system-reminder)>[\s\S]*<\/\1>$/u;

/** What the main session's transcript says: did the user opt out, did the ledger turn a handoff away? */
export function sessionFacts(transcript) {
  let userOptedOut = false;
  let ledgerUnavailable = false;
  for (const line of transcript.split('\n')) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record?.type !== 'user' || record.isSidechain === true) continue;
    const content = record.message?.content;
    if (record.isMeta !== true) {
      const texts = typeof content === 'string' ? [content]
        : Array.isArray(content) ? content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text) : [];
      if (texts.some(text => !notice.test(text.trim()) && optOut.test(text))) userOptedOut = true;
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'tool_result' && unavailable.test(JSON.stringify(block.content ?? ''))) ledgerUnavailable = true;
      }
    }
  }
  return { userOptedOut, ledgerUnavailable };
}

const publishFirst = 'Call handoff_publish (context-ledger) once with what the subagents need, citing evidenceQuotes ' +
  'from this session; if it is not loaded, load it with ToolSearch query "select:mcp__context-ledger__handoff_publish". ' +
  'Then start each subagent prompt with the line it returns, and send all subagents again with that graph ID.';

/** `facts` is sessionFacts() of the transcript, or undefined when it could not be read. */
export function verdict(input, facts) {
  if (typeof input !== 'object' || input === null || !delegationTools.has(input.tool_name)) return { allow: true };
  const prompt = input.tool_input?.prompt;
  if (typeof prompt !== 'string') return { allow: true };
  if (/\b[a-f0-9]{64}\b/u.test(prompt)) return { allow: true };
  if (/\[no-ledger\]/iu.test(prompt)) {
    if (!facts || facts.userOptedOut || facts.ledgerUnavailable) return { allow: true };
    return {
      allow: false,
      reason: 'Context Ledger: [no-ledger] is only for when the user asked to work without Context Ledger, and the user ' +
        `has not asked that in this session. ${publishFirst}`,
    };
  }
  return {
    allow: false,
    reason: `Context Ledger: hand context to this subagent through a graph. ${publishFirst} If the user asked to work ` +
      'without Context Ledger, or Context Ledger reported its limit or an outage, write [no-ledger] in the subagent prompt instead.',
  };
}

function readFacts(path) {
  if (typeof path !== 'string' || !path.endsWith('.jsonl')) return;
  try {
    const bytes = readFileSync(path);
    if (bytes.length > maxTranscriptBytes) return;
    return sessionFacts(bytes.toString('utf8'));
  } catch {
    return undefined;
  }
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
  const needsFacts = typeof input?.tool_input?.prompt === 'string' && /\[no-ledger\]/iu.test(input.tool_input.prompt);
  const { allow, reason } = verdict(input, needsFacts ? readFacts(input.transcript_path) : undefined);
  if (!allow) {
    process.stderr.write(reason + '\n');
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch(() => {});
}
