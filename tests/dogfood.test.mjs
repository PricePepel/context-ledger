import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { detectProvider, findTranscripts, maxImportBytes, measure, renderMarkdown } from '../bench/dogfood.mjs';
import { generateParty } from '../bench/synth.mjs';

// Card L8: the dogfood baseline must report aggregates only, never transcript content or names.
const run = promisify(execFile);
const script = new URL('../bench/dogfood.mjs', import.meta.url).pathname;
const marker = 'ZQX-PRIVATE-MARKER-7731';
const secretName = 'secret-project-name';

function fixtures() {
  const dir = mkdtempSync(join(tmpdir(), 'dogfood-test-'));
  const nested = join(dir, secretName, 'deeper');
  mkdirSync(nested, { recursive: true });
  const claude = generateParty('a', 20, 7);
  const codex = generateParty('b', 30, 7);
  // Plant a unique marker in real message text, so a leak of any content is detectable.
  writeFileSync(join(nested, `${secretName}-claude.jsonl`), claude.base.replace('Ship the', `${marker} Ship the`));
  writeFileSync(join(dir, `${secretName}-codex.jsonl`), codex.base);
  writeFileSync(join(dir, 'duplicate.jsonl'), codex.base);
  writeFileSync(join(dir, 'corrupt.jsonl'), `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } })}\n{not json`);
  writeFileSync(join(dir, 'unknown.jsonl'), JSON.stringify({ kind: 'something else' }));
  const oversize = join(dir, 'oversize.jsonl');
  writeFileSync(oversize, '');
  truncateSync(oversize, maxImportBytes + 1);
  writeFileSync(join(dir, 'notes.txt'), marker);
  return { dir, claude, codex };
}

test('providers are detected from the record shapes the importer reads', () => {
  assert.equal(detectProvider(generateParty('a', 5, 1).base), 'claude');
  assert.equal(detectProvider(generateParty('b', 5, 1).base), 'codex');
  assert.equal(detectProvider('{"kind":"other"}'), undefined);
});

test('aggregates count every file once and skip oversize, corrupt, unknown and duplicate sessions', () => {
  const { dir } = fixtures();
  try {
    const files = findTranscripts([dir]);
    assert.equal(files.length, 6, 'only .jsonl files, found recursively');
    let tempDir;
    const result = measure(files, { onTempDir: path => { tempDir = path; } });
    assert.deepEqual(result.counts, { files: 6, measured: 2, duplicates: 1, oversize: 1, unrecognized: 1, failed: 1 });
    assert.equal(result.byProvider.claude.sessions, 1);
    assert.equal(result.byProvider.codex.sessions, 1);
    assert.equal(result.all.sessions, 2);
    const tokens = result.all.handoffTokensEstimate;
    assert.ok(tokens.p50 > 0 && tokens.max >= tokens.p90 && tokens.p90 >= tokens.p50);
    assert.equal(Object.values(result.all.handoffTokenBuckets).reduce((a, b) => a + b, 0), 2);
    assert.equal(existsSync(tempDir), false, 'the throwaway database is removed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the JSON and Markdown output contain no transcript text, names, paths or session IDs', async () => {
  const { dir } = fixtures();
  const out = join(dir, 'report.md');
  try {
    const { stdout } = await run(process.execPath, [script, dir, '--markdown', out]);
    const markdown = (await import('node:fs')).readFileSync(out, 'utf8');
    for (const text of [stdout, markdown]) {
      assert.ok(!text.includes(marker), 'no transcript content');
      assert.ok(!text.includes(secretName), 'no file or project names');
      assert.ok(!text.includes(dir), 'no paths');
      assert.doesNotMatch(text, /[a-f0-9]{64}/u, 'no session IDs');
      assert.doesNotMatch(text, /Ship the|Two hours of pairing/u, 'no message text');
    }
    assert.equal(JSON.parse(stdout).counts.measured, 2);
    assert.match(markdown, /\| All \| 2 \|/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the report renders with empty input and the CLI needs a path', async () => {
  const empty = measure([]);
  assert.equal(empty.all.handoffTokensEstimate.p50, null);
  assert.match(renderMarkdown(empty), /Files: 0/u);
  await assert.rejects(run(process.execPath, [script]), error => error.code === 2 && /usage/u.test(error.stderr));
});
