#!/usr/bin/env node
// Dogfood baseline (card L8): what a raw Markdown handoff costs on real sessions.
//
// Usage, on your own machine (real transcripts never leave it):
//
//   node bench/dogfood.mjs ~/.claude/projects ~/.codex/sessions
//   node bench/dogfood.mjs ~/.claude/projects --markdown /tmp/dogfood.md
//
// Arguments are directories (searched recursively for *.jsonl) or .jsonl files. Each
// transcript is imported with the ledger's own importer into a throwaway database in the
// OS temp directory, which is deleted at the end (also on errors and on SIGINT, SIGTERM
// and SIGHUP), and rendered with the same Markdown handoff the API meter uses.
//
// The output holds aggregates only: counts, percentiles, size buckets and the provider
// split. It never contains transcript text, file names, paths, session IDs or project
// names, so the JSON (stdout) and the --markdown report may be committed (AGENTS.md,
// section 5). Tokens are estimates, ceil(chars / 4), like the API meter.
//
// It does not build graphs: that needs an agent. It measures the baseline a graph context
// is compared with, which the synthetic benchmark (docs/benchmark.md) cannot.
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { handoffMarkdown } from '../src/handoff.mjs';
import { openStore } from '../src/store.mjs';
import { terminalJson } from '../src/text.mjs';

// The HTTP import limit in src/server.mjs: a transcript this large cannot be imported today.
export const maxImportBytes = 8 * 1024 * 1024;
export const buckets = [
  { label: 'under 1k', max: 1_000 },
  { label: '1k-10k', max: 10_000 },
  { label: '10k-50k', max: 50_000 },
  { label: '50k-200k', max: 200_000 },
  { label: '200k-1M', max: 1_000_000 },
  { label: '1M and over', max: Infinity },
];
const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const estimateTokens = text => Math.ceil(text.length / 4);

/** Every *.jsonl under the given directories, plus the given files. */
export function findTranscripts(paths) {
  const found = new Set();
  const walk = path => {
    let stat;
    try { stat = statSync(path); } catch { return; }
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path)) walk(join(path, entry));
    } else if (stat.isFile() && path.endsWith('.jsonl')) {
      found.add(resolve(path));
    }
  };
  for (const path of paths) walk(path);
  return [...found].sort();
}

/** Claude Code or Codex, from the record shapes the importer reads; undefined if neither. */
export function detectProvider(text) {
  for (const line of text.split('\n').slice(0, 200)) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (['session_meta', 'response_item', 'event_msg', 'turn_context'].includes(record?.type)) return 'codex';
    if ((record?.type === 'user' || record?.type === 'assistant') && record?.message?.role) return 'claude';
  }
  return undefined;
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    max: sorted.at(-1) ?? null,
    total: sorted.reduce((sum, value) => sum + value, 0),
  };
}

function bucketCounts(tokens) {
  const counts = Object.fromEntries(buckets.map(bucket => [bucket.label, 0]));
  for (const value of tokens) counts[buckets.find(bucket => value < bucket.max).label] += 1;
  return counts;
}

/**
 * Measure transcripts and return aggregates only. `tempRoot` is where the throwaway
 * database lives (the OS temp directory by default); `onTempDir` lets tests see it.
 */
export function measure(files, { tempRoot = tmpdir(), onTempDir } = {}) {
  const tempDir = mkdtempSync(join(tempRoot, 'context-ledger-dogfood-'));
  onTempDir?.(tempDir);
  const cleanup = () => rmSync(tempDir, { recursive: true, force: true });
  const onSignal = signal => {
    cleanup();
    process.stderr.write(`dogfood: stopped by ${signal}; temp database removed, nothing written.\n`);
    process.exit(128 + constants.signals[signal]);
  };
  for (const signal of signals) process.on(signal, onSignal);
  const store = openStore(join(tempDir, 'dogfood.sqlite'));
  const counts = { files: files.length, measured: 0, duplicates: 0, oversize: 0, unrecognized: 0, failed: 0 };
  const sessions = { claude: [], codex: [] };
  const seen = new Set();
  try {
    for (const file of files) {
      const bytes = statSync(file).size;
      if (bytes > maxImportBytes) {
        counts.oversize += 1;
        continue;
      }
      const transcript = readFileSync(file, 'utf8');
      const provider = detectProvider(transcript);
      if (!provider) {
        counts.unrecognized += 1;
        continue;
      }
      let summary;
      try {
        summary = store.importTranscript({ provider, source: 'session.jsonl', transcript });
      } catch {
        counts.failed += 1;
        continue;
      }
      if (seen.has(summary.id)) {
        counts.duplicates += 1;
        continue;
      }
      seen.add(summary.id);
      const handoff = handoffMarkdown(store.get(summary.id));
      sessions[provider].push({ bytes, messages: summary.messageCount, characters: handoff.length, tokens: estimateTokens(handoff) });
      counts.measured += 1;
    }
  } finally {
    store.close();
    cleanup();
    for (const signal of signals) process.removeListener(signal, onSignal);
  }

  const all = [...sessions.claude, ...sessions.codex];
  const summarize = list => ({
    sessions: list.length,
    handoffTokensEstimate: distribution(list.map(session => session.tokens)),
    messages: distribution(list.map(session => session.messages)),
    transcriptBytes: distribution(list.map(session => session.bytes)),
    handoffTokenBuckets: bucketCounts(list.map(session => session.tokens)),
  });
  return {
    report: 'context-ledger dogfood baseline',
    method: 'Markdown handoff of each imported session; tokens estimated as ceil(chars / 4). Aggregates only.',
    importLimitBytes: maxImportBytes,
    counts,
    oversizeShare: counts.files ? Math.round((counts.oversize / counts.files) * 1000) / 1000 : 0,
    all: summarize(all),
    byProvider: { claude: summarize(sessions.claude), codex: summarize(sessions.codex) },
  };
}

export function renderMarkdown(result) {
  const row = (name, part) => {
    const tokens = part.handoffTokensEstimate;
    return `| ${name} | ${part.sessions} | ${tokens.p50 ?? '-'} | ${tokens.p90 ?? '-'} | ${tokens.max ?? '-'} | ${tokens.total} |`;
  };
  const { counts } = result;
  return [
    '# Dogfood baseline: raw handoff size on real sessions',
    '',
    `Method: ${result.method} Generated by \`node bench/dogfood.mjs\`; no transcript text, names or paths are included.`,
    '',
    `Files: ${counts.files}. Measured: ${counts.measured}. Skipped: ${counts.oversize} over the ${result.importLimitBytes / 1024 / 1024} MiB import limit `
      + `(${Math.round(result.oversizeShare * 1000) / 10}% of files), ${counts.unrecognized} not recognized as Claude Code or Codex, `
      + `${counts.failed} that the importer rejected, ${counts.duplicates} duplicates.`,
    '',
    '| Sessions | Count | p50 handoff tokens (est.) | p90 | Max | Total |',
    '| --- | --- | --- | --- | --- | --- |',
    row('All', result.all),
    row('Claude Code', result.byProvider.claude),
    row('Codex', result.byProvider.codex),
    '',
    '| Handoff tokens (est.) | Sessions |',
    '| --- | --- |',
    ...Object.entries(result.all.handoffTokenBuckets).map(([label, count]) => `| ${label} | ${count} |`),
    '',
    'Sessions over the import limit are not measured, so the largest sessions are missing from these percentiles.',
    '',
  ].join('\n');
}

function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { markdown: { type: 'string' } } });
  if (positionals.length === 0) {
    console.error('usage: node bench/dogfood.mjs <dir-or-file.jsonl>... [--markdown FILE]');
    process.exitCode = 2;
    return;
  }
  const result = measure(findTranscripts(positionals));
  console.log(terminalJson(result));
  if (values.markdown) writeFileSync(values.markdown, renderMarkdown(result));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main();
  } catch {
    // Never echo error text: it could carry a path or transcript content.
    console.error('dogfood: failed; no report written.');
    process.exitCode = 1;
  }
}
