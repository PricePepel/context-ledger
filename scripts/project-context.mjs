// Card K1: the project's own docs as a graph of cards and sections, so a new session
// reads the part that concerns its card instead of all four files.
//   node scripts/project-context.mjs                 what is open now
//   node scripts/project-context.mjs P4d             one card and what was written about it
//   node scripts/project-context.mjs swarm speed-up  cards and sections matching the words
//   options: --budget <tokens> (default 1500), --json (the whole graph), --root <folder>
// The files are read on every run and nothing is written, so there is no copy to go
// stale. Node built-ins and src/text.mjs only; not part of the package.
// Two layouts are read, alone or together: one file with a section per card
// (docs/evals.md), and a folder with a file per card (docs/evals/p4d.md).
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { terminalJson, terminalLabel } from '../src/text.mjs';

export const sources = [
  { key: 'board', path: 'docs/delivery-board.md', levels: [] },
  { key: 'handoff', path: 'docs/handoff.md', levels: [1, 2] },
  { key: 'evals', path: 'docs/evals.md', levels: [1, 2] },
  { key: 'architecture', path: 'docs/architecture.md', levels: [1, 2, 3] },
];
export const defaultBudget = 1500;
const minimumBudget = 200;
const maximumBudget = 1_000_000;
const charactersPerToken = 4;
// Characters kept for the two closing lines, so they always fit.
const closingRoom = 520;
const closingNote = 'Open the cited lines before changing anything: this is a map of the docs, not the docs.';
const states = ['In progress', 'In review', 'Backlog', 'Ready', 'Done'];
const openOrder = ['In progress', 'In review', 'Ready', 'Backlog', 'Other'];

const splitLines = text => String(text).split(/\r?\n/u);
const oneLine = text => String(text).replace(/\s+/gu, ' ').trim();
const cut = (text, limit) => {
  const characters = [...text];
  return characters.length <= limit ? text : `${characters.slice(0, Math.max(0, limit - 1)).join('').trimEnd()}…`;
};

// A table row's cells. A backslash before a pipe keeps the pipe inside its cell.
function rowCells(line) {
  const cells = [];
  let cell = '';
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === '\\' && line[index + 1] === '|') {
      cell += '|';
      index += 1;
    } else if (line[index] === '|') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += line[index];
    }
  }
  cells.push(cell.trim());
  // The text before the first pipe and after the last one is outside the table.
  return cells.slice(1, cells.at(-1) === '' ? -1 : cells.length);
}

const cardIdShape = /^[A-Z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*$/u;

// Rows start with a pipe, as every row of the board does.
export function parseBoard(text, path = 'docs/delivery-board.md') {
  const cards = [];
  splitLines(text).forEach((line, index) => {
    if (!/^\s*\|/u.test(line)) return;
    const cells = rowCells(line.trim());
    if (cells.length < 5) return;
    if (cells.every(cell => /^:?-+:?$/u.test(cell))) return;
    if (cells[0] === 'Card' && cells.at(-1) === 'State') return;
    const [name, owner, branch] = cells;
    const stateText = cells.at(-1);
    // A raw pipe inside the scope (in code, say) made extra cells; they belong to it.
    const scope = cells.slice(3, -1).join(' | ');
    const [first, ...rest] = name.split(/\s+/u);
    const hasId = cardIdShape.test(first) && /\d/u.test(first);
    const state = states.find(known => stateText.toLowerCase().startsWith(known.toLowerCase())) ?? 'Other';
    cards.push({
      kind: 'card',
      cardId: hasId ? first : null,
      title: hasId ? rest.join(' ') : name,
      owner,
      branch,
      scope,
      state,
      stateText,
      prs: [...branch.matchAll(/#(\d+)/gu)].map(match => Number(match[1])),
      file: path,
      line: index + 1,
    });
  });
  return cards;
}

export function parseSections(text, path, levels) {
  const lines = splitLines(text);
  const sections = [];
  let fence = null;
  let current = null;
  const close = end => {
    if (!current) return;
    current.endLine = end;
    current.body = lines.slice(current.line, end).join('\n');
    sections.push(current);
  };
  lines.forEach((line, index) => {
    const mark = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fence) {
      // Only the same character, at least as many of them, with nothing after, closes.
      if (mark && mark[1][0] === fence.character && mark[1].length >= fence.length && !mark[2].trim()) fence = null;
      return;
    }
    if (mark && !(mark[1][0] === '`' && mark[2].includes('`'))) {
      fence = { character: mark[1][0], length: mark[1].length };
      return;
    }
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line);
    if (!heading || !levels.includes(heading[1].length)) return;
    close(index);
    current = {
      kind: 'section',
      file: path,
      level: heading[1].length,
      title: heading[2],
      date: /\b(20\d\d-\d\d-\d\d)\b/u.exec(heading[2])?.[1] ?? null,
      line: index + 1,
    };
  });
  // A file that ends with a line break has one empty last element, which is not a line.
  close(lines.at(-1) === '' ? lines.length - 1 : lines.length);
  return sections;
}

// A letter or digit of any script on either side means the ID is part of a longer word.
const before = String.raw`(?<![\p{L}\p{N}])`;
const after = String.raw`(?![\p{L}\p{N}])`;
const between = String.raw`(?:\p{Pd}| to )`;
const idToken = new RegExp(`${before}[A-Z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*${after}`, 'gu');
const numberRange = new RegExp(String.raw`${before}([A-Z]{1,4})(\d+)${between}\1(\d+)${after}`, 'gu');
const letterRange = new RegExp(String.raw`${before}([A-Z]{1,4}\d+)([a-z])${between}\1([a-z])${after}`, 'gu');
const cycleNumber = new RegExp(String.raw`${before}[Cc]ycle (\d+)${after}`, 'gu');
const prNumber = new RegExp(String.raw`#(\d+)${after}`, 'gu');
const longestRange = 30;

// The cards a text names, as graph node IDs. `P1` is not found in `P1a`; `P1-style`
// names P1; `H1–H5`, `H5–H1` and `P2a to P2c` name every card between; `Cycle 4` names
// C4; `#58` names the card whose branch cell has PR #58.
function namedCards(text, index) {
  const found = new Set();
  const take = cardId => {
    for (const id of index.byId.get(cardId) ?? []) found.add(id);
    return index.byId.has(cardId);
  };
  for (const [token] of text.matchAll(idToken)) {
    let candidate = token;
    while (candidate && !take(candidate)) {
      const dash = candidate.lastIndexOf('-');
      candidate = dash > 0 ? candidate.slice(0, dash) : '';
    }
  }
  for (const [, prefix, from, to] of text.matchAll(numberRange)) {
    const [low, high] = [Number(from), Number(to)].sort((left, right) => left - right);
    // Past the safe integers a counter stops moving, and a long range is not a range.
    if (!Number.isSafeInteger(high) || high - low > longestRange) continue;
    for (let number = low; number <= high; number += 1) take(`${prefix}${number}`);
  }
  for (const [, stem, from, to] of text.matchAll(letterRange)) {
    const [low, high] = [from.codePointAt(0), to.codePointAt(0)].sort((left, right) => left - right);
    for (let code = low; code <= high; code += 1) take(`${stem}${String.fromCodePoint(code)}`);
  }
  for (const [, number] of text.matchAll(cycleNumber)) take(`C${number}`);
  for (const [, number] of text.matchAll(prNumber)) {
    for (const id of index.byPr.get(Number(number)) ?? []) found.add(id);
  }
  return found;
}

const filePath = /(?<![\w/.-])((?:src|tests|scripts|public|runtime|docs|schemas|rules|bin|\.github)\/[\w./-]*\w)/gu;
const namedFiles = text => [...new Set([...text.matchAll(filePath)].map(match => match[1]))];

function excerpt(body, limit) {
  const text = [];
  for (const line of splitLines(body)) {
    if (/^\s*(?:#{1,6}\s|\|?\s*:?-{3,}|`{3,}|~{3,})/u.test(line)) continue;
    if (line.trim()) text.push(line.trim());
    if (text.join(' ').length >= limit) break;
  }
  return cut(oneLine(text.join(' ')), limit);
}

// docs: { board, handoff, evals, architecture }, each a text or a list of
// { path, text } files; a missing one is skipped.
export function buildProjectGraph(docs) {
  const nodes = [];
  const edges = [];
  const bodies = new Map();
  const index = { byId: new Map(), byPr: new Map() };
  const read = {};
  const fileStems = new Map();
  const files = sources.flatMap(source => {
    const given = docs[source.key];
    const list = typeof given === 'string' ? [{ path: source.path, text: given }] : Array.isArray(given) ? given : [];
    return list.map(file => ({ source, path: file.path, text: String(file.text) }));
  });
  for (const { source, path, text } of files) {
    const lineCount = splitLines(text).length - (/\n$/u.test(text) ? 1 : 0);
    read[path] = { bytes: Buffer.byteLength(text), lines: lineCount };
    if (source.key === 'board') {
      for (const card of parseBoard(text, path)) {
        card.id = `card:${card.file}:${card.line}`;
        nodes.push(card);
        bodies.set(card.id, card.scope);
        if (card.cardId) index.byId.set(card.cardId, [...(index.byId.get(card.cardId) ?? []), card.id]);
        for (const pr of card.prs) index.byPr.set(pr, [...(index.byPr.get(pr) ?? []), card.id]);
      }
    } else {
      for (const { body, ...section } of parseSections(text, path, source.levels)) {
        section.id = `section:${section.file}:${section.line}`;
        section.source = source.key;
        section.excerpt = excerpt(body, 400);
        section.files = namedFiles(body);
        nodes.push(section);
        bodies.set(section.id, body);
        fileStems.set(section.id, basename(path, '.md').toLowerCase());
      }
    }
  }
  for (const node of nodes) {
    // A card does not link to itself, nor to another row with its own ID.
    const own = new Set([node.id, ...(index.byId.get(node.cardId) ?? [])]);
    const inTitle = node.kind === 'section' ? namedCards(node.title, index) : new Set();
    // docs/evals/p4d.md is about P4d, whatever its headings say.
    const stem = fileStems.get(node.id);
    for (const [cardId, ids] of index.byId) {
      if (cardId.toLowerCase() === stem) ids.forEach(id => inTitle.add(id));
    }
    for (const to of namedCards(bodies.get(node.id), index)) {
      if (!own.has(to) && !inTitle.has(to)) edges.push({ from: node.id, to, kind: 'mentions' });
    }
    for (const to of inTitle) edges.push({ from: node.id, to, kind: 'about' });
  }
  return { read, nodes, edges, bodies };
}

const newestFirst = (left, right) => (right.date ?? '').localeCompare(left.date ?? '');
const place = node => (node.kind === 'card' || node.endLine <= node.line
  ? `${node.file}:${node.line}`
  : `${node.file}:${node.line}-${node.endLine}`);
const sectionLine = section => `  ${place(section)}  ${section.date ? `${section.date}  ` : ''}${section.title}`;
const cardName = card => `${card.cardId ?? '(no ID)'} ${card.title}`.trim();
const cardLine = card => `  ${cardName(card)} | ${card.stateText} | ${card.owner} | ${place(card)}`;
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
// "Files (24 of 31): a, b": a list that is cut says so in its own line.
const listLine = (title, items, most) => `${title}${items.length > most ? ` (${most} of ${items.length})` : ''}: ${items.slice(0, most).join(', ')}`;

// What a terminal is sent: control, format and bidi characters escaped, line by line.
const escaped = text => text.split('\n').map(terminalLabel).join('\n');
// An escaped text cut to a number of UTF-16 units, the unit the budget is counted in.
function fitted(text, room) {
  if (text.length <= room) return text;
  let kept = '';
  for (const character of text) {
    if (kept.length + character.length > room - 1) break;
    kept += character;
  }
  return `${kept.trimEnd()}…`;
}

// Lines added in order of importance until the budget is spent. Sizes are those of the
// escaped text, so the result is at most budget * 4 UTF-16 units. What does not fit, or
// was cut by a cap, is counted by kind, and the last line says so (also when nothing
// was dropped).
class Briefing {
  constructor(budget) {
    this.budget = Math.min(maximumBudget, Math.max(minimumBudget, Math.trunc(Number(budget)) || defaultBudget));
    this.room = this.budget * charactersPerToken - closingRoom;
    this.lines = [];
    this.dropped = new Map();
  }
  drop(kind, count = 1) {
    if (count > 0) this.dropped.set(kind, (this.dropped.get(kind) ?? 0) + count);
  }
  push(text) {
    this.lines.push(text);
    this.room -= text.length + 1;
  }
  // Printed whenever there is room for a readable part of it, cut to what is left.
  must(kind, text) {
    if (this.room < 24) this.drop(kind);
    else this.push(fitted(escaped(text), this.room - 1));
  }
  // The full form, or the short form, or a count of what was dropped.
  add(kind, full, short = null) {
    for (const form of [full, short]) {
      if (form === null) continue;
      const text = escaped(form);
      if (text.length + 1 <= this.room) {
        this.push(text);
        return true;
      }
    }
    this.drop(kind);
    return false;
  }
  // A heading, printed only when at least one of its items is.
  group(title, kind, items) {
    let open = false;
    for (const [full, short] of items) {
      const head = open ? '' : `${title}\n`;
      if (this.add(kind, `${head}${full}`, short === null ? null : `${head}${short}`)) open = true;
    }
  }
  end() {
    const dropped = [...this.dropped].map(([kind, count]) => plural(count, kind));
    const tail = dropped.length
      ? `Left out for the budget of ${this.budget} tokens: ${dropped.join(', ')}. Raise --budget to see them.`
      : `Nothing left out (budget ${this.budget} tokens).`;
    return [...this.lines, closingNote, fitted(tail, closingRoom - closingNote.length - 2)].join('\n');
  }
}

function overview(graph, budget) {
  const out = new Briefing(budget);
  const cards = graph.nodes.filter(node => node.kind === 'card');
  const counts = [...states, 'Other'].map(state => [state, cards.filter(card => card.state === state).length]);
  out.must('summary line', `Project board: ${plural(cards.length, 'card')} (${counts.filter(([, count]) => count).map(([state, count]) => `${state} ${count}`).join(', ')}).`);
  const open = cards.filter(card => card.state !== 'Done')
    .sort((left, right) => openOrder.indexOf(left.state) - openOrder.indexOf(right.state));
  out.group('Not done:', 'open card', open.map(card => [cardLine(card), null]));
  const dated = graph.nodes
    .filter(node => node.kind === 'section' && node.source === 'handoff' && node.date)
    .sort(newestFirst);
  const newest = dated.slice(0, 8);
  // The older notes are not left out for the budget: the heading says how many there are.
  out.group(`Newest handoff notes (${newest.length} of ${dated.length} with a date):`, 'handoff note', newest.map(section => [sectionLine(section), null]));
  const sizes = Object.entries(graph.read).map(([path, size]) => `${path} ${Math.round(size.bytes / 1024)} KB`);
  out.add('size line', `Read for this: ${sizes.join(', ')}.`);
  out.add('hint', 'Next: node scripts/project-context.mjs <card ID or words>');
  return out.end();
}

function cardBriefing(graph, cardIds, budget) {
  const out = new Briefing(budget);
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  const cards = graph.nodes.filter(node => node.kind === 'card' && cardIds.includes(node.cardId));
  const nodeIds = new Set(cards.map(card => card.id));
  for (const card of cards) {
    out.must('card', cardName(card));
    out.must('card line', `  state: ${card.stateText} | owner: ${card.owner} | branch or PR: ${card.branch} | ${place(card)}`);
    out.add('card scope', `  scope: ${cut(oneLine(card.scope), 500)}`, `  scope: ${cut(oneLine(card.scope), 160)}`);
  }
  const linked = kind => {
    const seen = new Set();
    return graph.edges
      .filter(edge => edge.kind === kind && nodeIds.has(edge.to) && !seen.has(edge.from) && seen.add(edge.from))
      .map(edge => byId.get(edge.from));
  };
  const about = linked('about').filter(node => node.kind === 'section').sort(newestFirst);
  const aboutIds = new Set(about.map(section => section.id));
  const mentions = linked('mentions').filter(node => !aboutIds.has(node.id));
  out.group('Written about it, newest first:', 'section about it', about.map(section => [
    `${sectionLine(section)}\n      ${cut(section.excerpt, 240)}`,
    sectionLine(section),
  ]));
  // From the sections about the card only: a note that mentions six cards names the
  // files of all six.
  const files = [...new Set(about.flatMap(section => section.files))];
  if (files.length) out.add('list of files', listLine('Files those sections name', files, 24), listLine('Files those sections name', files, 6));
  // The cards its row and its sections name, and the cards whose rows name it.
  const related = new Set();
  for (const edge of graph.edges) {
    if (nodeIds.has(edge.from) || aboutIds.has(edge.from)) related.add(byId.get(edge.to));
    else if (nodeIds.has(edge.to) && byId.get(edge.from).kind === 'card') related.add(byId.get(edge.from));
  }
  const others = [...related].filter(card => !nodeIds.has(card.id)).map(card => `${card.cardId ?? card.title} (${card.state})`);
  if (others.length) out.add('list of other cards', listLine('Other cards named with it', others, 24), listLine('Other cards named with it', others, 6));
  out.group('Mentioned in:', 'section that mentions it', mentions
    .filter(node => node.kind === 'section')
    .sort(newestFirst)
    .map(section => [sectionLine(section), null]));
  return out.end();
}

function questionBriefing(graph, words, budget) {
  const out = new Briefing(budget);
  const terms = [...new Set(words.map(word => word.toLowerCase()).filter(word => [...word].length >= 2))];
  out.must('question', `Question: ${terms.join(' ')}`);
  const hits = text => {
    const lower = text.toLowerCase();
    return terms.filter(term => lower.includes(term)).length;
  };
  const scored = graph.nodes.map(node => {
    const head = node.kind === 'card' ? `${node.cardId ?? ''} ${node.title}` : node.title;
    const rest = node.kind === 'card' ? `${node.owner} ${node.branch} ${node.stateText} ${node.scope}` : graph.bodies.get(node.id);
    return { node, score: hits(head) * 3 + hits(rest) };
  }).filter(entry => entry.score > 0)
    .sort((left, right) => right.score - left.score || newestFirst(left.node, right.node));
  const cards = scored.filter(entry => entry.node.kind === 'card');
  const sections = scored.filter(entry => entry.node.kind === 'section');
  if (!scored.length) out.must('answer', 'No card or section contains these words.');
  // The best cards only, so the sections keep most of the budget; the rest are counted.
  out.group('Cards:', 'card', cards.slice(0, 12).map(({ node }) => [cardLine(node), null]));
  out.drop('card', cards.length - 12);
  out.group('Sections:', 'section', sections.map(({ node }) => [
    `${sectionLine(node)}\n      ${cut(node.excerpt, 200)}`,
    sectionLine(node),
  ]));
  return out.end();
}

// query: the words typed after the command. A word that is a card ID, in any letter
// case, selects that card; other words are then ignored. The text returned is safe to
// print: it is already escaped, and at most budget * 4 UTF-16 units long.
export function briefing(graph, query = [], { budget = defaultBudget } = {}) {
  const words = (Array.isArray(query) ? query : String(query).split(/\s+/u)).filter(Boolean);
  if (!words.length) return overview(graph, budget);
  const known = new Map(graph.nodes.filter(node => node.cardId).map(node => [node.cardId.toLowerCase(), node.cardId]));
  const cardIds = [...new Set(words.map(word => known.get(word.toLowerCase())).filter(Boolean))];
  return cardIds.length ? cardBriefing(graph, cardIds, budget) : questionBriefing(graph, words, budget);
}

export function readDocs(root) {
  const docs = {};
  for (const source of sources) {
    const found = [];
    try {
      found.push({ path: source.path, text: readFileSync(join(root, source.path), 'utf8') });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    // The folder beside the file: docs/evals/ for docs/evals.md.
    const folder = source.path.replace(/\.md$/u, '');
    let names = [];
    try {
      names = readdirSync(join(root, folder), { withFileTypes: true });
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    }
    for (const entry of names.filter(entry => entry.isFile() && entry.name.endsWith('.md')).sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
      found.push({ path: `${folder}/${entry.name}`, text: readFileSync(join(root, folder, entry.name), 'utf8') });
    }
    if (found.length) docs[source.key] = found;
  }
  return docs;
}

export function run(argv, root = resolve(fileURLToPath(new URL('..', import.meta.url)))) {
  const words = [];
  const options = { budget: defaultBudget, json: false, root };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') options.json = true;
    else if (argument === '--budget' || argument === '--root') {
      const value = argv[index += 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${argument} needs a value`);
      if (argument === '--root') options.root = resolve(value);
      else if (!/^\d{1,7}$/u.test(value) || Number(value) < minimumBudget || Number(value) > maximumBudget) {
        throw new Error(`--budget is a whole number of tokens from ${minimumBudget} to ${maximumBudget}`);
      } else options.budget = Number(value);
    } else if (argument.startsWith('--')) throw new Error(`Unknown option ${argument}`);
    else words.push(argument);
  }
  const docs = readDocs(options.root);
  if (!docs.board?.some(file => file.path === 'docs/delivery-board.md')) throw new Error(`No docs/delivery-board.md under ${options.root}`);
  const { bodies, ...graph } = buildProjectGraph(docs);
  if (options.json) return terminalJson(graph);
  return briefing({ ...graph, bodies }, words, options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log(run(process.argv.slice(2)));
  } catch (error) {
    console.error(terminalLabel(error.message));
    process.exitCode = 1;
  }
}
