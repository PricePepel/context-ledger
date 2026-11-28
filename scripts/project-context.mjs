// Card K1: the project's own docs as a graph of cards and sections, so a new session
// reads the part that concerns its card instead of all four files.
//   node scripts/project-context.mjs                 what is open now
//   node scripts/project-context.mjs P4d             one card and what was written about it
//   node scripts/project-context.mjs swarm speed-up  cards and sections matching the words
//   options: --budget <tokens> (default 1500), --json (the whole graph), --root <folder>
// The files are read on every run and nothing is written, so there is no copy to go
// stale. Node built-ins and src/text.mjs only; not part of the package.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
const charactersPerToken = 4;
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
    const hasId = rest.length > 0 && cardIdShape.test(first) && /\d/u.test(first);
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
    const mark = /^\s{0,3}(`{3,}|~{3,})/u.exec(line);
    if (mark) {
      if (!fence) fence = mark[1][0];
      else if (mark[1][0] === fence) fence = null;
      return;
    }
    if (fence) return;
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

const idToken = /(?<![A-Za-z0-9])[A-Z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*(?![A-Za-z0-9])/gu;
const numberRange = /(?<![A-Za-z0-9])([A-Z]{1,4})(\d+)(?:\p{Pd}| to )\1(\d+)(?![A-Za-z0-9])/gu;
const letterRange = /(?<![A-Za-z0-9])([A-Z]{1,4}\d+)([a-z])(?:\p{Pd}| to )\1([a-z])(?![A-Za-z0-9])/gu;
const longestRange = 30;

// The card IDs a text names. `P1` is not found in `P1a`; `P1-style` names P1; `H1–H5`
// and `P2a to P2c` name every card between; `Cycle 4` names C4; `#58` names the card
// whose branch cell has PR #58.
function namedCards(text, index) {
  const found = new Set();
  for (const [token] of text.matchAll(idToken)) {
    let candidate = token;
    while (candidate) {
      if (index.byId.has(candidate)) {
        found.add(candidate);
        break;
      }
      const dash = candidate.lastIndexOf('-');
      candidate = dash > 0 ? candidate.slice(0, dash) : '';
    }
  }
  for (const [, prefix, from, to] of text.matchAll(numberRange)) {
    const [low, high] = [Number(from), Number(to)];
    if (high - low > longestRange) continue;
    for (let number = low; number <= high; number += 1) {
      if (index.byId.has(`${prefix}${number}`)) found.add(`${prefix}${number}`);
    }
  }
  for (const [, stem, from, to] of text.matchAll(letterRange)) {
    for (let code = from.codePointAt(0); code <= to.codePointAt(0); code += 1) {
      const id = `${stem}${String.fromCodePoint(code)}`;
      if (index.byId.has(id)) found.add(id);
    }
  }
  for (const [, number] of text.matchAll(/\b[Cc]ycle (\d+)\b/gu)) {
    if (index.byId.has(`C${number}`)) found.add(`C${number}`);
  }
  for (const [, number] of text.matchAll(/#(\d+)\b/gu)) {
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

// docs: { board, handoff, evals, architecture } as texts; a missing one is skipped.
export function buildProjectGraph(docs) {
  const nodes = [];
  const edges = [];
  const bodies = new Map();
  const index = { byId: new Map(), byPr: new Map() };
  const read = {};
  for (const source of sources) {
    const text = docs[source.key];
    if (typeof text !== 'string') continue;
    const lineCount = splitLines(text).length - (/\n$/u.test(text) ? 1 : 0);
    read[source.path] = { bytes: Buffer.byteLength(text), lines: lineCount };
    if (source.key === 'board') {
      for (const card of parseBoard(text, source.path)) {
        card.id = `card:${card.file}:${card.line}`;
        nodes.push(card);
        bodies.set(card.id, card.scope);
        if (!card.cardId) continue;
        index.byId.set(card.cardId, [...(index.byId.get(card.cardId) ?? []), card.id]);
        for (const pr of card.prs) index.byPr.set(pr, [...new Set([...(index.byPr.get(pr) ?? []), card.cardId])]);
      }
    } else {
      for (const { body, ...section } of parseSections(text, source.path, source.levels)) {
        section.id = `section:${section.file}:${section.line}`;
        section.source = source.key;
        section.excerpt = excerpt(body, 400);
        section.files = namedFiles(body);
        nodes.push(section);
        bodies.set(section.id, body);
      }
    }
  }
  for (const node of nodes) {
    const body = bodies.get(node.id);
    const inTitle = node.kind === 'section' ? namedCards(node.title, index) : new Set();
    for (const cardId of namedCards(body, index)) {
      if (cardId === node.cardId || inTitle.has(cardId)) continue;
      for (const to of index.byId.get(cardId)) edges.push({ from: node.id, to, kind: 'mentions' });
    }
    for (const cardId of inTitle) {
      for (const to of index.byId.get(cardId)) edges.push({ from: node.id, to, kind: 'about' });
    }
  }
  return { read, nodes, edges, bodies };
}

const newestFirst = (left, right) => (right.date ?? '').localeCompare(left.date ?? '');
const place = node => (node.kind === 'card' || node.endLine <= node.line
  ? `${node.file}:${node.line}`
  : `${node.file}:${node.line}-${node.endLine}`);
const sectionLine = section => `  ${place(section)}  ${section.date ? `${section.date}  ` : ''}${section.title}`;
const cardLine = card => `  ${card.cardId ?? '(no ID)'} ${card.title} | ${card.stateText} | ${card.owner} | ${place(card)}`;
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

// Lines added in order of importance until the budget is spent. What does not fit is
// counted by kind, and the last line says so (also when nothing was dropped).
class Briefing {
  constructor(budget) {
    this.budget = Math.max(minimumBudget, Math.trunc(Number(budget)) || defaultBudget);
    // Room kept for the closing line.
    this.room = this.budget * charactersPerToken - 320;
    this.lines = [];
    this.dropped = new Map();
  }
  fits(text) {
    return text.length + 1 <= this.room;
  }
  // Always printed, cut to what is left.
  must(text) {
    const kept = cut(text, Math.max(40, this.room - 1));
    this.lines.push(kept);
    this.room -= kept.length + 1;
  }
  // The full form, or the short form, or a count of what was dropped.
  add(kind, full, short = null) {
    for (const text of [full, short]) {
      if (text !== null && this.fits(text)) {
        this.lines.push(text);
        this.room -= text.length + 1;
        return true;
      }
    }
    this.dropped.set(kind, (this.dropped.get(kind) ?? 0) + 1);
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
    return [...this.lines, tail, 'Open the cited lines before changing anything: this is a map of the docs, not the docs.'].join('\n');
  }
}

function overview(graph, budget) {
  const out = new Briefing(budget);
  const cards = graph.nodes.filter(node => node.kind === 'card');
  const counts = [...states, 'Other'].map(state => [state, cards.filter(card => card.state === state).length]);
  out.must(`Project board: ${plural(cards.length, 'card')} (${counts.filter(([, count]) => count).map(([state, count]) => `${state} ${count}`).join(', ')}).`);
  const open = cards.filter(card => card.state !== 'Done')
    .sort((left, right) => openOrder.indexOf(left.state) - openOrder.indexOf(right.state));
  out.group('Not done:', 'open card', open.map(card => [cardLine(card), null]));
  const checkpoints = graph.nodes
    .filter(node => node.kind === 'section' && node.source === 'handoff' && node.date)
    .sort(newestFirst)
    .slice(0, 8);
  out.group('Newest handoff notes:', 'handoff note', checkpoints.map(section => [sectionLine(section), null]));
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
    out.must(`${card.cardId} ${card.title}`);
    out.must(`  state: ${card.stateText} | owner: ${card.owner} | branch or PR: ${card.branch} | ${place(card)}`);
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
  const files = [...new Set(about.flatMap(section => section.files))].slice(0, 24);
  if (files.length) out.add('list of files', `Files those sections name: ${files.join(', ')}`);
  const related = new Set();
  for (const edge of graph.edges) {
    if (edge.kind !== 'mentions') continue;
    if (nodeIds.has(edge.from) || aboutIds.has(edge.from)) related.add(byId.get(edge.to));
    else if (nodeIds.has(edge.to) && byId.get(edge.from).kind === 'card') related.add(byId.get(edge.from));
  }
  const others = [...related].filter(card => !nodeIds.has(card.id)).slice(0, 24);
  if (others.length) out.add('list of other cards', `Other cards named with it: ${others.map(card => `${card.cardId ?? card.title} (${card.state})`).join(', ')}`);
  out.group('Mentioned in:', 'section that mentions it', mentions
    .filter(node => node.kind === 'section')
    .sort(newestFirst)
    .map(section => [sectionLine(section), null]));
  return out.end();
}

function questionBriefing(graph, words, budget) {
  const out = new Briefing(budget);
  const terms = [...new Set(words.map(word => word.toLowerCase()).filter(word => [...word].length >= 2))];
  out.must(`Question: ${terms.join(' ')}`);
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
  const cards = scored.filter(entry => entry.node.kind === 'card').slice(0, 12);
  const sections = scored.filter(entry => entry.node.kind === 'section').slice(0, 40);
  if (!scored.length) out.must('No card or section contains these words.');
  out.group('Cards:', 'card', cards.map(({ node }) => [cardLine(node), null]));
  out.group('Sections:', 'section', sections.map(({ node }) => [
    `${sectionLine(node)}\n      ${cut(node.excerpt, 200)}`,
    sectionLine(node),
  ]));
  return out.end();
}

// query: the words typed after the command. A word that is a card ID, in any letter
// case, selects that card; other words are then ignored.
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
    try {
      docs[source.key] = readFileSync(join(root, source.path), 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
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
      if (value === undefined) throw new Error(`${argument} needs a value`);
      if (argument === '--root') options.root = resolve(value);
      else if (!/^\d+$/u.test(value) || Number(value) < minimumBudget) throw new Error(`--budget is a whole number of tokens, ${minimumBudget} or more`);
      else options.budget = Number(value);
    } else if (argument.startsWith('--')) throw new Error(`Unknown option ${argument}`);
    else words.push(argument);
  }
  const docs = readDocs(options.root);
  if (typeof docs.board !== 'string') throw new Error(`No docs/delivery-board.md under ${options.root}`);
  const { bodies, ...graph } = buildProjectGraph(docs);
  if (options.json) return terminalJson(graph);
  return briefing({ ...graph, bodies }, words, options).split('\n').map(terminalLabel).join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log(run(process.argv.slice(2)));
  } catch (error) {
    console.error(terminalLabel(error.message));
    process.exitCode = 1;
  }
}
