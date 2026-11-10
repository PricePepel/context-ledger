// Closed-model baseline for the M2a gate: Claude reads every fixture file and answers
// each question directly. Same system text as the latent pool (preamble v2 + rendered
// prefix), same grader. Runs through the Claude Code CLI in print mode with tools off.
// Usage: node evals/latent/baseline.mjs [--set questions|heldout|fresh] [--repeat N] [--model sonnet] [--out report.json]
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { gradeSlice, summarize } from './grade.mjs';

const { values } = parseArgs({
  options: {
    repeat: { type: 'string', default: '1' },
    out: { type: 'string' },
    set: { type: 'string', default: 'questions' },
    model: { type: 'string', default: 'sonnet' },
  },
});
const sets = { questions: './questions.json', heldout: './heldout.json', fresh: './fresh.json' };
if (!sets[values.set]) throw new Error('--set must be questions, heldout or fresh.');
const set = JSON.parse(await readFile(new URL(sets[values.set], import.meta.url), 'utf8'));
const repeat = Math.max(1, Number(values.repeat) || 1);

// Copied from runtime/latent_pool/pool.py PREAMBLE (version "2").
const PREAMBLE = "You are a careful code reader. The files below are your only source of truth. "
  + "Each file starts with a line '=== FILE: <path> ===' and every line of a file "
  + "starts with its 1-based line number followed by '| '. Answer only from these "
  + "files. When they do not say, say so. Cite evidence as a file path with "
  + "startLine and endLine taken from the line numbers, plus quote: the code from "
  + "those lines copied exactly, without the line-number prefix. State exact values "
  + "from the code (numbers with their units, names, strings) in answers and labels "
  + "rather than describing them. Do the task in the user message and reply with "
  + "JSON only, in the requested shape.";

// The contract's prefix rendering: BOM removed, CRLF to LF, a final newline ends the last line.
async function renderPrefix(paths) {
  const parts = [];
  for (const path of paths) {
    let text = await readFile(new URL(`./${set.fixture ?? 'fixture'}/${path}`, import.meta.url), 'utf8');
    text = text.replace(/^﻿/u, '').replace(/\r\n/gu, '\n');
    const lines = text === '' ? [] : text.replace(/\n$/u, '').split('\n');
    parts.push(`=== FILE: ${path} ===\n`);
    lines.forEach((line, index) => parts.push(`${index + 1}| ${line}\n`));
  }
  return parts.join('');
}

const system = `${PREAMBLE}\n\n${await renderPrefix(set.paths)}`;
const shape = '{"answer": string, "findings": [{"label": string, "evidence": [{"path": string, "startLine": number, "endLine": number, "quote": string}]}]}';
// A neutral working directory, so no project instructions reach the model.
const cwd = await mkdtemp(join(tmpdir(), 'latent-baseline-'));

function claude(question) {
  const args = ['-p', '--model', values.model, '--output-format', 'json', '--tools', '', '--strict-mcp-config',
    '--no-session-persistence', '--system-prompt', system];
  const user = `ROLE: answerer\nQuestion: ${question}\nReply with JSON only in this shape: ${shape}`;
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    const timer = setTimeout(() => child.kill(), 180_000);
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${err.slice(0, 300)}`));
      try { resolve(JSON.parse(out)); } catch { reject(new Error(`bad CLI output: ${out.slice(0, 300)}`)); }
    });
    child.stdin.end(user);
  });
}

// The first balanced JSON object in the reply; the model sometimes adds prose (with
// braces) after it, so "first { to last }" is not enough.
function firstObject(body) {
  const start = body.indexOf('{');
  if (start < 0) throw new Error('no JSON object in the reply');
  let depth = 0;
  let inString = false;
  for (let index = start; index < body.length; index += 1) {
    const char = body[index];
    if (inString) {
      if (char === '\\') index += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return body.slice(start, index + 1);
  }
  throw new Error('unbalanced JSON object in the reply');
}

function parseSlice(result) {
  const slice = JSON.parse(firstObject(String(result.result ?? '')));
  return { answer: String(slice.answer ?? ''), findings: Array.isArray(slice.findings) ? slice.findings : [] };
}

const runs = [];
for (let round = 1; round <= repeat; round += 1) {
  const results = [];
  for (const question of set.questions) {
    const started = Date.now();
    let result;
    try {
      result = await claude(question.question);
      const slice = parseSlice(result);
      const usage = result.usage ?? {};
      const inputTokens = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
      results.push({ ...gradeSlice(question, slice), ms: Date.now() - started, inputTokens,
        outputTokens: usage.output_tokens ?? 0, answer: slice.answer, labels: slice.findings.map(finding => finding.label) });
    } catch (error) {
      results.push({ id: question.id, correct: false, cited: false, error: error.message, ms: Date.now() - started,
        inputTokens: 0, outputTokens: 0, answer: '', labels: [], raw: String(result?.result ?? '').slice(0, 4000) });
    }
    const last = results.at(-1);
    console.log(`round ${round} ${question.id}: correct=${last.correct} cited=${last.cited} in=${last.inputTokens} out=${last.outputTokens} ${last.ms}ms${last.error ? ` ERROR ${last.error}` : ''}`);
  }
  const summary = summarize(results);
  const mean = key => results.reduce((sum, result) => sum + result[key], 0) / results.length;
  runs.push({ round, summary, meanInputTokens: mean('inputTokens'), meanOutputTokens: mean('outputTokens'), meanMs: mean('ms'), results });
  console.log(`round ${round}: accuracy ${summary.accuracy} citations ${summary.citationRate} meanIn ${mean('inputTokens').toFixed(0)} meanOut ${mean('outputTokens').toFixed(0)}`);
}
if (values.out) await writeFile(values.out, JSON.stringify({ model: values.model, set: values.set, runs }, null, 2) + '\n');
