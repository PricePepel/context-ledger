#!/usr/bin/env node
// Real-task comparison: Claude Code agents build a small website from yesterday's
// planning session, once with Context Ledger and once without.
//
//   node evals/website/run.mjs [--chatter 600] [--runs 1] [--arms without,with] [--model sonnet] [--keep DIR]
//
// without  the session is exported as previous-session.md in the work folder. The parent
//          splits the work across "builder" subagents however Claude normally would.
// with     Claude first publishes a graph of the session (timed and priced separately).
//          The parent hands each subagent the graph ID, and subagents read context_for.
// The built site is graded on the final decisions (evals/website/fixture.mjs), several
// of which change late in the session. It spends Claude credits.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { gradeSite, makeSession } from './fixture.mjs';

const { values: o } = parseArgs({
  options: {
    port: { type: 'string', default: '4347' },
    chatter: { type: 'string', default: '600' },
    runs: { type: 'string', default: '1' },
    model: { type: 'string', default: 'sonnet' },
    arms: { type: 'string', default: 'without,with' },
    'budget-usd': { type: 'string', default: '5' },
    keep: { type: 'string' },
    out: { type: 'string' },
  },
});
const repo = fileURLToPath(new URL('../..', import.meta.url));
const port = Number(o.port);
const origin = `http://127.0.0.1:${port}`;
const session = makeSession(Number(o.chatter));
const root = o.keep ?? await mkdtemp(join(tmpdir(), 'website-eval-'));
await mkdir(root, { recursive: true });
const tool = name => `mcp__context-ledger__${name}`;

const ledgerConfig = join(root, 'mcp-ledger.json');
const emptyConfig = join(root, 'mcp-none.json');
await writeFile(ledgerConfig, JSON.stringify({ mcpServers: { 'context-ledger': {
  command: process.execPath, args: [join(repo, 'src/mcp.mjs')], env: { PORT: String(port), CONTEXT_LEDGER_AUTOSTART: '0' },
} } }));
await writeFile(emptyConfig, JSON.stringify({ mcpServers: {} }));

function startLedger() {
  const child = spawn(process.execPath, [join(repo, 'src/server.mjs')], {
    env: { ...process.env, PORT: String(port), CONTEXT_LEDGER_DB: join(root, 'ledger.sqlite') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => { if (String(chunk).includes('listening')) resolve(child); });
    child.on('exit', code => reject(new Error(`ledger exited ${code}`)));
  });
}

async function api(path, body) {
  const init = body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body),
  };
  const response = await fetch(origin + path, init);
  const data = await response.json();
  if (!response.ok) throw new Error(`${path}: ${response.status} ${data.error}`);
  return data;
}

// A clean environment: a host app's ANTHROPIC_* and CLAUDE_CODE_* variables would
// redirect the CLI's own login.
const cleanEnv = () => ({
  ...Object.fromEntries(['HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR']
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])),
  LANG: 'en_US.UTF-8',
});

function claude({ cwd, prompt, mcpConfig, builtins, allowed, agents, log }) {
  const args = [
    '-p', '--output-format', 'stream-json', '--verbose', '--model', o.model,
    '--mcp-config', mcpConfig, '--strict-mcp-config', '--no-session-persistence',
    '--permission-mode', 'acceptEdits', '--tools', builtins.join(','),
    '--allowedTools', allowed.join(','), '--max-budget-usd', o['budget-usd'],
  ];
  if (agents) args.push('--agents', JSON.stringify(agents));
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn('claude', args, { cwd, env: cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', reject);
    child.on('close', async code => {
      // Keep the raw event stream next to the site, to audit which agent called which tool.
      if (log) await writeFile(log, out);
      resolve(analyse({ code, out, err, ms: Math.round(performance.now() - started) }));
    });
    child.stdin.end(prompt);
  });
}

function analyse({ code, out, err, ms }) {
  const calls = { parent: {}, subagent: {} };
  let result = {};
  for (const line of out.split('\n')) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'assistant') {
      const who = event.parent_tool_use_id ? 'subagent' : 'parent';
      for (const block of event.message?.content ?? []) {
        if (block.type === 'tool_use') calls[who][block.name] = (calls[who][block.name] ?? 0) + 1;
      }
    }
    if (event.type === 'result') result = event;
  }
  let input = 0;
  let output = 0;
  for (const usage of Object.values(result.modelUsage ?? {})) {
    input += (usage.inputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0);
    output += usage.outputTokens ?? 0;
  }
  return {
    ok: code === 0 && !result.is_error, ms, input, output, costUsd: result.total_cost_usd ?? 0, calls,
    reply: String(result.result ?? '').slice(-600),
    error: result.is_error ? String(result.result).slice(0, 300) : (code ? err.slice(-300) : undefined),
  };
}

const builder = tools => ({
  builder: {
    description: 'Builds one part of a static website (one HTML page or the shared stylesheet) in the current folder.',
    prompt: 'You build one part of a small static website. Write only the files you were asked for, in the current folder. ' +
      'Follow the latest decisions exactly: when a decision was changed later, use the new value and never the old one.',
    tools,
  },
});

const split = 'Split the work across "builder" subagents with the Task tool, running in parallel: one for styles.css, ' +
  'one for index.html, one for menu.html and one for contact.html. Do not write the site files yourself. ' +
  'When all subagents are done, reply DONE and list the files.';

const publishPrompt = sessionId => 'Use context-ledger. Session ' + sessionId + ' is yesterday\'s planning session for a bakery website. ' +
  'Read all of it with session_read, calling it again with the fromLine it gives until no turns remain: several decisions ' +
  'change near the end. Check graph_schema (version 2), then publish a version 2 graph for party "owner" with graph_publish. ' +
  'Include only what someone building the site needs: the goal, every decision (keep a replaced decision and add a supersedes ' +
  'edge from the new decision to the old one), constraints, and pending actions. Put exact values in labels: colours, fonts, ' +
  'phone numbers, opening hours, prices, email addresses, page and file names. Skip chatter unrelated to the website. ' +
  'Cite line numbers. If graph_publish rejects the packet, fix what the error names and publish again. ' +
  'End with the graph ID alone on the last line.';

async function runArm(name, run, ids) {
  const dir = join(root, `${name}-${run}`);
  await mkdir(dir, { recursive: true });
  const row = { arm: name, run, dir };
  if (name === 'without') {
    await writeFile(join(dir, 'previous-session.md'), session.markdown);
    Object.assign(row, await claude({
      cwd: dir, mcpConfig: emptyConfig, log: join(root, `${name}-${run}-build.jsonl`),
      builtins: ['Task', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
      allowed: ['Task', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
      agents: builder(['Read', 'Write', 'Edit', 'Glob', 'Grep']),
      prompt: 'Build the Hearth & Crumb bakery website we planned in yesterday\'s session, in this folder. ' +
        'Yesterday\'s session is exported in previous-session.md here. ' + split,
    }));
  } else {
    const publish = await claude({
      cwd: dir, mcpConfig: ledgerConfig, builtins: [], log: join(root, `${name}-${run}-publish.jsonl`),
      allowed: ['session_read', 'graph_schema', 'graph_publish'].map(tool),
      prompt: publishPrompt(ids.session),
    });
    const graphId = [...publish.reply.matchAll(/[a-f0-9]{64}/gu)].at(-1)?.[0];
    row.publish = { ...publish, graphId };
    if (!graphId) return { ...row, ok: false, error: 'No graph published: ' + (publish.error ?? publish.reply) };
    const { graph } = await api('/api/graphs/' + graphId);
    row.publish.nodes = graph.packet.nodes.length;
    Object.assign(row, await claude({
      cwd: dir, mcpConfig: ledgerConfig, log: join(root, `${name}-${run}-build.jsonl`),
      builtins: ['Task', 'Read', 'Write', 'Edit', 'Glob'],
      allowed: ['Task', 'Read', 'Write', 'Edit', 'Glob', tool('context_for')],
      agents: builder(['Read', 'Write', 'Edit', 'Glob', tool('context_for')]),
      prompt: 'Build the Hearth & Crumb bakery website we planned in yesterday\'s session, in this folder. ' +
        `Yesterday's decisions are in Context Ledger graph ${graphId}. Give each subagent the graph ID and tell it to read ` +
        'the briefing itself with context_for; do not retell the decisions. ' + split,
    }));
  }
  row.grade = gradeSite(dir);
  return row;
}

const ledger = await startLedger();
const rows = [];
try {
  const { session: imported } = await api('/api/import', { provider: 'claude', source: 'bakery-planning.jsonl', transcript: session.jsonl });
  console.log(`session: ${imported.messageCount} turns, ~${Math.round(session.jsonl.length / 4 / 1000)}k tokens of JSONL, ` +
    `~${Math.round(session.markdown.length / 4 / 1000)}k tokens as Markdown. Work folder: ${root}`);
  for (let run = 1; run <= Number(o.runs); run += 1) {
    for (const name of o.arms.split(',')) {
      const row = await runArm(name, run, { session: imported.id });
      rows.push(row);
      const failed = Object.entries(row.grade?.checks ?? {}).filter(([, ok]) => !ok).map(([key]) => key);
      const publish = row.publish ? ` | publish ${(row.publish.ms / 1000).toFixed(0)} s, ${row.publish.nodes ?? 0} nodes, $${row.publish.costUsd.toFixed(3)}` : '';
      console.log(`${name.padEnd(8)} run ${run}: ${row.grade?.score ?? 0}/${row.grade?.total ?? 10}, ` +
        `${((row.ms ?? 0) / 1000).toFixed(0)} s, ${row.input ?? 0} in / ${row.output ?? 0} out tokens, $${(row.costUsd ?? 0).toFixed(3)}` +
        `${publish} | missed: ${failed.join(', ') || 'none'} | calls ${JSON.stringify(row.calls ?? {})}` +
        `${row.error ? ' | ERROR ' + row.error : ''}`);
    }
  }
} finally {
  ledger.kill();
  if (o.out) await writeFile(o.out, JSON.stringify({ chatter: Number(o.chatter), model: o.model, rows }, null, 2));
}
