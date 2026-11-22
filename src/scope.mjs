// Card G9: a briefing scoped to a question, cut to a token budget. The question picks
// the nodes that match it and the nodes one edge away; the budget drops nodes,
// neighbours first, until the briefing's estimate fits.
import { InputError } from './errors.mjs';
import { largest } from './paging.mjs';

export const maxQuestionCharacters = 500;
export const minBudget = 50;
export const maxBudget = 100_000;

// Common words that would match almost any node.
const stopWords = new Set(['the', 'and', 'for', 'are', 'was', 'not', 'but', 'its', 'has', 'had', 'can', 'all', 'any',
  'out', 'one', 'how', 'why', 'who', 'what', 'which', 'when', 'where', 'whose', 'with', 'from', 'that', 'this', 'these',
  'those', 'there', 'their', 'they', 'them', 'then', 'than', 'have', 'does', 'did', 'will', 'would', 'should', 'could',
  'into', 'about', 'over', 'under', 'some', 'more', 'most', 'also', 'just', 'only', 'very', 'you', 'your', 'our', 'ours',
  'now', 'yet', 'still', 'tell', 'show', 'give', 'list', 'need', 'needs', 'know', 'want', 'wants', 'let', 'get', 'got']);

/** The length that the 500-character limit counts: code points, as JSON Schema does. */
export const questionLength = question => Array.from(question).length;

// Words in any script, a letter keeping its combining marks.
const wordsOf = text => text.normalize('NFC').toLowerCase().match(/[\p{L}\p{N}\p{M}]+/gu) ?? [];
const isAscii = word => !/\P{ASCII}/u.test(word);
// Letters with their combining marks, so a Devanagari vowel sign stays with its letter.
const lettersOf = word => word.match(/\P{M}\p{M}*|\p{M}+/gu) ?? [];

/**
 * The question's words, each once and each with one rule (review of 103051b): an ASCII
 * word of three or more characters that is not a common word, or a word in another
 * script. "café" is one word in another script, not "caf" plus "é".
 */
export function questionTerms(question) {
  const words = [...new Set(wordsOf(question))];
  return {
    ascii: words.filter(word => isAscii(word) && word.length >= 3 && !stopWords.has(word)),
    foreign: words.filter(word => !isAscii(word)),
  };
}

// A space joins the two letters: it cannot occur inside a word.
const pairsOf = letters => letters.slice(1).map((letter, index) => `${letters[index]} ${letter}`);

function nodeText(node) {
  const text = [node.label, node.id.replace(/[-_.]/gu, ' '), node.kind, node.to].filter(Boolean).join(' ');
  const words = wordsOf(text);
  // Pairs of whole letters (each with its marks), so a pair never ends inside a letter.
  return { words, pairs: new Set(words.flatMap(word => pairsOf(lettersOf(word)))) };
}

// Four letters or more compare by their first four, so "decided" finds a decision; a
// three-letter word must start a word ("gpu" finds "GPU time" and "GPU時", not "upgpu").
// The prefix is compared in whole letters, so "qax" does not stop inside an x with an accent.
const asciiMatch = (term, words) => {
  const prefix = term.length >= 4 ? term.slice(0, 4) : term;
  return words.some(word => lettersOf(word).slice(0, prefix.length).join('') === prefix);
};
// Another script: two letters in a row of the word, one of them outside ASCII, must be two
// letters in a row of the node. A one-letter word must be a whole word of the node.
const foreignMatch = (word, { words, pairs }) => {
  const letters = lettersOf(word);
  if (letters.length === 1) return words.includes(word);
  return pairsOf(letters).some(pair => !isAscii(pair) && pairs.has(pair));
};

/** How many of the question's words a node matches, each word counted once. */
export function nodeScore(node, terms) {
  const text = nodeText(node);
  return terms.ascii.filter(term => asciiMatch(term, text.words)).length
    + terms.foreign.filter(word => foreignMatch(word, text)).length;
}

/**
 * The nodes to show for a question, in the order they are kept under a budget:
 * matches by score (ties in packet order), then their neighbours in packet order.
 */
export function rankNodes(packet, question) {
  const terms = questionTerms(question);
  const scored = packet.nodes.map((node, index) => ({ id: node.id, index, score: nodeScore(node, terms) }));
  const matched = scored.filter(entry => entry.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
  const matchedIds = new Set(matched.map(entry => entry.id));
  const near = new Set();
  for (const { from, to } of packet.edges) {
    if (matchedIds.has(from) && !matchedIds.has(to)) near.add(to);
    if (matchedIds.has(to) && !matchedIds.has(from)) near.add(from);
  }
  const neighbours = packet.nodes.filter(node => near.has(node.id)).map(node => node.id);
  return { matched: matched.map(entry => entry.id), neighbours };
}

/** The graph cut down to the given node IDs: their edges, their links and their state. */
export function graphWith(graph, ids) {
  const shown = new Set(ids);
  const packet = graph.packet;
  const cut = {
    ...packet,
    nodes: packet.nodes.filter(node => shown.has(node.id)),
    edges: packet.edges.filter(edge => shown.has(edge.from) && shown.has(edge.to)),
  };
  if (packet.links) cut.links = packet.links.filter(link => shown.has(link.from));
  const scoped = { ...graph, packet: cut };
  // Every derived ID list (ready actions, current decisions, open questions and any
  // later one) names only nodes that are shown. Card G9b: leftOut counts the rest, so a
  // state line can say that some were left out instead of reading as none.
  scoped.leftOut = {};
  for (const [key, value] of Object.entries(graph)) {
    if (!key.endsWith('Ids') || !Array.isArray(value)) continue;
    scoped[key] = value.filter(id => shown.has(id));
    scoped.leftOut[key] = value.length - scoped[key].length;
  }
  return scoped;
}

const estimateTokens = text => Math.ceil(text.length / 4);

function scopeLine({ total, matched, shownMatched, shownNeighbours, left, budget }) {
  if (!matched) return `scope: the question matched none of the ${total} nodes; call context_for without a question for the whole graph`;
  const parts = [`scope: the question matched ${matched} of ${total} nodes`,
    `showing ${shownMatched} of them and ${shownNeighbours} neighbours`];
  if (budget !== undefined) parts.push(`${left} left out for a budget of ${budget} tokens`);
  // Card G9b: whenever a node is not shown, say how to read the whole graph.
  if (shownMatched + shownNeighbours < total) parts.push('call context_for without a question for the whole graph');
  return parts.join('; ');
}

/**
 * Render a scoped briefing. render(graph, scope) returns the briefing text for a graph
 * and a scope line. Returns the text and the counts behind the scope line.
 */
export function scopedText(graph, { question, budget }, render) {
  const { matched, neighbours } = rankNodes(graph.packet, question);
  const order = [...matched, ...neighbours];
  const total = graph.packet.nodes.length;
  const textFor = count => {
    // Matches come first in the order, so the first min(count, matches) shown are matches.
    const shownMatched = Math.min(count, matched.length);
    return render(graphWith(graph, order.slice(0, count)), scopeLine({
      total, matched: matched.length, shownMatched, shownNeighbours: count - shownMatched,
      left: order.length - count, budget,
    }));
  };
  if (budget === undefined) return textFor(order.length);
  const fits = k => estimateTokens(textFor(k)) <= budget;
  // G9b review: the whole-graph hint makes every briefing that leaves a node out a little
  // longer, so the full briefing can be shorter than a cut one. Try it first.
  if (fits(order.length)) return textFor(order.length);
  // Review of 103051b: even with no nodes the header and state lines cost tokens. A
  // budget below that is refused rather than answered over budget.
  if (!fits(0)) {
    const smallest = Math.min(estimateTokens(textFor(0)), estimateTokens(textFor(order.length)));
    throw new InputError(`budget is below the smallest briefing of this graph, about ${smallest} tokens.`);
  }
  return textFor(largest(1, order.length, fits));
}
