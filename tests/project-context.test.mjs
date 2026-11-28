// Card K1: the project's docs parsed into cards and sections, and the briefing a new
// session reads instead of the four files. Synthetic docs, written here.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { briefing, buildProjectGraph, parseBoard, parseSections, run } from '../scripts/project-context.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const script = join(root, 'scripts', 'project-context.mjs');
const fence = '`'.repeat(3);
const dash = String.fromCodePoint(0x2013);

const board = [
  '# Delivery board',
  '',
  '| Card | Owner | Branch or PR | Scope | State |',
  '| --- | --- | --- | --- | --- |',
  '| C4 Two-party rooms | Codex | PR #7, `codex/rooms` | Rooms that pair two graphs | Done (merged 2026-01-02) |',
  '| P1 Storage | Claude Code | PR #12, `claude/p1` | Tables for sessions; split into P1a | Done |',
  '| P1a Storage engine | Claude Code | PR #13 | Pick `a \\| b` or stay; see `src/store.mjs` | In review (PR #13) |',
  '| M2b-S Transfer at scale | Unassigned | - | Retrain the mapper | Backlog |',
  '| H1 Checks in CI | Claude Code | #21 | Run the checks | Done |',
  '| H2 Stale docs | Claude Code | #22 | Fix the docs | Done |',
  '| H3 Split the adapter | Claude Code | #23 | Split it | In progress |',
  '',
  'Some prose between two parts of the table, naming P1a.',
  '',
  '| Q9 Late row | Ali | `ali/q9` | A row after the prose, with a raw | pipe in its scope | Ready |',
  '| A row with no card ID | Nobody | - | Left as it is | Paused |',
].join('\n');

const handoff = [
  '# Project handoff',
  '',
  'Goal: a local library.',
  '',
  '## Current checkpoint - P1a storage engine (2026-01-05)',
  '',
  'PR #13 keeps `src/store.mjs` on the built-in engine. P1 stays as it was.',
  '',
  fence,
  '## not a heading, this is inside a code block',
  fence,
  '',
  `## Current checkpoint - housekeeping H1${dash}H3 (2026-01-04)`,
  '',
  'Three small cards. `tests/check.test.mjs` covers them.',
  '',
  '## Current checkpoint - rooms',
  '',
  'Cycle 4 is merged. P1a-style migrations are not needed, and XP1 is not a card.',
  '',
  '## Older note (2025-12-30)',
  '',
  'See #7 for the room work.',
].join('\n');

const evals = [
  '# Acceptance evals',
  '',
  '## P1a - Storage engine decision (defined 2026-01-03, before the code)',
  '',
  '### What is tested',
  '',
  'The probe in `tests/sqlite-probe.test.mjs`.',
  '',
  '## Results - M2b-S, 2026-01-06',
  '',
  'Three gates pass.',
  '',
].join('\r\n');

const architecture = [
  '# Architecture',
  '',
  '## 5. Storage',
  '',
  'Text of section 5.',
  '',
  '### 5.1 Engine decision (card P1a, 2026-01-03)',
  '',
  'ADR-003.',
].join('\n');

const docs = { board, handoff, evals, architecture };
const graph = () => buildProjectGraph(docs);
const card = (built, id) => built.nodes.find(node => node.cardId === id);
const linksTo = (built, id, kind) => built.edges
  .filter(edge => edge.kind === kind && edge.to === card(built, id).id)
  .map(edge => built.nodes.find(node => node.id === edge.from).title);

test('every board row becomes a card with its line, wherever the row stands', () => {
  const cards = parseBoard(board);
  assert.deepEqual(cards.map(row => row.cardId), ['C4', 'P1', 'P1a', 'M2b-S', 'H1', 'H2', 'H3', 'Q9', null]);
  const p1a = cards[2];
  assert.equal(p1a.title, 'Storage engine');
  assert.equal(p1a.owner, 'Claude Code');
  assert.equal(p1a.branch, 'PR #13');
  assert.equal(p1a.scope, 'Pick `a | b` or stay; see `src/store.mjs`', 'an escaped pipe stays in its cell');
  assert.equal(p1a.state, 'In review');
  assert.equal(p1a.stateText, 'In review (PR #13)');
  assert.deepEqual(p1a.prs, [13]);
  assert.equal(p1a.line, 7);
  assert.equal(board.split('\n')[p1a.line - 1].startsWith('| P1a '), true, 'the line is the row');
  const late = cards[7];
  assert.equal(late.line, 15);
  assert.equal(late.scope, 'A row after the prose, with a raw | pipe in its scope', 'extra cells belong to the scope');
  assert.equal(late.state, 'Ready');
  assert.equal(cards[8].title, 'A row with no card ID');
  assert.equal(cards[8].state, 'Other');
  assert.equal(cards[8].stateText, 'Paused');
});

test('headings become sections with first and last line and a date; code blocks do not', () => {
  const sections = parseSections(handoff, 'docs/handoff.md', [1, 2]);
  assert.deepEqual(sections.map(section => [section.title, section.line, section.endLine, section.date]), [
    ['Project handoff', 1, 4, null],
    ['Current checkpoint - P1a storage engine (2026-01-05)', 5, 12, '2026-01-05'],
    [`Current checkpoint - housekeeping H1${dash}H3 (2026-01-04)`, 13, 16, '2026-01-04'],
    ['Current checkpoint - rooms', 17, 20, null],
    ['Older note (2025-12-30)', 21, 23, '2025-12-30'],
  ]);
  const crlf = parseSections(evals, 'docs/evals.md', [1, 2]);
  assert.deepEqual(crlf.map(section => [section.title, section.line, section.endLine]), [
    ['Acceptance evals', 1, 2],
    ['P1a - Storage engine decision (defined 2026-01-03, before the code)', 3, 8],
    ['Results - M2b-S, 2026-01-06', 9, 11],
  ], 'CRLF files, a level 3 heading stays inside its section, the last line break is not a line');
  const levels = parseSections(architecture, 'docs/architecture.md', [1, 2, 3]);
  assert.deepEqual(levels.map(section => [section.level, section.line, section.endLine]), [[1, 1, 2], [2, 3, 6], [3, 7, 9]]);
});

test('a section is linked to the cards it names: about from the heading, mentions from the body', () => {
  const built = graph();
  assert.deepEqual(linksTo(built, 'P1a', 'about'), [
    'Current checkpoint - P1a storage engine (2026-01-05)',
    'P1a - Storage engine decision (defined 2026-01-03, before the code)',
    '5.1 Engine decision (card P1a, 2026-01-03)',
  ]);
  assert.deepEqual(linksTo(built, 'P1a', 'mentions'), ['Storage', 'Current checkpoint - rooms'],
    'the P1 card names it in its scope; P1a-style names it');
  assert.deepEqual(linksTo(built, 'P1', 'about'), [], 'P1 is not found inside P1a');
  assert.deepEqual(linksTo(built, 'P1', 'mentions'), ['Current checkpoint - P1a storage engine (2026-01-05)'],
    'and XP1 is not P1');
  assert.deepEqual(linksTo(built, 'M2b-S', 'about'), ['Results - M2b-S, 2026-01-06'], 'an ID with a hyphen');
  for (const id of ['H1', 'H2', 'H3']) {
    assert.deepEqual(linksTo(built, id, 'about'), [`Current checkpoint - housekeeping H1${dash}H3 (2026-01-04)`], `${id} is in the range`);
  }
  assert.deepEqual(linksTo(built, 'C4', 'mentions'), ['Current checkpoint - rooms', 'Older note (2025-12-30)'],
    'Cycle 4 names C4, and #7 is its PR');
  assert.equal(built.edges.some(edge => edge.from === edge.to), false);
  assert.equal(new Set(built.nodes.map(node => node.id)).size, built.nodes.length, 'node IDs are unique');
});

test('a card briefing has the card, what was written about it newest first, files and other cards', () => {
  const text = briefing(graph(), ['p1A']);
  const lines = text.split('\n');
  assert.equal(lines[0], 'P1a Storage engine');
  assert.match(lines[1], /state: In review \(PR #13\) \| owner: Claude Code \| branch or PR: PR #13 \| docs\/delivery-board\.md:7$/u);
  const about = lines.filter(line => /^ {2}docs\/\S+:\d+-\d+ /u.test(line)).slice(0, 3);
  assert.deepEqual(about.map(line => line.trim().split('  ')[0]), ['docs/handoff.md:5-12', 'docs/evals.md:3-8', 'docs/architecture.md:7-9']);
  assert.match(text, /PR #13 keeps `src\/store\.mjs` on the built-in engine/u, 'the first words of the section');
  assert.match(text, /^Files those sections name: src\/store\.mjs, tests\/sqlite-probe\.test\.mjs$/mu);
  assert.match(text, /^Other cards named with it: P1 \(Done\)$/mu);
  assert.match(text, /^Mentioned in:\n {2}docs\/handoff\.md:17-20 {2}Current checkpoint - rooms$/mu);
  assert.match(text, /^Nothing left out \(budget 1500 tokens\)\.$/mu);
});

test('words that are not a card ID rank cards and sections, a heading counting more', () => {
  const text = briefing(graph(), 'storage engine');
  assert.match(text, /^Question: storage engine$/mu);
  const cards = text.split('Cards:\n')[1].split('Sections:')[0].trim().split('\n');
  assert.match(cards[0], /^P1a Storage engine /u, 'both words in the title');
  assert.match(cards[1], /^ {2}P1 Storage /u);
  const sections = text.split('Sections:\n')[1];
  assert.match(sections.split('\n')[0], /docs\/handoff\.md:5-12/u, 'both words in the heading, and the newest');
  assert.match(briefing(graph(), ['zebra']), /^No card or section contains these words\.$/mu);
});

test('the budget bounds the briefing and the last lines say what was left out', () => {
  const many = Array.from({ length: 60 }, (_, index) => `## Note ${index} on P1a (2026-01-${String(index % 28 + 1).padStart(2, '0')})\n\n${'Long text about the engine. '.repeat(30)}\n`);
  const built = buildProjectGraph({ ...docs, handoff: `# Handoff\n\n${many.join('\n')}` });
  for (const budget of [200, 400, 1500, 4000]) {
    const text = briefing(built, ['P1a'], { budget });
    assert.ok(text.length <= budget * 4, `${text.length} characters for a budget of ${budget} tokens`);
    assert.match(text, /^P1a Storage engine\n {2}state: /u, 'the card itself is always there');
  }
  const small = briefing(built, ['P1a'], { budget: 400 });
  assert.match(small, /^Left out for the budget of 400 tokens: .*\d+ sections? about it.*\. Raise --budget to see them\.$/mu);
  const group = small.split('Written about it, newest first:\n')[1].split('\n');
  const shown = group.slice(0, group.findIndex(line => !line.startsWith(' '))).filter(line => line.startsWith('  docs/')).length;
  const left = Number(/(\d+) sections? about it/u.exec(small)[1]);
  assert.ok(shown > 0);
  assert.equal(shown + left, 62, 'the 60 notes and the eval and architecture sections are each shown or counted');
  const overview = briefing(built, [], { budget: 200 });
  assert.ok(overview.length <= 800);
  assert.match(overview, /^Left out for the budget of 200 tokens: /mu);
});

test('the overview counts the states and lists what is not done', () => {
  const text = briefing(graph());
  assert.match(text, /^Project board: 9 cards \(In progress 1, In review 1, Backlog 1, Ready 1, Done 4, Other 1\)\.$/mu);
  const open = text.split('Not done:\n')[1].split('Newest handoff notes:')[0].trim().split('\n');
  assert.deepEqual(open.map(line => line.trim().split(' ')[0]), ['H3', 'P1a', 'Q9', 'M2b-S', '(no']);
  assert.doesNotMatch(open.join('\n'), /\bC4\b|Done/u);
  const notes = text.split('Newest handoff notes:\n')[1].split('\n').filter(line => line.startsWith('  docs/'));
  assert.deepEqual(notes.map(line => /\d{4}-\d\d-\d\d/u.exec(line)[0]), ['2026-01-05', '2026-01-04', '2025-12-30']);
});

test('control, format and bidi characters in the docs reach the terminal escaped', () => {
  const folder = mkdtempSync(join(tmpdir(), 'k1-'));
  try {
    mkdirSync(join(folder, 'docs'));
    const hostile = [0x1b, 0x202e, 0x2028, 0x200b, 0x7f].map(code => String.fromCodePoint(code)).join('');
    writeFileSync(join(folder, 'docs', 'delivery-board.md'), `| Z1 Evil${hostile}card | Own${hostile}er | b${hostile} | sc${hostile}ope | Ready${hostile} |\n`);
    writeFileSync(join(folder, 'docs', 'handoff.md'), `## Z1 note${hostile} (2026-01-01)\n\nBody${hostile}text.\n`);
    const before = readdirSync(join(folder, 'docs'));
    for (const argv of [[], ['Z1'], ['evil'], ['--json']]) {
      const text = run([...argv, '--root', folder]);
      assert.doesNotMatch(text.replaceAll('\n', ''), /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u, `raw character in the output of ${argv.join(' ') || 'the overview'}`);
      assert.match(text, /\\u001b/iu);
      assert.match(text, /\\u202e/iu);
    }
    assert.deepEqual(readdirSync(join(folder, 'docs')), before, 'nothing is written');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('the command reads the files again on every run', () => {
  const folder = mkdtempSync(join(tmpdir(), 'k1-'));
  try {
    mkdirSync(join(folder, 'docs'));
    const file = join(folder, 'docs', 'delivery-board.md');
    writeFileSync(file, '| Z1 First | A | - | S | Ready |\n');
    assert.match(run(['Z1', '--root', folder]), /state: Ready/u);
    writeFileSync(file, '| Z1 First | A | - | S | Done |\n');
    assert.match(run(['Z1', '--root', folder]), /state: Done/u);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('bad arguments are refused with a plain message', () => {
  assert.throws(() => run(['--budget', '12']), /--budget is a whole number of tokens, 200 or more/u);
  assert.throws(() => run(['--budget']), /--budget needs a value/u);
  assert.throws(() => run(['--nope']), /Unknown option --nope/u);
  const empty = mkdtempSync(join(tmpdir(), 'k1-'));
  try {
    assert.throws(() => run(['--root', empty]), /No docs\/delivery-board\.md under/u);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test('on this repository: every board row and handoff heading is found, and a briefing is short', () => {
  const read = path => readFileSync(join(root, path), 'utf8');
  const rows = read('docs/delivery-board.md').split(/\r?\n/u)
    .filter(line => line.startsWith('|') && !/^\|\s*(?:Card\s*\||:?-+)/u.test(line));
  let inFence = false;
  const headings = read('docs/handoff.md').split(/\r?\n/u).filter(line => {
    if (line.startsWith(fence)) inFence = !inFence;
    return !inFence && line.startsWith('## ');
  });
  const built = JSON.parse(execFileSync(process.execPath, [script, '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  const cards = built.nodes.filter(node => node.kind === 'card');
  assert.equal(cards.length, rows.length);
  assert.ok(cards.length > 50);
  for (const found of cards) {
    assert.ok(rows.includes(read(found.file).split(/\r?\n/u)[found.line - 1]), `${found.cardId} cites its own row`);
  }
  assert.equal(built.nodes.filter(node => node.file === 'docs/handoff.md' && node.level === 2).length, headings.length);
  assert.equal(built.bodies, undefined, 'the graph does not carry the section texts');
  const own = execFileSync(process.execPath, [script, 'k1'], { encoding: 'utf8' });
  assert.match(own, /^K1 Project context graph\n/u);
  assert.match(own, /docs\/evals\.md:\d+-\d+ {2}2026-11-27 {2}K1 /u);
  assert.ok(Buffer.byteLength(own) < 8 * 1024, `${Buffer.byteLength(own)} bytes`);
  assert.ok(Buffer.byteLength(execFileSync(process.execPath, [script], { encoding: 'utf8' })) < 8 * 1024);
});

test('the script is not part of the package', () => {
  const { files } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(files.some(entry => entry.startsWith('scripts')), false);
  const source = readFileSync(script, 'utf8');
  const imports = [...source.matchAll(/from '([^']+)'/gu)].map(match => match[1]);
  assert.deepEqual(imports.filter(name => !name.startsWith('node:')), ['../src/text.mjs']);
});
