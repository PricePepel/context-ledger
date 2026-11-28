// Card P4b: find text in a transcript that looks like a credential, so a person can see
// what a hand-off or export would carry before it leaves the machine, and redact it.
// The scanner only reports and replaces; it never stores, prints or sends a value.
//
// How a span is found:
// - A short pattern recognises where a candidate starts. Its repetition is bounded, so it
//   cannot backtrack for long on a long run of characters.
// - A forward scan then finds where the value really ends: the rest of its character
//   class, its closing quote, a JWT's three segments, or a private key's lines. No cap
//   decides where a value ends, so no tail of a long value is left behind.
// - Each pattern resumes after the whole value it found, so long runs are scanned once.
// - Overlapping candidates merge into one span, labelled with the most specific kind.

/**
 * The scanner's name and rule version, as a signed hand-off records it (P4d). Change the
 * number whenever a rule is added, removed or changed, so a receiver can tell which
 * checks a bundle was redacted with.
 */
export const scannerName = 'context-ledger-secrets/2';
// Card P4e: /2 checks long copies whole (P4e); /1 bundles, signed by P4d builds, still verify.
export const knownScanners = Object.freeze(['context-ledger-secrets/1', scannerName]);

// Keys have letters and digits; a long hyphenated word that starts with sk- does not.
const mixed = value => /[A-Za-z]/u.test(value) && /[0-9]/u.test(value);
const base64url = /[A-Za-z0-9_-]/u;

/** The end of a run of characters matching cls, starting at from. */
function runEnd(text, from, cls) {
  let end = from;
  while (end < text.length && cls.test(text[end])) end += 1;
  return end;
}

/**
 * The escape at i in a JSON or quoted string, decoded: a backslash and one character, or a
 * backslash, u and four hex digits. Returns the character and how many characters it takes.
 */
function escapeAt(text, i) {
  const backslash = String.fromCodePoint(92);
  if (text[i] !== backslash || i + 1 >= text.length) return null;
  if (text[i + 1] === 'u' && /^[0-9A-Fa-f]{4}$/u.test(text.slice(i + 2, i + 6))) {
    return { character: String.fromCodePoint(parseInt(text.slice(i + 2, i + 6), 16)), length: 6 };
  }
  const named = { n: 10, r: 13, t: 9, b: 8, f: 12 }[text[i + 1]];
  return { character: named === undefined ? text[i + 1] : String.fromCodePoint(named), length: 2 };
}

/** A quoted value with its escapes decoded, so a check sees the real characters. */
function decoded(value) {
  let out = '';
  for (let i = 0; i < value.length;) {
    const escape = escapeAt(value, i);
    if (escape) {
      out += escape.character;
      i += escape.length;
    } else {
      out += value[i];
      i += 1;
    }
  }
  return out;
}

/**
 * The end of a run inside a JSON or quoted string: plain characters of cls, and escapes
 * whose decoded character is in cls. An escape that decodes to anything else, such as a
 * line break or a quote, ends the value, so the text after it survives.
 */
function escapedRunEnd(text, from, cls) {
  let end = from;
  while (end < text.length) {
    const escape = escapeAt(text, end);
    if (escape) {
      if (!cls.test(escape.character)) break;
      end += escape.length;
    } else if (cls.test(text[end])) {
      end += 1;
    } else {
      break;
    }
  }
  return end;
}

/**
 * The end of a quoted value that starts at from (just inside the quote): the matching
 * unescaped quote, or the end of the line, whichever comes first. A backslash never
 * escapes a line break.
 */
function quotedEnd(text, from, quote) {
  for (let at = from; at < text.length; at += 1) {
    const character = text[at];
    if (character === '\n' || character === '\r' || character === quote) return at;
    if (character === '\\' && at + 1 < text.length && text[at + 1] !== '\n' && text[at + 1] !== '\r') at += 1;
  }
  return text.length;
}

/**
 * Simple rules: a pattern that recognises the start of the value, the value's character
 * class, and how many leading characters are a fixed public prefix that may be shown.
 */
const simpleRules = [
  { kind: 'anthropic-key', start: /\bsk-ant-[A-Za-z0-9_-]{20}/gu, cls: base64url, prefix: () => 7 },
  { kind: 'github-token', start: /\bgithub_pat_[A-Za-z0-9_]{22}/gu, cls: /[A-Za-z0-9_]/u, prefix: () => 11 },
  { kind: 'github-token', start: /\bgh[pousr]_[A-Za-z0-9]{36}/gu, cls: /[A-Za-z0-9]/u, prefix: () => 4 },
  { kind: 'aws-access-key-id', start: /\b(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Za-z])/gu, cls: /(?!)/u, prefix: () => 4 },
  { kind: 'slack-token', start: /\bxox[abposr]-[A-Za-z0-9-]{10}/gu, cls: /[A-Za-z0-9-]/u, prefix: () => 5 },
  { kind: 'stripe-key', start: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16}/gu, cls: /[A-Za-z0-9]/u, prefix: value => value.indexOf('_', 3) + 1 },
  { kind: 'openai-key', start: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20}/gu, cls: base64url, prefix: value => value.match(/^sk-(?:proj-|svcacct-|admin-)?/u)[0].length, accept: value => mixed(value.slice(3)) },
];

/**
 * Rules for a value after a name or header. The pattern ends where the value begins; the
 * value is then read whole, quoted or not.
 */
const valueRules = [
  { kind: 'aws-secret-access-key', lead: /\baws_secret_access_key\b["']?\s{0,8}[:=]\s{0,8}/giu, cls: /[A-Za-z0-9/+=]/u, accept: value => /^[A-Za-z0-9/+=]{40}$/u.test(value) },
  // Free-text values (a bearer header's value, or any value after a name such as
  // password=) are handled by lineTails below (card P4c), not here.
];

// Card P4c: names whose value is treated as a secret.
const nameKeywords = 'password|passwd|pwd|passphrase|secret|client[ _-]?secret|api[ _-]?key|access[ _-]?key|access[ _-]?token|auth[ _-]?token|refresh[ _-]?token|token';

/**
 * Card P4c: free-text leads. After one of these, the rest of the line is the value: the
 * scanner never guesses where a free-text value ends inside the line, so no fragment of it
 * can be left visible. The cost, other text on that line being redacted too, is bounded by
 * the false-alarm budget in docs/evals.md.
 */
const freeTextLeads = [
  // Only spaces and tabs may sit inside a lead, so a lead never runs onto the next line.
  // The padding after an opening quote is consumed only when the quote is there, so long
  // runs of spaces before a non-Bearer value do not backtrack.
  { kind: 'bearer-token', lead: /\bAuthorization["']?[ \t]*:[ \t]*(?:["'][ \t]*)?Bearer[ \t]+/giu },
  { kind: 'assigned-secret', lead: new RegExp(`\\b(?:[A-Za-z0-9]{1,32}[_.-])?(?:${nameKeywords})\\b["']?[ \\t]*[:=][ \\t]*`, 'giu') },
];

/**
 * A value that is only a stand-in for a secret, judged on the whole value (trailing quotes
 * and closing punctuation removed). Anything more than the stand-in is still a secret.
 */
function isPlaceholder(value) {
  return /^[0-9]+$/u.test(value)
    || /^(?:x+|\*+|\.+|#+|-+)$/iu.test(value)
    || /^(?:changeme|change[_-]?me|placeholder|redacted|null|none|nil|undefined|true|false|required|optional)$/iu.test(value)
    || /^\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|\([A-Za-z_][A-Za-z0-9_]*\)|[A-Za-z_][A-Za-z0-9_]*)$/u.test(value)
    || /^%[A-Za-z_][A-Za-z0-9_]*%$/u.test(value)
    || isAngleStandIn(value)
    || /^(?:process\.env|import\.meta\.env|os\.environ)\.[A-Za-z_][A-Za-z0-9_]*$/u.test(value)
    || /^\[REDACTED [a-z-]{1,32}\]$/u.test(value)
    || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)
    || /^[0-9a-f]{40}$/iu.test(value);
}

// Whole words that mark an angle-bracket stand-in, such as <your-key-here>.
const standInWords = new Set(['key', 'token', 'secret', 'password', 'here', 'value']);

/**
 * An angle-bracket stand-in names what goes there with a whole word, split by spaces,
 * underscores or hyphens: <your-key-here> is one, <monkey9> is not.
 */
function isAngleStandIn(value) {
  if (!/^<[A-Za-z0-9 _-]{1,48}>$/u.test(value)) return false;
  return value.slice(1, -1).split(/[ _-]/u).some(word => standInWords.has(word.toLowerCase()));
}

/** The end of the line that from lies on: the next LF, CR or Unicode line or paragraph separator. */
function lineEndFrom(text, from) {
  for (let at = from; at < text.length; at += 1) if (/[\n\r\p{Zl}\p{Zp}]/u.test(text[at])) return at;
  return text.length;
}

/**
 * The value as judged for a placeholder. Inside a quote it runs to the closing quote on the
 * same line, past backslash-escaped quotes. The quoted part is the whole value only when
 * nothing but spaces and tabs come before a delimiter (, ; ) ] }) or the line end;
 * otherwise, as in the shell value "changeme"synthetic9, the rest of the line is judged
 * and so is never a placeholder. A bare value loses only trailing spaces and a trailing
 * comma or semicolon. Every scan stops at end, and the trim is a backward scan, so long
 * runs of spaces cost nothing.
 */
function judgedValue(text, start, end, quote) {
  if (quote) {
    let close = start;
    while (close < end && text[close] !== quote) close += text[close] === '\\' ? 2 : 1;
    if (close >= end) return text.slice(start, end);
    let after = close + 1;
    while (after < end && (text[after] === ' ' || text[after] === '\t')) after += 1;
    if (after < end && !',;)]}'.includes(text[after])) return text.slice(start, end);
    return text.slice(start, close);
  }
  let stop = end;
  while (stop > start && /[ \t,;]/u.test(text[stop - 1])) stop -= 1;
  return text.slice(start, stop);
}

/** Card P4c: one span per free-text lead, from the value's start to the end of its line. */
function lineTails(text) {
  const found = [];
  for (const rule of freeTextLeads) {
    const pattern = new RegExp(rule.lead.source, rule.lead.flags);
    // Leads come in order, so the line end found for one is reused for later leads on the
    // same line: rejected leads never rescan the line.
    let lineEnd = -1;
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      let start = match.index + match[0].length;
      // An opening quote stays visible; the value starts after it. A quote just before
      // Bearer opens the value too, as in "Authorization": "Bearer ...".
      let quote = /["'`]/u.test(text[start] ?? '') ? text[start] : (rule.kind === 'bearer-token' ? (match[0].match(/(["'])[ \t]*Bearer/iu)?.[1] ?? '') : '');
      if (/["'`]/u.test(text[start] ?? '')) start += 1;
      if (start > lineEnd) lineEnd = lineEndFrom(text, start);
      const end = lineEnd;
      const value = judgedValue(text, start, end, quote);
      if (!value || isPlaceholder(value)) continue;
      // The quote is kept for the copy search (P4d): it may stand before Bearer, not the value.
      found.push({ kind: rule.kind, start, end, prefix: 0, quote });
      // The rest of the line is already covered, so the next lead is looked for after it.
      pattern.lastIndex = Math.max(pattern.lastIndex, end);
    }
  }
  return found;
}

/** JSON Web Tokens: two base64url segments that start eyJ and a signature that may be empty. */
function jwts(text) {
  const found = [];
  const start = /\beyJ[A-Za-z0-9_-]{8}/gu;
  for (let match = start.exec(text); match; match = start.exec(text)) {
    const headerEnd = runEnd(text, match.index, base64url);
    let end = headerEnd;
    if (text[end] === '.' && text.startsWith('eyJ', end + 1)) {
      const payloadEnd = runEnd(text, end + 1, base64url);
      if (payloadEnd - (end + 1) >= 11 && text[payloadEnd] === '.') {
        end = runEnd(text, payloadEnd + 1, base64url);
        found.push({ kind: 'jwt', start: match.index, end, prefix: 3 });
      }
    }
    start.lastIndex = Math.max(start.lastIndex, end);
  }
  return found;
}

/**
 * Private key blocks, walked line by line: the BEGIN line, any PEM header lines (such as
 * Proc-Type) and the blank line after them, base64 lines, and the END line of the same
 * label when it comes next. An unfinished block ends at the first line that cannot belong
 * to it, so it never swallows prose or a later block.
 */
function privateKeys(text) {
  const found = [];
  const begin = /-----BEGIN ((?:[A-Z0-9]{1,16} ){0,3})PRIVATE KEY-----/gu;
  for (let match = begin.exec(text); match; match = begin.exec(text)) {
    const endLine = `-----END ${match[1]}PRIVATE KEY-----`;
    // Spaces or tabs after the BEGIN marker belong to it only when a line break follows them;
    // otherwise prose on the same line is left as it was.
    const markerEnd = match.index + match[0].length;
    const padded = runEnd(text, markerEnd, /[ \t]/u);
    let end = text[padded] === '\n' || (text[padded] === '\r' && text[padded + 1] === '\n') ? padded : markerEnd;
    let blankAllowed = false;
    while (end < text.length) {
      const lineStart = text[end] === '\r' && text[end + 1] === '\n' ? end + 2 : text[end] === '\n' ? end + 1 : -1;
      if (lineStart === -1) break;
      const newline = text.indexOf('\n', lineStart);
      const lineEnd = newline === -1 ? text.length : text[newline - 1] === '\r' ? newline - 1 : newline;
      // Trailing spaces or tabs do not change what a line is; offsets stay the original ones.
      let trimmed = lineEnd;
      while (trimmed > lineStart && (text[trimmed - 1] === ' ' || text[trimmed - 1] === '\t')) trimmed -= 1;
      const line = text.slice(lineStart, trimmed);
      if (line === endLine) {
        // The span ends with the END marker; padding after it is left as it was.
        end = trimmed;
        break;
      }
      if (/^[A-Za-z-]{1,32}: \S/u.test(line)) {
        blankAllowed = true;
      } else if (line === '' && blankAllowed) {
        blankAllowed = false;
      } else if (/^[A-Za-z0-9+/=]+$/u.test(line)) {
        blankAllowed = false;
      } else {
        break;
      }
      end = lineEnd;
    }
    found.push({ kind: 'private-key', start: match.index, end, prefix: 0 });
    begin.lastIndex = Math.max(begin.lastIndex, end);
  }
  return found;
}

/** Every candidate span, each with the rank of its rule (lower is more specific). */
function candidates(text) {
  const all = [];
  for (const candidate of privateKeys(text)) all.push({ ...candidate, rank: 0 });
  for (const candidate of jwts(text)) all.push({ ...candidate, rank: 1 });
  simpleRules.forEach((rule, index) => {
    const pattern = new RegExp(rule.start.source, rule.start.flags);
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      const start = match.index;
      const end = runEnd(text, start + match[0].length, rule.cls);
      const value = text.slice(start, end);
      if (!rule.accept || rule.accept(value)) all.push({ kind: rule.kind, start, end, rank: 2 + index, prefix: Math.min(rule.prefix(value), value.length) });
      // Resume after the whole run, so a long run is read once.
      pattern.lastIndex = Math.max(pattern.lastIndex, end);
    }
  });
  valueRules.forEach((rule, index) => {
    const pattern = new RegExp(rule.lead.source, rule.lead.flags);
    let cached = null;
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      let start = match.index + match[0].length;
      let end;
      const quote = text[start];
      // Whether the value sits inside a string, so its escapes are decoded before it is
      // checked. A bare value is checked exactly as written.
      let inString = false;
      if (quote === '"' || quote === "'" || quote === '`') {
        start += 1;
        end = quotedEnd(text, start, quote);
        inString = true;
      } else {
        const cls = rule.cls;
        // Escapes count only inside a string. A bare value ends at its first character
        // outside cls. The value is inside a string when a quote opens the whole assignment,
        // as in "aws_secret_access_key=…"; a quote that only wraps the field name, as in
        // "aws_secret_access_key": …, leaves the value bare.
        const opensWhole = /["'`]/u.test(text[match.index - 1] ?? '') && !/^[^:=]*["'`]\s{0,8}[:=]/u.test(match[0]);
        inString = opensWhole;
        // Reuse the end of the run this start lies in, so nested names in one long run do
        // not each scan its rest again.
        if (cached && cached.cls === cls && cached.inString === inString && start >= cached.from && start < cached.end) end = cached.end;
        else {
          end = inString ? escapedRunEnd(text, start, cls) : runEnd(text, start, cls);
          cached = { cls, from: start, end, inString };
        }
      }
      const value = text.slice(start, end);
      if (value && rule.accept(inString ? decoded(value) : value)) {
        all.push({ kind: rule.kind, start, end, rank: 2 + simpleRules.length + index, prefix: 0 });
        pattern.lastIndex = Math.max(pattern.lastIndex, end);
      }
      // A rejected value is not skipped: a real secret may sit inside it, after its own name.
    }
  });
  for (const candidate of lineTails(text)) all.push({ ...candidate, rank: 2 + simpleRules.length + valueRules.length });
  return all;
}

/**
 * Every span in text that looks like a credential, in text order. Overlapping candidates
 * merge into one span labelled with the most specific kind. Its prefix may be shown only
 * when that kind's match covers the whole span; otherwise the prefix would be part of an
 * enclosing value.
 */
export function findSecrets(text) {
  if (typeof text !== 'string' || !text) return [];
  const spans = [];
  for (const candidate of candidates(text).sort((a, b) => a.start - b.start || a.rank - b.rank)) {
    const last = spans.at(-1);
    if (last && candidate.start < last.end) {
      last.end = Math.max(last.end, candidate.end);
      if (candidate.rank < last.best.rank) last.best = candidate;
    } else {
      spans.push({ start: candidate.start, end: candidate.end, best: candidate });
    }
  }
  return spans.map(({ start, end, best }) => ({
    kind: best.kind,
    start,
    end,
    prefix: best.start === start && best.end === end ? best.prefix : 0,
  }));
}

/** text with every finding replaced by [REDACTED <kind>]; everything else is unchanged. */
export function redactText(text, findings = findSecrets(text)) {
  let out = '';
  let at = 0;
  for (const { kind, start, end } of findings) {
    out += text.slice(at, start) + `[REDACTED ${kind}]`;
    at = end;
  }
  return out + text.slice(at);
}

/** What may be shown of a finding: its known public prefix, never any other character. */
export function maskedPreview(text, finding) {
  return `${text.slice(finding.start, finding.start + finding.prefix)}…`;
}

// Card P4d: a value found once is also removed where it appears again without a name
// before it (pasted into a later message, say). Shorter values are removed only where
// they were found: a copy search for them would cut ordinary words and numbers.
const minCopyLength = 6;
// The matcher holds each value's first characters, and a match there is compared with the
// whole value before the replacement widens (Codex review of 2026-11-27): a value longer
// than that part is still replaced whole, and a name late in a long line is still seen.
const maxCopyLength = 512;
// How much of one candidate is read for entries at all: its first 64 Ki characters.
const maxEntryLength = 64 * 1024;
// Budgets for the whole session. Past either, redaction refuses the session instead of
// signing a hand-off whose copies were not all checked: the matcher's nodes (memory) and
// the characters compared to confirm long values (time). A node takes about 125 bytes,
// so the matcher stays near 128 MiB at most.
export const maxCopyNodes = 2 ** 20;
export const maxConfirmWork = 2 ** 26;
// And the characters of distinct entries kept while they are collected (Codex round 2 of
// 2026-11-27: a value repeated in many messages kept one endpoint list per copy).
export const maxEntryUnits = 2 ** 24;
// And the copies found: each is a span, a finding and a marker (Codex round 3; a short
// value pasted five million times made five million of each).
export const maxCopySpans = 2 ** 20;
// And the direct findings, counted field by field (Codex round 4: one character after
// pwd= three million times made three million findings and markers).
export const maxFindings = 2 ** 20;
export const copyBudgetMessage = 'This session holds more secret-like text than the copy check can hold, ' +
  'so it was not redacted and nothing was signed.';
// Scanned by hand, not by a regular expression: an unanchored /[...]+$/ retried a long run
// of punctuation at every offset (Codex round 2 of 2026-11-27, quadratic in a 64 Ki word).
const trailingPunctuation = new Set(',.;:!?)]}>"\'`');
const quotes = new Set('"\'`');
function withoutTrailing(word) {
  let end = word.length;
  while (end > 0 && trailingPunctuation.has(word[end - 1])) end -= 1;
  return word.slice(0, end);
}
function withoutLeadingQuotes(word) {
  let start = 0;
  while (start < word.length && quotes.has(word[start])) start += 1;
  return word.slice(start);
}

/**
 * Where a value could end: the end of each word, trailing punctuation left out, and just
 * before each quote or separator, so text with no spaces (JSON, a query string) has
 * boundaries too.
 */
const separators = /["'`,;&|()<>[\]{}]/gu;
function wordEnds(value) {
  const ends = [...value.matchAll(/\S+/gu)].map(match => match.index + withoutTrailing(match[0]).length);
  for (const match of value.matchAll(separators)) ends.push(match.index);
  return ends;
}

/**
 * What a candidate stands for, to search for elsewhere: entries of a text, each counting at
 * the end of every word in it, as written (a passphrase pasted whole is matched whole),
 * and at its end. A candidate can be one key, a line tail after a name (password=...) or a
 * span that holds several, so the entries are its span; every value after a further name
 * inside it (a second password= on the line); every word that mixes letters and digits,
 * as a key does; its quoted part; and each of these decoded, when it holds an escape.
 * Only the candidate's first maxEntryLength characters are read. seen holds the values
 * already collected for the session, which are skipped before their endpoints are worked
 * out, and budget counts their characters against maxEntryUnits. Every value of the
 * candidate is decoded, collected before or not (Codex round 4: a value first collected as
 * another's decoded form was then never decoded itself); decodedFrom keeps that to once.
 */
function copyEntries(text, candidate, seen = new Set(), budget = { units: 0 }, decodedFrom = new Set()) {
  const entries = [];
  const values = [];
  const add = value => {
    if (value.length < minCopyLength) return;
    values.push(value);
    if (seen.has(value)) return;
    seen.add(value);
    budget.units += value.length;
    if (budget.units > maxEntryUnits) throw new Error(copyBudgetMessage);
    entries.push({ value, ends: [...wordEnds(value), value.length] });
  };
  const span = text.slice(candidate.start, Math.min(candidate.end, candidate.start + maxEntryLength));
  add(span);
  // The quote the scanner saw (it can stand before Bearer), else the character before.
  const before = candidate.start > 0 ? text[candidate.start - 1] : '';
  const quote = candidate.quote || (/["'`]/u.test(before) ? before : '');
  if (quote) {
    const close = quotedEnd(text, candidate.start, quote);
    if (close <= candidate.end) add(text.slice(candidate.start, Math.min(close, candidate.start + span.length)));
  }
  // A value after each further name inside the span runs to its closing quote, or else to
  // the next name.
  const leads = freeTextLeads.flatMap(rule => [...span.matchAll(new RegExp(rule.lead.source, rule.lead.flags))])
    .map(match => ({ at: match.index, after: match.index + match[0].length })).sort((a, b) => a.at - b.at);
  leads.forEach((lead, index) => {
    const stop = index + 1 < leads.length ? leads[index + 1].at : span.length;
    const open = /["'`]/u.test(span[lead.after] ?? '') ? span[lead.after] : '';
    const from = lead.after + (open ? 1 : 0);
    add(span.slice(from, open ? Math.min(quotedEnd(span, from, open), stop) : stop));
  });
  for (const match of span.matchAll(/\S+/gu)) {
    for (const piece of match[0].split(new RegExp(separators.source + '+', 'u'))) {
      const bare = withoutTrailing(withoutLeadingQuotes(piece));
      if (mixed(bare)) add(bare);
    }
  }
  // Each text is decoded once, and its decoded words count as written ones do. A text longer
  // than the matcher's part is also decoded up to that part, so the decoded start of a long
  // escaped value still counts at its end, as before the whole value was kept (Codex round 2).
  for (const value of [...values]) {
    if (!value.includes('\\') || decodedFrom.has(value)) continue;
    decodedFrom.add(value);
    add(decoded(value));
    if (value.length > maxCopyLength) add(decoded(value.slice(0, maxCopyLength)));
  }
  return entries;
}

/**
 * The entries main had before P4e, kept exactly beside the whole-value entries (Codex
 * round 3 of 2026-11-27): each kind of entry (span, quoted part, values after names,
 * key-like words, and each one decoded) shares maxCopyLength characters, and the ends are
 * worked out on the part kept, so a copy of a value's first characters that main removed
 * is still removed. More entries only widen what is replaced.
 */
function boundedCopyEntries(text, candidate, seen, budget) {
  const pools = new Map();
  const entries = [];
  const add = (value, pool) => {
    const left = pools.get(pool) ?? maxCopyLength;
    if (left <= 0 || value.length < minCopyLength) return;
    const kept = value.slice(0, left);
    pools.set(pool, left - kept.length);
    entries.push({ value: kept, pool });
  };
  const span = text.slice(candidate.start, Math.min(candidate.end, candidate.start + maxCopyLength));
  add(span, 'span');
  const before = candidate.start > 0 ? text[candidate.start - 1] : '';
  const quote = candidate.quote || (/["'`]/u.test(before) ? before : '');
  if (quote) {
    const close = quotedEnd(text, candidate.start, quote);
    if (close <= candidate.end) add(text.slice(candidate.start, close), 'quoted');
  }
  const leads = freeTextLeads.flatMap(rule => [...span.matchAll(new RegExp(rule.lead.source, rule.lead.flags))])
    .map(match => ({ at: match.index, after: match.index + match[0].length })).sort((a, b) => a.at - b.at);
  leads.forEach((lead, index) => {
    const stop = index + 1 < leads.length ? leads[index + 1].at : span.length;
    const open = /["'`]/u.test(span[lead.after] ?? '') ? span[lead.after] : '';
    const from = lead.after + (open ? 1 : 0);
    add(span.slice(from, open ? Math.min(quotedEnd(span, from, open), stop) : stop), 'named');
  });
  for (const match of span.matchAll(/\S+/gu)) {
    for (const piece of match[0].split(new RegExp(separators.source + '+', 'u'))) {
      const bare = withoutTrailing(withoutLeadingQuotes(piece));
      if (mixed(bare)) add(bare, 'words');
    }
  }
  for (const entry of [...entries]) if (entry.value.includes('\\')) add(decoded(entry.value), entry.pool + ' decoded');
  // Deduplicated after the pools are spent, so each pool keeps exactly what it kept before.
  const fresh = [];
  for (const { value } of entries) {
    if (seen.has(value)) continue;
    seen.add(value);
    budget.units += value.length;
    if (budget.units > maxEntryUnits) throw new Error(copyBudgetMessage);
    fresh.push({ value, ends: [...wordEnds(value), value.length] });
  }
  return fresh;
}

/** The largest of the sorted ends that is at most limit, by binary search, or undefined. */
function largestEndWithin(ends, limit) {
  let low = 0;
  let high = ends.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (ends[middle] <= limit) low = middle + 1;
    else high = middle;
  }
  return low ? ends[low - 1] : undefined;
}

/**
 * A matcher for many values at once (Aho-Corasick over UTF-16 code units): one pass over a
 * text finds, at every position, the longest value that ends there, so the time grows
 * with the text, the values' total length and the matches, not with their product. The
 * matcher holds each value's first maxCopyLength units. Where those match, the text is
 * compared with the whole value and the match widened to the longest of the value's
 * counted ends that the text repeats. Nodes are flat arrays and one edge map; past either
 * session budget (nodeBudget, workBudget) it throws copyBudgetMessage.
 */
export function copyMatcher(entries, { nodeBudget = maxCopyNodes, workBudget = maxConfirmWork, spanBudget = maxCopySpans } = {}) {
  const edges = new Map();
  const edge = (node, unit) => edges.get(node * 65536 + unit);
  const parent = [0];
  const unitOf = [0];
  const depth = [0];
  const fail = [0];
  const length = [0];
  const kindOf = [''];
  // Nodes at depth maxCopyLength where a longer value's first part ends: the whole values.
  const longer = new Map();
  // The same value given twice counts at every end either gave, with the first one's kind.
  const byValue = new Map();
  for (const { value, ends, kind } of entries) {
    const known = byValue.get(value);
    if (known) known.ends.push(...ends);
    else byValue.set(value, { value, ends: [...ends], kind });
  }
  for (const { value, ends, kind } of byValue.values()) {
    const counted = [...new Set(ends.filter(end => end >= minCopyLength))].sort((a, b) => a - b);
    if (!counted.length) continue;
    const cut = value.length > maxCopyLength;
    const last = cut ? maxCopyLength : counted.at(-1);
    const countedHere = new Set(counted.filter(end => end <= maxCopyLength));
    // A value longer than the matcher's part counts at its cut, so that part is always replaced.
    if (cut) countedHere.add(maxCopyLength);
    let node = 0;
    for (let at = 0; at < last; at += 1) {
      const unit = value.charCodeAt(at);
      let child = edge(node, unit);
      if (child === undefined) {
        child = parent.length;
        if (child >= nodeBudget) throw new Error(copyBudgetMessage);
        parent.push(node); unitOf.push(unit); depth.push(at + 1); fail.push(0); length.push(0); kindOf.push('');
        edges.set(node * 65536 + unit, child);
      }
      node = child;
      if (countedHere.has(at + 1) && at + 1 > length[node]) { length[node] = at + 1; kindOf[node] = kind; }
    }
    const rest = cut ? counted.filter(end => end > maxCopyLength) : [];
    if (rest.length) {
      if (!longer.has(node)) longer.set(node, []);
      longer.get(node).push({ value, ends: rest, kind });
    }
  }
  // Breadth first (by depth): a node's failure link is the longest proper suffix that is a
  // node, and it inherits that suffix's longest value when it has none of its own.
  const byDepth = Array.from({ length: maxCopyLength + 1 }, () => []);
  for (let node = 1; node < parent.length; node += 1) byDepth[depth[node]].push(node);
  for (const level of byDepth) {
    for (const node of level) {
      if (depth[node] > 1) {
        let link = fail[parent[node]];
        let target = edge(link, unitOf[node]);
        while (target === undefined && link !== 0) {
          link = fail[link];
          target = edge(link, unitOf[node]);
        }
        fail[node] = target !== undefined && target !== node ? target : 0;
      }
      if (length[node] === 0) { length[node] = length[fail[node]]; kindOf[node] = kindOf[fail[node]]; }
    }
  }
  let work = 0;
  let made = 0;
  return text => {
    const spans = [];
    let node = 0;
    for (let at = 0; at < text.length; at += 1) {
      const unit = text.charCodeAt(at);
      let next = edge(node, unit);
      while (next === undefined && node !== 0) {
        node = fail[node];
        next = edge(node, unit);
      }
      node = next ?? 0;
      if (!length[node]) continue;
      let start = at + 1 - length[node];
      let end = at + 1;
      let spanKind = kindOf[node];
      // The first part of a longer value: compare the rest, unless a span already covers it.
      for (const whole of longer.get(node) ?? []) {
        // Every value looked at costs one unit, skipped or not, plus each character compared.
        work += 1;
        if (work > workBudget) throw new Error(copyBudgetMessage);
        const from = at + 1 - maxCopyLength;
        // Only an end that fits in the rest of the text can be reached (Codex round 4: a
        // 64 Ki value compared against itself at every later place used the whole budget).
        const fits = largestEndWithin(whole.ends, text.length - from);
        if (fits === undefined) continue;
        const last = spans.at(-1);
        if (last && last.start <= from && last.end >= from + fits) continue;
        let same = maxCopyLength;
        const limit = fits;
        while (same < limit && text.charCodeAt(from + same) === whole.value.charCodeAt(same)) same += 1;
        work += same - maxCopyLength;
        if (work > workBudget) throw new Error(copyBudgetMessage);
        const reached = largestEndWithin(whole.ends, same);
        if (reached !== undefined && from + reached > end) {
          start = Math.min(start, from);
          end = from + reached;
          spanKind = whole.kind;
        }
      }
      // A new match merges with the spans it overlaps at the end. A widened span can end
      // after later matches, so the merged span keeps the largest end.
      let merged = false;
      while (spans.length && spans.at(-1).end > start) {
        const last = spans.pop();
        if (last.start <= start) { start = last.start; spanKind = last.kind; }
        end = Math.max(end, last.end);
        merged = true;
      }
      // A disjoint span is a new copy, counted for the session before it is made.
      if (!merged && ++made > spanBudget) throw new Error(copyBudgetMessage);
      spans.push({ kind: spanKind, start, end, prefix: 0 });
    }
    return spans;
  };
}

/**
 * findings and copies merged into spans. A copy that widens a finding hides its prefix.
 * A finding's prefix is only ever a key format's public start (ghp_, AKIA), so a copy
 * inside it shows nothing that is not public.
 */
function withCopies(findings, copies) {
  if (!copies.length) return findings;
  const all = [...findings.map(finding => ({ ...finding, rank: 0 })), ...copies.map(copy => ({ ...copy, rank: 1 }))];
  const spans = [];
  for (const span of all.sort((a, b) => a.start - b.start || a.rank - b.rank)) {
    const last = spans.at(-1);
    if (last && span.start < last.end) {
      if (span.end > last.end) Object.assign(last, { end: span.end, prefix: 0 });
    } else {
      spans.push({ kind: span.kind, start: span.start, end: span.end, prefix: span.prefix });
    }
  }
  return spans;
}

/**
 * A copy of the session with its source name, every message and every agent turn's author
 * and recipient redacted, and the findings. Each finding has a line (null for the source
 * name), a kind, a length and a masked preview, never a value. A value found in one place
 * is also removed everywhere else it appears in the session, when it is at least six
 * characters long (P4d).
 */
export function redactSession(session) {
  const fields = [];
  if (typeof session.source === 'string') fields.push({ text: session.source, line: null, message: -1, name: 'source' });
  session.messages.forEach((message, index) => {
    fields.push({ text: message.text, line: message.line, message: index, name: 'text' });
    // Card I3: an agent turn's paths are printed in its heading, so they are checked too.
    if (message.role === 'agent') {
      for (const name of ['author', 'recipient']) {
        if (typeof message[name] === 'string') fields.push({ text: message[name], line: message.line, message: index, name });
      }
    }
  });
  let direct = 0;
  const found = fields.map(field => {
    const spans = findSecrets(field.text);
    direct += spans.length;
    if (direct > maxFindings) throw new Error(copyBudgetMessage);
    return spans;
  });
  // Copies are searched for each candidate the scanner accepted, before candidates merge
  // into findings, so a key inside a longer finding keeps its own boundaries.
  const entries = [];
  const seen = new Set();
  const budget = { units: 0 };
  const held = [];
  fields.forEach((field, index) => {
    const spans = found[index];
    if (!spans.length) return;
    // Both lists sorted by start: each candidate takes the kind of the finding holding it.
    let at = 0;
    for (const candidate of [...candidates(field.text), ...spans].sort((a, b) => a.start - b.start)) {
      while (at < spans.length - 1 && spans[at].end <= candidate.start) at += 1;
      const holder = spans[at].start <= candidate.start && candidate.start < spans[at].end ? spans[at] : candidate;
      held.push({ text: field.text, candidate, kind: holder.kind });
      for (const entry of boundedCopyEntries(field.text, candidate, seen, budget)) entries.push({ ...entry, kind: holder.kind });
    }
  });
  const decodedFrom = new Set();
  for (const { text, candidate, kind } of held) {
    for (const entry of copyEntries(text, candidate, seen, budget, decodedFrom)) entries.push({ ...entry, kind });
  }
  const copiesIn = entries.length ? copyMatcher(entries) : () => [];
  const findings = [];
  let source = session.source;
  const changed = new Map();
  fields.forEach((field, index) => {
    const spans = withCopies(found[index], copiesIn(field.text));
    if (!spans.length) return;
    for (const span of spans) {
      findings.push({ line: field.line, kind: span.kind, length: span.end - span.start, preview: maskedPreview(field.text, span) });
    }
    const text = redactText(field.text, spans);
    if (field.message === -1) {
      source = text;
      return;
    }
    const message = changed.get(field.message) ?? { ...session.messages[field.message] };
    message[field.name] = text;
    changed.set(field.message, message);
  });
  const messages = session.messages.map((message, index) => changed.get(index) ?? message);
  return { session: { ...session, source, messages }, findings };
}
