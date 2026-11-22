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

import secretRules from '../rules/secret-rules.json' with { type: 'json' };

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

// Card W2: the rule tables below are built from rules/secret-rules.json, which the latent
// runtime's gateway (runtime/latent_team/secret_scan.py) reads too, so a rule changes in
// one place. rules/secret-conformance.json holds the cases both test suites run.

/**
 * Simple rules: a pattern that recognises the start of the value, the value's character
 * class (none: the start is the whole value), and an anchored pattern whose match is the
 * fixed public prefix that may be shown. mixedAfter: the value from that index on must hold
 * a letter and a digit, so a long hyphenated word after sk- is not a key.
 */
const simpleRules = secretRules.simple.rules.map(rule => {
  const prefix = new RegExp(rule.prefix, 'u');
  return {
    kind: rule.kind,
    start: new RegExp(rule.start, 'gu'),
    cls: new RegExp(rule.cls ?? '(?!)', 'u'),
    prefix: value => value.match(prefix)?.[0].length ?? 0,
    accept: rule.mixedAfter === undefined ? undefined : value => mixed(value.slice(rule.mixedAfter)),
  };
});

/**
 * Rules for a value after a name or header. The pattern ends where the value begins; the
 * value is then read whole, quoted or not. Free-text values (a bearer header's value, or
 * any value after a name such as password=) are handled by lineTails below (card P4c).
 */
const valueRules = secretRules.values.rules.map(rule => {
  const accept = new RegExp(rule.accept, 'u');
  return { kind: rule.kind, lead: new RegExp(rule.lead, 'giu'), cls: new RegExp(rule.cls, 'u'), accept: value => accept.test(value) };
});

// Card P4c: names whose value is treated as a secret.
const nameKeywords = secretRules.freeText.nameKeywords.join('|');

/**
 * Card P4c: free-text leads. After one of these, the rest of the line is the value: the
 * scanner never guesses where a free-text value ends inside the line, so no fragment of it
 * can be left visible. The cost, other text on that line being redacted too, is bounded by
 * the false-alarm budget in docs/evals.md. Only spaces and tabs may sit inside a lead, so a
 * lead never runs onto the next line, and the padding after an opening quote is consumed
 * only when the quote is there, so long runs of spaces before a non-Bearer value do not
 * backtrack.
 */
const freeTextLeads = [
  { kind: 'bearer-token', lead: new RegExp(secretRules.freeText.bearerLead, 'giu') },
  { kind: 'assigned-secret', lead: new RegExp(secretRules.freeText.assignedLead.replace('{keywords}', nameKeywords), 'giu') },
];

const placeholderPatterns = secretRules.placeholders.patterns.map(({ pattern, flags = '' }) => new RegExp(pattern, `${flags}u`));

/**
 * A value that is only a stand-in for a secret, judged on the whole value (trailing quotes
 * and closing punctuation removed). Anything more than the stand-in is still a secret.
 */
function isPlaceholder(value) {
  return placeholderPatterns.some(pattern => pattern.test(value)) || isAngleStandIn(value);
}

// Whole words that mark an angle-bracket stand-in, such as <your-key-here>.
const standInWords = new Set(secretRules.placeholders.standInWords);
const angleStandIn = new RegExp(secretRules.placeholders.angleStandIn, 'u');

/**
 * An angle-bracket stand-in names what goes there with a whole word, split by spaces,
 * underscores or hyphens: <your-key-here> is one, <monkey9> is not.
 */
function isAngleStandIn(value) {
  if (!angleStandIn.test(value)) return false;
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
function judgedEnd(text, start, end, quote, trimmed) {
  if (quote) {
    let close = start;
    while (close < end && text[close] !== quote) close += text[close] === '\\' ? 2 : 1;
    if (close >= end) return end;
    let after = close + 1;
    while (after < end && (text[after] === ' ' || text[after] === '\t')) after += 1;
    if (after < end && !',;)]}'.includes(text[after])) return end;
    return close;
  }
  return Math.max(start, trimmed);
}

function trimmedEnd(text, end) {
  let stop = end;
  while (stop > 0 && /[ \t,;]/u.test(text[stop - 1])) stop -= 1;
  return stop;
}

// Judging bound (rules: placeholders.maxJudged): a candidate's longer judged value is judged once its
// line's leads are known (lineTails); a longer value collected from a finding is kept, not judged.
const judgedMax = secretRules.placeholders.maxJudged;
const placeholderAt = (text, start, stop) => stop - start <= judgedMax && isPlaceholder(text.slice(start, stop));

/**
 * Card P4c: one span per free-text lead, from the value's start to the end of its line.
 * Every lead is read, in source order across all free-text rules, so every assignment on a
 * line has its own value (review W2-11 to W2-13). A candidate keeps offsets, never a copy:
 * valueEnd, where its judged value ends, and coreEnd, where its own assignment ends (the
 * next lead of any kind on the line, free-text or a structured value rule's, otherLeads,
 * for a value that is not a closed quote). The spans all end at the line end, so the merged
 * spans do not change.
 */
function lineTails(text, otherLeads = []) {
  const found = [];
  const leads = [...otherLeads];
  for (const rule of freeTextLeads) {
    const pattern = new RegExp(rule.lead.source, rule.lead.flags);
    // Leads come in order, so the line end found for one is reused for later leads on the
    // same line: rejected leads never rescan the line.
    let lineEnd = -1;
    let trimmed = -1;
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      let start = match.index + match[0].length;
      // An opening quote stays visible; the value starts after it. A quote just before
      // Bearer opens the value too, as in "Authorization": "Bearer ...".
      let quote = /["'`]/u.test(text[start] ?? '') ? text[start] : (rule.kind === 'bearer-token' ? (match[0].match(/(["'])[ \t]*Bearer/iu)?.[1] ?? '') : '');
      if (/["'`]/u.test(text[start] ?? '')) start += 1;
      if (start > lineEnd) {
        lineEnd = lineEndFrom(text, start);
        trimmed = trimmedEnd(text, lineEnd);
      }
      const end = lineEnd;
      leads.push(match.index);
      const valueEnd = judgedEnd(text, start, end, quote, trimmed);
      if (valueEnd <= start) continue;
      // A value up to maxJudged is judged now; a longer one once every lead is known, below,
      // so a line of many assignments is still read in linear time.
      const long = valueEnd - start > judgedMax;
      if (!long && isPlaceholder(text.slice(start, valueEnd))) continue;
      const closed = Boolean(quote) && valueEnd < end;
      const candidate = { kind: rule.kind, start, end, prefix: 0, valueEnd, closed, long };
      if (quote && !closed) {
        // The judged value runs to the line end ("x". is not a stand-in), but what the quotes
        // hold is a value of its own (review W2-14).
        let close = start;
        while (close < end && text[close] !== quote) close += text[close] === '\\' ? 2 : 1;
        if (close < end && close > start) candidate.quotedEnd = close;
      }
      found.push(candidate);
      // After a closed quote, the next lead is looked for after it; otherwise right after this lead.
      pattern.lastIndex = Math.max(pattern.lastIndex, closed ? valueEnd + 1 : start);
    }
  }
  leads.sort((a, b) => a - b);
  const kept = [];
  for (const candidate of found) {
    const stop = candidate.valueEnd;
    let low = 0;
    let high = leads.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (leads[middle] <= candidate.start) low = middle + 1;
      else high = middle;
    }
    const later = low < leads.length && leads[low] < stop ? leads[low] : null;
    // A long value is a stand-in as P4c judged it (review W2-17), judged once: a value that
    // holds another assignment never is one, so only the last on its line, or a quoted one,
    // is read by the stand-in rules.
    const long = candidate.long;
    delete candidate.long;
    if (long && later === null && isPlaceholder(text.slice(candidate.start, stop))) continue;
    candidate.coreEnd = later !== null && !candidate.closed ? later : stop;
    kept.push(candidate);
  }
  return kept;
}

/**
 * The values a merged span's candidates identified, each bounded: a free-text candidate's
 * own assignment, the first one's whole judged tail, and any other candidate's value or text.
 */
// Where a value's head ends in shell syntax (rules: freeText.valueHeadEnd): "x; export ..."
// and "x && ..." name the value x (review W2-19).
const headEnd = new RegExp(secretRules.freeText.valueHeadEnd, 'u');
// A short value is matched only as a whole token (rules: freeText.shortValue, in code points), so
// a head of any length is a value: "a&b" never makes every "a" inside a word a secret (review W2-22).
const shortValue = secretRules.freeText.shortValue;
// ASCII only, so no runtime's Unicode tables decide (review W2-23).
const isWord = character => /^[A-Za-z0-9_]$/u.test(character);

function spanValues(text, members) {
  const out = new Set();
  let tail = true;
  for (const candidate of members) {
    if (candidate.coreEnd !== undefined) {
      if (candidate.quotedEnd !== undefined) out.add(text.slice(candidate.start, candidate.quotedEnd));
      const core = text.slice(candidate.start, candidate.coreEnd).replace(/[ \t,;]+$/u, '');
      if (core && !placeholderAt(text, candidate.start, candidate.start + core.length)) {
        out.add(core);
        const cut = headEnd.exec(core);
        const head = cut ? core.slice(0, cut.index).replace(/[ \t,;]+$/u, '') : '';
        if (head && !isPlaceholder(head)) out.add(head);
      }
      if (tail) {
        out.add(text.slice(candidate.start, candidate.valueEnd));
        tail = false;
      }
    } else {
      out.add(candidate.value ?? text.slice(candidate.start, candidate.end));
    }
  }
  return [...out].filter(Boolean);
}

/** JSON Web Tokens: two base64url segments that start eyJ and a signature that may be empty (rules: jwt). */
const jwtRule = secretRules.jwt;

function jwts(text) {
  const found = [];
  const start = new RegExp(jwtRule.start, 'gu');
  for (let match = start.exec(text); match; match = start.exec(text)) {
    const headerEnd = runEnd(text, match.index, base64url);
    let end = headerEnd;
    if (text[end] === '.' && text.startsWith(jwtRule.segment, end + 1)) {
      const payloadEnd = runEnd(text, end + 1, base64url);
      if (payloadEnd - (end + 1) >= jwtRule.payloadMin && text[payloadEnd] === '.') {
        end = runEnd(text, payloadEnd + 1, base64url);
        found.push({ kind: 'jwt', start: match.index, end, prefix: jwtRule.prefix });
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
const keyRule = secretRules.privateKey;
const keyHeader = new RegExp(keyRule.header, 'u');
const keyBody = new RegExp(keyRule.body, 'u');

function privateKeys(text) {
  const found = [];
  const begin = new RegExp(keyRule.begin, 'gu');
  for (let match = begin.exec(text); match; match = begin.exec(text)) {
    const endLine = keyRule.end.replace('{label}', match[1]);
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
      if (keyHeader.test(line)) {
        blankAllowed = true;
      } else if (line === '' && blankAllowed) {
        blankAllowed = false;
      } else if (keyBody.test(line)) {
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
  const valueLeads = [];   // where each named assignment begins, to cut free-text values (review W2-18)
  valueRules.forEach((rule, index) => {
    const pattern = new RegExp(rule.lead.source, rule.lead.flags);
    let cached = null;
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      valueLeads.push(match.index);
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
        all.push({ kind: rule.kind, start, end, rank: 2 + simpleRules.length + index, prefix: 0, value });
        pattern.lastIndex = Math.max(pattern.lastIndex, end);
      }
      // A rejected value is not skipped: a real secret may sit inside it, after its own name.
    }
  });
  for (const candidate of lineTails(text, valueLeads)) all.push({ ...candidate, rank: 2 + simpleRules.length + valueRules.length });
  return all;
}

/**
 * Every span in text that looks like a credential, in text order. Overlapping candidates
 * merge into one span labelled with the most specific kind. Its prefix may be shown only
 * when that kind's match covers the whole span; otherwise the prefix would be part of an
 * enclosing value. With values: true each span also lists the values its candidates
 * identified (a free-text span runs to the end of its line, but its value is the judged
 * part), so a caller can find bare copies of them; runtime/latent_team/secret_scan.py does
 * the same.
 */
export function findSecrets(text, { values = false } = {}) {
  if (typeof text !== 'string' || !text) return [];
  const spans = [];
  for (const candidate of candidates(text).sort((a, b) => a.start - b.start || a.rank - b.rank)) {
    const last = spans.at(-1);
    if (last && candidate.start < last.end) {
      last.end = Math.max(last.end, candidate.end);
      last.members.push(candidate);
      if (candidate.rank < last.best.rank) last.best = candidate;
    } else {
      spans.push({ start: candidate.start, end: candidate.end, best: candidate, members: [candidate] });
    }
  }
  return spans.map(({ start, end, best, members }) => ({
    kind: best.kind,
    start,
    end,
    prefix: best.start === start && best.end === end ? best.prefix : 0,
    // Built only when asked for (review W2-13).
    ...(values ? { values: spanValues(text, members).sort() } : {}),
  }));
}

// Tab and the line breaks: read as a space in both canonical forms, never dropped. Every other
// control character, and every format character, is invisible. The same policy, by Unicode
// category and code point only, is in runtime/latent_team/gateway.py; rules/canonical-cases.json
// holds the cases both suites run.
const lineControls = new Set([9, 10, 11, 12, 13]);

/**
 * The character at i with an escape decoded, as a whole code point, and the index after it.
 * A high surrogate, escaped or not, joins the low surrogate right after it, escaped or not.
 */
function characterAt(text, i, decode = true) {
  const escape = decode ? escapeAt(text, i) : null;
  let character = escape ? escape.character : text[i];
  let next = i + (escape ? escape.length : 1);
  const high = character.charCodeAt(0);
  if (high >= 0xd800 && high <= 0xdbff && next < text.length) {
    const lowEscape = decode ? escapeAt(text, next) : null;
    const low = lowEscape ? lowEscape.character : text[next];
    const code = low.charCodeAt(0);
    if (code >= 0xdc00 && code <= 0xdfff) {
      character += low;
      next += lowEscape ? lowEscape.length : 1;
    }
  }
  return { character, next };
}

function blankOrInvisible(character) {
  if (/^[\p{Zl}\p{Zp}\p{Zs}]$/u.test(character) || lineControls.has(character.codePointAt(0))) return 'blank';
  if (/^[\p{Cc}\p{Cf}]$/u.test(character)) return 'invisible';
  return null;
}

/**
 * Text in a canonical form, with the original [start, end) of each canonical character and,
 * for each UTF-16 unit of the canonical text, the character it belongs to. The forms are how
 * a copy of a value can look between here and a reader: quoted-string escapes decoded, every
 * space or separator character, tab or line break and any run of them read as one space,
 * and each other control or format character read as a space too (drop false: what one-line
 * printing does) or as nothing (drop true: what a display shows). The same forms as canon
 * in runtime/latent_team/gateway.py, judged on whole code points. decode false reads a
 * value's own backslashes as written (for values that hold one).
 */
function canonical(text, drop, decode = true) {
  const chars = [];
  const spans = [];
  for (let i = 0; i < text.length;) {
    const start = i;
    const { character, next } = characterAt(text, i, decode);
    i = next;
    const kind = blankOrInvisible(character);
    if (kind === 'invisible' && drop) continue;
    if (kind && chars.at(-1) === ' ') {
      spans[spans.length - 1] = [spans[spans.length - 1][0], i];
      continue;
    }
    chars.push(kind ? ' ' : character);
    spans.push([start, i]);
  }
  let flat = '';
  const charOfUnit = [];
  chars.forEach((character, index) => {
    flat += character;
    for (let unit = 0; unit < character.length; unit += 1) charOfUnit.push(index);
  });
  return { flat, spans, charOfUnit };
}

/**
 * The original [start, end) ranges of text where either canonical form holds the same
 * form of one of values: an escaped, spaced or invisibly split copy of a value. Each value
 * is looked for with its escapes decoded and as written, so a value holding a backslash is
 * found in a JSON-quoted copy too; the text is read both ways as well.
 */
export function canonicalRanges(text, values) {
  const out = [];
  if (typeof text !== 'string' || !text) return out;
  for (const drop of [false, true]) {
    const targets = new Set(values.filter(value => typeof value === 'string')
      .flatMap(value => [canonical(value, drop).flat.trim(), canonical(value, drop, false).flat.trim()]).filter(Boolean));
    // The text is read with its escapes decoded and as written too, so a backslash split from
    // what follows it by an invisible character is not taken for an escape.
    for (const decode of [true, false]) {
      const { flat, spans, charOfUnit } = canonical(text, drop, decode);
      for (const target of targets) {
        const short = [...target].length < shortValue;
        for (let at = flat.indexOf(target); at !== -1; at = flat.indexOf(target, at + 1)) {
          if (short) {   // a short value only as a whole token
            const before = [...flat.slice(0, at)].at(-1);
            const after = [...flat.slice(at + target.length)][0];
            if ((before && isWord(before)) || (after && isWord(after))) continue;
          }
          out.push([spans[charOfUnit[at]][0], spans[charOfUnit[at + target.length - 1]][1]]);
        }
      }
    }
  }
  return out;
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

/**
 * A copy of the session with its source name and every message redacted, and the
 * findings. Each finding has a line (null for the source name), a kind, a length and a
 * masked preview, never a value.
 */
export function redactSession(session) {
  const findings = [];
  const record = (text, line) => {
    const found = findSecrets(text);
    for (const finding of found) {
      findings.push({ line, kind: finding.kind, length: finding.end - finding.start, preview: maskedPreview(text, finding) });
    }
    return found.length ? redactText(text, found) : text;
  };
  const source = typeof session.source === 'string' ? record(session.source, null) : session.source;
  const messages = session.messages.map(message => {
    const redacted = { ...message, text: record(message.text, message.line) };
    // Card I3: an agent turn's paths are printed in its heading, so they are checked too.
    if (message.role === 'agent') {
      for (const field of ['author', 'recipient']) {
        if (typeof message[field] === 'string') redacted[field] = record(message[field], message.line);
      }
    }
    return ['text', 'author', 'recipient'].every(field => redacted[field] === message[field]) ? message : redacted;
  });
  return { session: { ...session, source, messages }, findings };
}
