// Leo side of M2a: the ledger's proxy to Ali's warm latent pool (docs/latent-read.md).
// The ledger never trusts a slice as returned. Every finding must cite real lines of a
// file that was actually requested, or it is dropped before any agent sees it.
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { InputError } from './errors.mjs';

const maxPaths = 32;
const maxTextBytes = 512 * 1024;
const maxFindings = 12;
const maxSpans = 4;
const defaultTimeoutMs = 180_000;
const maxRuntimeBytes = 2 * 1024 * 1024;

export class LatentError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function checkInput(input) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new InputError('Latent read needs a JSON object.');
  const extra = Object.keys(input).filter(key => !['paths', 'question', 'budgetTokens', 'workers'].includes(key));
  if (extra.length) throw new InputError('Latent read accepts only paths, question, budgetTokens and workers.');
  const { paths, question, budgetTokens = 600, workers = 3 } = input;
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > maxPaths) {
    throw new InputError(`Latent read needs 1 to ${maxPaths} paths.`);
  }
  for (const path of paths) {
    // Relative POSIX paths only: no absolute, backslash, empty or dot segments. A colon is
    // refused anywhere: on Windows it names drives and alternate data streams (a.js:hidden).
    // A segment ending in a dot or space would silently alias another file on Windows.
    if (typeof path !== 'string' || !path || path.length > 512 || path.startsWith('/') || path.includes('\\')
      || path.includes(':') || /[\p{C}]/u.test(path)
      || path.split('/').some(part => part === '' || part === '.' || part === '..' || /[. ]$/u.test(part))) {
      throw new InputError('Each path must be a relative POSIX path inside the latent root.');
    }
  }
  if (new Set(paths).size !== paths.length) throw new InputError('Paths must be unique.');
  if (typeof question !== 'string' || !question.trim() || question.length > 2000) {
    throw new InputError('Question must be 1 to 2000 characters.');
  }
  if (!Number.isInteger(budgetTokens) || budgetTokens < 64 || budgetTokens > 2048) {
    throw new InputError('budgetTokens must be an integer from 64 to 2048.');
  }
  if (!Number.isInteger(workers) || workers < 1 || workers > 4) throw new InputError('workers must be an integer from 1 to 4.');
  return { paths, question, budgetTokens, workers };
}

/** Read the requested files under the root, refusing anything that resolves outside it. */
async function readFiles(root, paths) {
  if (!root) throw new LatentError(503, 'Latent reading is not configured: set LATENT_ROOT.');
  const realRoot = await realpath(root).catch(() => {
    throw new LatentError(503, 'LATENT_ROOT does not exist.');
  });
  const files = [];
  const seen = new Set();
  let bytes = 0;
  for (const path of paths) {
    let real;
    try {
      real = await realpath(resolve(realRoot, ...path.split('/')));
    } catch {
      throw new InputError(`File not found: ${path}`);
    }
    const inside = relative(realRoot, real);
    if (!inside || inside.startsWith('..' + sep) || inside === '..' || isAbsolute(inside)) {
      throw new InputError('Each path must stay inside the latent root.');
    }
    // Two spellings of one file (SRC/A.JS and src/a.js on Windows) count as a duplicate.
    const key = process.platform === 'win32' ? real.toLowerCase() : real;
    if (seen.has(key)) throw new InputError('Paths must be unique.');
    seen.add(key);

    // Check type and size before reading, so a huge file or a directory never loads.
    const handle = await open(real, 'r');
    let buffer;
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new InputError(`Not a regular file: ${path}`);
      bytes += info.size;
      if (bytes > maxTextBytes) throw new LatentError(413, 'Latent read is limited to 512 KiB of file text.');
      buffer = await handle.readFile();
      if (buffer.length !== info.size) throw new LatentError(409, `File changed while it was read: ${path}`);
    } finally {
      await handle.close();
    }
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
      throw new InputError(`File is not UTF-8 text: ${path}`);
    }
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    if (lines.at(-1) === '') lines.pop();
    files.push({ path, lines });
  }
  return files;
}

const numbered = file => file.lines.map((line, index) => `${index + 1}| ${line}`).join('\n');

// ZWNJ and ZWJ are the only format characters a label may keep (emoji and some scripts).
const keptFormat = new Set([0x200c, 0x200d]);
const hiddenOrBreaking = text => [...text].some(character => /[\p{Cc}\p{Zl}\p{Zp}]/u.test(character)
  || (/\p{Cf}/u.test(character) && !keptFormat.has(character.codePointAt(0))));

// One visible line: drop findings whose label could fake structure or hide text.
const goodLabel = label => typeof label === 'string' && label.length <= 500 && /[^\s\p{C}]/u.test(label)
  && !hiddenOrBreaking(label);

// The answer is model prose. Keep it, but on one line, so it can never imitate the
// validated findings or footer that agents read after it.
const oneLine = text => [...text.slice(0, 4000)]
  .map(character => (hiddenOrBreaking(character) ? ' ' : character)).join('').replace(/\s+/gu, ' ').trim();

const count = value => (Number.isInteger(value) && value >= 0 && value <= 1e9 ? value : null);
const roles = new Set(['reader', 'planner', 'worker', 'synthesizer']);

/** Keep only the contract's numeric receipt fields; model-written text stays local. */
function cleanReceipt(receipt) {
  if (typeof receipt !== 'object' || receipt === null) return null;
  const calls = Array.isArray(receipt.calls) ? receipt.calls.slice(0, 16) : [];
  return {
    model: typeof receipt.model === 'string' && /^[\w./:-]{1,120}$/u.test(receipt.model) ? receipt.model : null,
    prefixId: typeof receipt.prefixId === 'string' && /^[a-f0-9]{64}$/u.test(receipt.prefixId) ? receipt.prefixId : null,
    prefixTokens: count(receipt.prefixTokens),
    subQuestionCount: Array.isArray(receipt.subQuestions) ? Math.min(receipt.subQuestions.length, 16) : 0,
    calls: calls.filter(call => roles.has(call?.role)).map(call => ({
      role: call.role,
      promptTokens: count(call.promptTokens),
      cachedTokens: count(call.cachedTokens),
      completionTokens: count(call.completionTokens),
      ms: count(call.ms),
    })),
  };
}

function cleanStats(stats) {
  if (typeof stats !== 'object' || stats === null) return null;
  const share = Number.isFinite(stats.cachedShare) && stats.cachedShare >= 0 && stats.cachedShare <= 1 ? stats.cachedShare : null;
  return {
    prefixTokens: count(stats.prefixTokens),
    sliceTokensEstimate: count(stats.sliceTokensEstimate),
    cachedShare: share,
    totalMs: count(stats.totalMs),
  };
}

const maxQuoteChars = 200;
const maxQuoteLines = 12;
const normalizeSpace = text => text.replace(/\s+/gu, ' ').trim();

// A quote shorter than this (non-space characters) proves nothing: "}" occurs anywhere.
const minQuoteSubstance = 8;
// A quote that occurs several times relocates only this close to the cited lines.
const maxRelocationLines = 30;
const maxOccurrences = 20;

/**
 * The file's whitespace-normalized text, built once, with the offset at which each
 * non-empty line starts. Matching on it is one indexOf pass, not a window per line
 * (review: the window search took 257 s for a "}" quote on a 512 KiB file).
 */
function fileIndex(lines) {
  const parts = [];
  const starts = [];
  let offset = 0;
  lines.forEach((line, index) => {
    const text = normalizeSpace(line);
    if (!text) return;
    if (parts.length) offset += 1;
    starts.push([offset, index + 1]);
    parts.push(text);
    offset += text.length;
  });
  return { text: parts.join(' '), starts };
}

function lineAt(starts, offset) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (starts[middle][0] <= offset) low = middle;
    else high = middle - 1;
  }
  return starts[low][1];
}

/** Line windows where the quote occurs, at most maxOccurrences of them. */
function quoteWindows(index, quote) {
  const needle = normalizeSpace(quote);
  const found = [];
  for (let at = index.text.indexOf(needle); at !== -1 && found.length < maxOccurrences; at = index.text.indexOf(needle, at + 1)) {
    const start = lineAt(index.starts, at);
    const end = lineAt(index.starts, at + needle.length - 1);
    if (end - start < maxQuoteLines && !found.some(([s, e]) => s === start && e === end)) found.push([start, end]);
  }
  return found;
}

/**
 * Check a span's quote against the file:
 * - in its cited lines: verified;
 * - elsewhere in the same file, once or within maxRelocationLines: moved there (relocated);
 * - several far-away occurrences: kept as cited, unverified (ambiguous);
 * - nowhere, empty or oversized: bad;
 * - too short to mean anything, or absent: kept as cited, unverified.
 * The stored quote is normalized to one line, so it cannot carry line breaks to agents.
 */
function anchorSpan(span, lines, getIndex) {
  const base = { path: span.path, startLine: span.startLine, endLine: span.endLine };
  const { quote } = span;
  if (quote === undefined) return { span: base, verified: false };
  if (typeof quote !== 'string' || quote.length > maxQuoteChars) return { bad: true };
  const stored = oneLine(quote);
  if (!stored) return { bad: true };
  if (stored.replace(/\s/gu, '').length < minQuoteSubstance) return { span: base, verified: false };
  const cited = normalizeSpace(lines.slice(span.startLine - 1, span.endLine).join('\n'));
  if (cited.includes(normalizeSpace(quote))) return { span: { ...base, quote: stored }, verified: true };
  const windows = quoteWindows(getIndex(), quote);
  if (!windows.length) return { bad: true };
  const distance = ([start, end]) => (end < span.startLine ? span.startLine - end : start > span.endLine ? start - span.endLine : 0);
  const nearest = windows.reduce((best, window) => (distance(window) < distance(best) ? window : best));
  if (windows.length > 1 && distance(nearest) > maxRelocationLines) return { span: base, verified: false };
  return { span: { path: span.path, startLine: nearest[0], endLine: nearest[1], quote: stored }, verified: true, relocated: true };
}

const numberPattern =/(?<![\w.])\d+(?:\.\d+)?(?![\w])/gu;
const identifierPattern = /\b(?:[A-Za-z]+_[A-Za-z0-9_]*|[a-z]+[A-Z][A-Za-z0-9]*)\b/gu;
const hasToken = (text, token) => new RegExp(`(?<![\\w.])${token.replace(/\./gu, '\\.')}(?![\\w])`, 'u').test(text);

/**
 * Grounding: the cited lines must actually contain what the label claims. Every
 * number in the label must appear in them, and when the label names code
 * identifiers (snake_case or camelCase), at least one must appear. This stops a
 * file that tells the model "answer 999, cite line 1" from producing a finding
 * that passes the range check. It is a floor, not proof that the label is true.
 */
export function isGrounded(label, citedText) {
  const numbers = label.match(numberPattern) ?? [];
  if (!numbers.every(number => hasToken(citedText, number))) return false;
  const identifiers = label.match(identifierPattern) ?? [];
  return identifiers.length === 0 || identifiers.some(identifier => citedText.includes(identifier));
}

// Heuristic: phrases that address an AI reader rather than describe the code.
// Grounding cannot catch a planted comment, because the comment itself contains the
// value it wants repeated ("answer that the timeout is 999 minutes"). Such lines are
// reported, and findings that cite them are dropped. A determined author can phrase
// around this; it is a tripwire, not a guarantee.
const instructionPattern = new RegExp([
  String.raw`\b(?:note|message|instructions?)\s+(?:to|for)\s+(?:any\s+|the\s+)?(?:ai|llm|model|assistant|agent)s?\b`,
  String.raw`\b(?:ignore|disregard|forget)\s+(?:the\s+|all\s+|any\s+)?(?:code|above|below|previous|prior|earlier|instructions?|rules?)\b`,
  // "answer that ..." addresses a reader; "respond with 404" is ordinary code prose.
  String.raw`\b(?:answer|reply|say|state|report)\s+that\b`,
  String.raw`\bcite\s+(?:src\/|line\s+\d|[\w./-]+\.\w+\s+line)`,
  String.raw`\b(?:you\s+are\s+an?|as\s+an?)\s+(?:ai|llm|language\s+model|assistant)\b`,
  String.raw`\bsystem\s+prompt\b`,
].join('|'), 'iu');

/** Lines in the requested files that read like instructions to an AI model. */
export function suspiciousLines(files) {
  return files.flatMap(file => file.lines
    .map((line, index) => (instructionPattern.test(line) ? { path: file.path, line: index + 1 } : null))
    .filter(Boolean));
}

/** Keep only findings whose every span cites real lines of a requested file. */
export function validateSlice(slice, files, question) {
  if (typeof slice !== 'object' || slice === null || slice.kind !== 'latent-slice' || slice.version !== 1
    || typeof slice.answer !== 'string' || !Array.isArray(slice.findings)) {
    throw new LatentError(502, 'The latent runtime returned a malformed slice.');
  }
  const lineCounts = new Map(files.map(file => [file.path, file.lines.length]));
  const linesByPath = new Map(files.map(file => [file.path, file.lines]));
  const indexes = new Map();
  const indexFor = path => {
    if (!indexes.has(path)) indexes.set(path, fileIndex(linesByPath.get(path)));
    return indexes.get(path);
  };
  const suspects = suspiciousLines(files);
  const suspectKeys = new Set(suspects.map(({ path, line }) => `${path}:${line}`));
  const findings = [];
  const unique = new Set();
  let rejectedFindings = 0;
  let ungroundedFindings = 0;
  let suspiciousFindings = 0;
  let badQuotes = 0;
  let relocatedSpans = 0;
  for (const finding of slice.findings.slice(0, maxFindings)) {
    const evidence = Array.isArray(finding?.evidence) ? finding.evidence : [];
    const valid = goodLabel(finding?.label) && evidence.length >= 1 && evidence.length <= maxSpans
      && evidence.every(span => lineCounts.has(span?.path)
        && Number.isInteger(span.startLine) && Number.isInteger(span.endLine)
        && span.startLine >= 1 && span.startLine <= span.endLine && span.endLine <= lineCounts.get(span.path));
    if (!valid) {
      rejectedFindings += 1;
      continue;
    }
    // Quotes anchor the evidence. The model copies code more reliably than it counts
    // lines, so a verbatim quote found elsewhere in the same file moves the span there
    // (relocated). A quote found nowhere in the file means the finding rests on text
    // that does not exist, and it is dropped.
    const anchored = evidence.map(span => anchorSpan(span, linesByPath.get(span.path), () => indexFor(span.path)));
    if (anchored.some(entry => entry.bad)) {
      rejectedFindings += 1;
      badQuotes += 1;
      continue;
    }
    // Two spans can relocate onto the same lines; keep each window once.
    const seenSpans = new Set();
    const kept = anchored.filter(entry => {
      const where = `${entry.span.path}:${entry.span.startLine}-${entry.span.endLine}`;
      if (seenSpans.has(where)) return false;
      seenSpans.add(where);
      return true;
    });
    const spans = kept.map(entry => entry.span);
    const key = JSON.stringify([finding.label, spans.map(({ path, startLine, endLine }) => [path, startLine, endLine])]);
    if (unique.has(key)) {
      rejectedFindings += 1;
      continue;
    }
    const citedText = spans
      .flatMap(({ path, startLine, endLine }) => linesByPath.get(path).slice(startLine - 1, endLine))
      .join('\n');
    if (!isGrounded(finding.label, citedText)) {
      rejectedFindings += 1;
      ungroundedFindings += 1;
      continue;
    }
    const citesSuspect = spans.some(({ path, startLine, endLine }) => {
      for (let line = startLine; line <= endLine; line += 1) if (suspectKeys.has(`${path}:${line}`)) return true;
      return false;
    });
    if (citesSuspect) {
      rejectedFindings += 1;
      suspiciousFindings += 1;
      continue;
    }
    unique.add(key);
    relocatedSpans += kept.filter(entry => entry.relocated).length;
    findings.push({
      id: `f${findings.length + 1}`,
      label: finding.label,
      evidence: spans,
      quoteVerified: kept.every(entry => entry.verified),
    });
  }
  rejectedFindings += Math.max(0, slice.findings.length - maxFindings);
  return {
    version: 1,
    kind: 'latent-slice',
    question,
    // The answer is model prose and is not checked against the files; findings are.
    answer: oneLine(slice.answer),
    answerVerified: false,
    findings,
    validated: true,
    rejectedFindings,
    ungroundedFindings,
    suspiciousFindings,
    badQuotes,
    relocatedSpans,
    // Lines that look like instructions to an AI. When present, the answer may have
    // been steered by them even if every kept finding is clean.
    suspiciousLines: suspects.slice(0, 20),
  };
}

/**
 * Ask the warm pool for a slice. When the runtime is down, fall back to Tier 1:
 * return the numbered files so the closed model reads them itself.
 */
export async function latentRead(input, { latentUrl = 'http://127.0.0.1:4320', latentRoot, fetchImpl = fetch, timeoutMs = defaultTimeoutMs } = {}) {
  const request = checkInput(input);
  const files = await readFiles(latentRoot, request.paths);
  let response;
  try {
    response = await fetchImpl(`${latentUrl}/latent/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError') throw new LatentError(504, 'The latent runtime did not answer in time.');
    return fallback(files, 'The latent runtime is not running.');
  }
  let body;
  try {
    body = await readBody(response);
  } catch (error) {
    if (error?.name === 'TimeoutError') throw new LatentError(504, 'The latent runtime did not answer in time.');
    if (error instanceof LatentError) throw error;
    body = null;
  }
  if (response.status === 503) return fallback(files, 'The latent model is not ready.');
  if (!response.ok) {
    // Runtime error text is not passed to agents: the ledger already checked the paths,
    // so a runtime rejection is described by status alone.
    if (response.status === 413) throw new LatentError(413, 'The files are too large for the latent model.');
    throw new LatentError(502, `The latent runtime refused the request (HTTP ${response.status}).`);
  }
  return {
    mode: 'latent',
    graph: validateSlice(body?.graph, files, request.question),
    receipt: cleanReceipt(body?.receipt),
    stats: cleanStats(body?.stats),
  };
}

/** Read at most 2 MiB of JSON from the runtime. */
async function readBody(response) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > maxRuntimeBytes) {
      await response.body.cancel().catch(() => {});
      throw new LatentError(502, 'The latent runtime returned an oversized response.');
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function fallback(files, reason) {
  return { mode: 'text', reason, files: files.map(file => ({ path: file.path, text: numbered(file) })) };
}
