// Run the M2a gate: every question through the ledger's /api/latent/read, graded.
// Usage: LEDGER=http://127.0.0.1:4317 node evals/latent/run.mjs [--set questions|heldout] [--repeat N] [--out report.json]
// The ledger must run with LATENT_ROOT pointing at evals/latent/fixture.
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { gradeSlice, summarize } from './grade.mjs';

const { values } = parseArgs({
  options: { repeat: { type: 'string', default: '1' }, out: { type: 'string' }, set: { type: 'string', default: 'questions' } },
});
const sets = { questions: './questions.json', heldout: './heldout.json' };
if (!sets[values.set]) throw new Error('--set must be questions or heldout.');
const ledger = process.env.LEDGER ?? 'http://127.0.0.1:4317';
const set = JSON.parse(await readFile(new URL(sets[values.set], import.meta.url), 'utf8'));
const repeat = Math.max(1, Number(values.repeat) || 1);

async function ask(question) {
  const response = await fetch(`${ledger}/api/latent/read`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ledger },
    body: JSON.stringify({ paths: set.paths, question: question.question, budgetTokens: 400, workers: 3 }),
    signal: AbortSignal.timeout(300_000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${question.id}: HTTP ${response.status} ${data.error}`);
  if (data.mode !== 'latent') throw new Error(`${question.id}: runtime unavailable (${data.reason})`);
  return data;
}

const runs = [];
for (let round = 1; round <= repeat; round += 1) {
  const results = [];
  for (const question of set.questions) {
    const started = Date.now();
    const data = await ask(question);
    const grade = gradeSlice(question, data.graph);
    const calls = data.receipt?.calls ?? [];
    results.push({
      ...grade,
      ms: Date.now() - started,
      prefixTokens: data.stats?.prefixTokens ?? null,
      sliceTokens: data.stats?.sliceTokensEstimate ?? null,
      cachedShare: data.stats?.cachedShare ?? null,
      promptTokens: calls.reduce((sum, call) => sum + (call.promptTokens ?? 0), 0),
      cachedTokens: calls.reduce((sum, call) => sum + (call.cachedTokens ?? 0), 0),
      rejectedFindings: data.graph.rejectedFindings,
      answer: data.graph.answer,
    });
    const last = results.at(-1);
    console.log(`round ${round} ${question.id}: correct=${grade.correct} cited=${grade.cited} slice=${last.sliceTokens}/${last.prefixTokens} cached=${last.cachedShare} ${last.ms}ms`);
  }
  const summary = summarize(results);
  const mean = key => results.reduce((sum, result) => sum + (result[key] ?? 0), 0) / results.length;
  // Missing token stats must fail the gate, not count as zero (a vacuous "0% slice").
  const complete = key => results.every(result => Number.isFinite(result[key]) && result[key] > 0);
  const sliceShare = complete('sliceTokens') && complete('prefixTokens') ? mean('sliceTokens') / mean('prefixTokens') : NaN;
  const promptTotal = results.reduce((s, r) => s + r.promptTokens, 0);
  const cachedShare = promptTotal > 0 ? results.reduce((s, r) => s + r.cachedTokens, 0) / promptTotal : NaN;
  const gate = {
    accuracy: summary.accuracy >= 7 / 8,
    citations: summary.citationRate >= 7 / 8,
    sliceShare: Number.isFinite(sliceShare) && sliceShare <= 0.1,
    cachedShare: Number.isFinite(cachedShare) && cachedShare >= 0.6,
  };
  runs.push({ round, summary, sliceShare, cachedShare, meanMs: mean('ms'), gate, passed: Object.values(gate).every(Boolean), results });
  console.log(`round ${round}: accuracy ${summary.accuracy} citations ${summary.citationRate} sliceShare ${sliceShare.toFixed(3)} cachedShare ${cachedShare.toFixed(3)} -> ${runs.at(-1).passed ? 'PASS' : 'FAIL'}`);
}
if (values.out) await writeFile(values.out, JSON.stringify({ ledger, runs }, null, 2) + '\n');
process.exitCode = runs.every(run => run.passed) ? 0 : 1;
