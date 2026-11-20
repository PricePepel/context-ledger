// Running the claude and codex CLIs for the handoff benchmark. The process handling is
// copied from demo/rehearse.mjs (which runs on import, so it cannot be imported), with
// one change: both CLIs report every tool call, so a run that uses a tool outside its
// arm can be marked invalid. Nothing here runs on import.
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const running = new Set();
let interrupted = false;

/** Stop every running agent (Ctrl-C). */
export function interruptAll() {
  interrupted = true;
  for (const child of running) killTree(child);
}

// The CLIs run under cmd.exe (Windows) or as a process group leader (POSIX), so a plain
// kill would stop only the wrapper and leave the agent itself running.
function killTree(child) {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => {});
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

// cmd.exe quoting: wrap in double quotes and double any inner quote.
export function winQuote(argument) {
  if (/^[\w.,:=/\\@+-]+$/u.test(argument)) return argument;
  return '"' + argument.replace(/"/g, '""').replace(/%/g, '"%"') + '"';
}

/**
 * Run a command with a hard timeout. cli is { command, prefix, shell }: the real CLIs
 * need the shell on Windows to resolve claude.cmd and codex.cmd; the fake CLI is run
 * by node directly. Every argument is ours and never comes from a transcript.
 */
export function run(cli, args, { cwd, input, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const all = [...cli.prefix, ...args];
    const child = spawn(cli.command, cli.shell ? all.map(winQuote) : all, {
      cwd, shell: cli.shell, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let grace;
    const finish = code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      running.delete(child);
      if (interrupted) return reject(new Error('Interrupted.'));
      resolve({ code, timedOut, stdout, stderr, ms: Math.round(performance.now() - started) });
    };
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      // Grandchildren can hold the pipes open; stop waiting for them shortly after.
      grace = setTimeout(() => finish(null), 5000);
    }, timeoutMs);
    running.add(child);
    child.on('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      running.delete(child);
      reject(error);
    });
    child.on('close', finish);
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

const lines = text => text.split('\n').flatMap(line => {
  try {
    const value = JSON.parse(line);
    return value && typeof value === 'object' ? [value] : [];
  } catch {
    return [];
  }
});

/**
 * Claude Code's stream-json output: tool_use blocks in assistant messages, then one
 * result event with the reply, usage and cost. Input tokens include cache reads and
 * cache writes; cached is the cache reads.
 */
export function parseClaudeStream(stdout) {
  const toolCalls = {};
  let result;
  for (const event of lines(stdout)) {
    if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block?.type === 'tool_use') toolCalls[String(block.name)] = (toolCalls[String(block.name)] ?? 0) + 1;
      }
    }
    if (event.type === 'result') result = event;
  }
  const usage = result?.usage ?? {};
  return {
    reply: String(result?.result ?? ''),
    isError: result === undefined || Boolean(result.is_error),
    toolCalls,
    tokens: {
      input: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
      cached: usage.cache_read_input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
    },
    costUsd: typeof result?.total_cost_usd === 'number' ? result.total_cost_usd : null,
  };
}

/**
 * Codex exec --json events: every started item that is not a message or reasoning is a
 * tool call (MCP calls by server and tool; shell commands and the rest by type). Usage
 * comes from turn.completed; input_tokens already includes the cached ones. Codex
 * reports no cost.
 */
export function parseCodexEvents(stdout) {
  const toolCalls = {};
  const tokens = { input: 0, cached: 0, output: 0 };
  for (const event of lines(stdout)) {
    const item = event.type === 'item.started' ? event.item : undefined;
    if (item && item.type !== 'agent_message' && item.type !== 'reasoning') {
      const name = item.type === 'mcp_tool_call' ? `mcp__${item.server}__${item.tool}` : String(item.type);
      toolCalls[name] = (toolCalls[name] ?? 0) + 1;
    }
    const usage = event.type === 'turn.completed' ? event.usage : undefined;
    if (usage) {
      tokens.input += usage.input_tokens ?? 0;
      tokens.cached += usage.cached_input_tokens ?? 0;
      tokens.output += usage.output_tokens ?? 0;
    }
  }
  return { toolCalls, tokens, costUsd: null };
}

export const toolName = name => `mcp__context-ledger__${name}`;

/** The argument lists, without the prompt (sent on stdin). */
export function claudeArgs({ model, config, tools }) {
  return [
    '-p', '--output-format', 'stream-json', '--verbose', '--model', model,
    '--mcp-config', config, '--strict-mcp-config', '--no-session-persistence',
    // No built-in tools (Read, Grep, Bash...), so the agent sees only the ledger tools.
    '--tools', '',
    '--allowedTools', tools.map(toolName).join(','),
  ];
}

export function codexArgs({ model, work, last, mcpPath, port, database, tools }) {
  const server = 'mcp_servers.context-ledger';
  const args = [
    'exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '--cd', work,
    '--output-last-message', last,
    '-c', `${server}.command=${JSON.stringify(process.execPath)}`,
    '-c', `${server}.args=[${JSON.stringify(mcpPath)}]`,
    // CONTEXT_LEDGER_DB tells the adapter where the ledger's token file is.
    '-c', `${server}.env={PORT=${JSON.stringify(String(port))},CONTEXT_LEDGER_DB=${JSON.stringify(String(database))}}`,
    '-c', `${server}.enabled_tools=[${tools.map(name => JSON.stringify(name)).join(',')}]`,
    // Only the listed ledger tools are enabled; approve them so exec never stops to ask.
    '-c', `${server}.default_tools_approval_mode="approve"`,
    '-c', 'approval_policy="never"',
  ];
  if (model) args.push('--model', model);
  args.push('-');
  return args;
}

/**
 * Ask one agent one prompt. Returns usage and tool calls; the reply is for grading only.
 * A CLI that cannot be started is a failed run, not an error, so it is still logged and
 * the remaining runs go on. Only Ctrl-C rejects.
 */
export async function ask(options) {
  const started = performance.now();
  try {
    return await askOnce(options);
  } catch (error) {
    if (interrupted) throw error;
    return {
      ok: false, timedOut: false, ms: Math.round(performance.now() - started), reply: '', toolCalls: {},
      tokens: { input: 0, cached: 0, output: 0 }, costUsd: null, error: `could not start: ${error.code ?? 'error'}`,
    };
  }
}

async function askOnce({ agent, cli, model, prompt, tools, work, mcpPath, port, database, timeoutMs }) {
  if (agent === 'claude') {
    const config = join(work, 'claude-mcp.json');
    await writeFile(config, JSON.stringify({
      mcpServers: { 'context-ledger': { command: process.execPath, args: [mcpPath], env: { PORT: String(port), CONTEXT_LEDGER_DB: database } } },
    }));
    const result = await run(cli, claudeArgs({ model, config, tools }), { cwd: work, input: prompt, timeoutMs });
    const parsed = parseClaudeStream(result.stdout);
    return {
      ok: result.code === 0 && !parsed.isError && !result.timedOut, timedOut: result.timedOut, ms: result.ms,
      reply: parsed.reply, toolCalls: parsed.toolCalls, tokens: parsed.tokens, costUsd: parsed.costUsd,
      error: result.code === 0 ? undefined : `exit ${result.code}`,
    };
  }
  const last = join(work, `codex-last-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
  const result = await run(cli, codexArgs({ model, work, last, mcpPath, port, database, tools }), { cwd: work, input: prompt, timeoutMs });
  const parsed = parseCodexEvents(result.stdout);
  const reply = await readFile(last, 'utf8').catch(() => '');
  return {
    ok: result.code === 0 && reply !== '' && !result.timedOut, timedOut: result.timedOut, ms: result.ms,
    reply, toolCalls: parsed.toolCalls, tokens: parsed.tokens, costUsd: parsed.costUsd,
    error: result.code === 0 ? undefined : `exit ${result.code}`,
  };
}
