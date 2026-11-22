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
export const scannerName = 'context-ledger-secrets/1';

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
      found.push({ kind: rule.kind, start, end, prefix: 0 });
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
// A finding's first words are searched for as one value, up to this many words.
const maxPrefixWords = 8;
const trailingPunctuation = /[,.;:!?)\]}>"'`]+$/u;
const leadingQuotes = /^["'`]+/u;

/**
 * The values a finding stands for, to search for elsewhere. A finding can be one key, a
 * line tail after a name (password=...) or several candidates merged into one span, so it
 * stands for its whole span; its first word, its first two words and so on, as written
 * (a passphrase is matched whole); every word that mixes letters and digits, as a key
 * does; and the quoted part when the span opens a quote. Each value is also searched for
 * with its escapes decoded.
 */
function copyValues(text, finding) {
  const span = text.slice(finding.start, finding.end);
  const values = [span, span.trim().replace(trailingPunctuation, '')];
  // Word ends in the span itself, so a prefix keeps the spaces it was written with.
  const ends = [...span.matchAll(/\S+/gu)].map(match => match.index + match[0].length);
  for (const end of ends.slice(0, maxPrefixWords)) values.push(span.slice(0, end).trim().replace(trailingPunctuation, ''));
  for (const word of span.split(/\s+/u)) {
    const bare = word.replace(leadingQuotes, '').replace(trailingPunctuation, '');
    if (mixed(bare)) values.push(bare);
  }
  const quote = finding.start > 0 ? text[finding.start - 1] : '';
  if (/["'`]/u.test(quote)) {
    const close = quotedEnd(text, finding.start, quote);
    if (close < finding.end) values.push(text.slice(finding.start, close));
  }
  return [...values, ...values.map(decoded)];
}

/**
 * A matcher for many values at once (Aho-Corasick over UTF-16 code units): one pass over a
 * text finds, at every position, the longest value that ends there, so the time grows
 * with the text and the values' total length, not with their product.
 */
function copyMatcher(values) {
  const nodes = [{ next: new Map(), fail: 0, length: 0, kind: '' }];
  for (const [value, kind] of values) {
    let node = 0;
    for (let at = 0; at < value.length; at += 1) {
      const unit = value.charCodeAt(at);
      let child = nodes[node].next.get(unit);
      if (child === undefined) {
        child = nodes.push({ next: new Map(), fail: 0, length: 0, kind: '' }) - 1;
        nodes[node].next.set(unit, child);
      }
      node = child;
    }
    if (value.length > nodes[node].length) Object.assign(nodes[node], { length: value.length, kind });
  }
  // Breadth first: a node's failure link is the longest proper suffix that is a node, and
  // it inherits that suffix's longest value when it has none of its own.
  const queue = [...nodes[0].next.values()];
  for (let head = 0; head < queue.length; head += 1) {
    const node = queue[head];
    for (const [unit, child] of nodes[node].next) {
      let fail = nodes[node].fail;
      while (fail !== 0 && !nodes[fail].next.has(unit)) fail = nodes[fail].fail;
      const target = nodes[fail].next.get(unit);
      nodes[child].fail = target !== undefined && target !== child ? target : 0;
      if (nodes[child].length === 0) Object.assign(nodes[child], { length: nodes[nodes[child].fail].length, kind: nodes[nodes[child].fail].kind });
      queue.push(child);
    }
  }
  return text => {
    const spans = [];
    let node = 0;
    for (let at = 0; at < text.length; at += 1) {
      const unit = text.charCodeAt(at);
      while (node !== 0 && !nodes[node].next.has(unit)) node = nodes[node].fail;
      node = nodes[node].next.get(unit) ?? 0;
      const { length, kind } = nodes[node];
      if (!length) continue;
      // Ends only grow, so a new match merges with the spans it overlaps at the end.
      let start = at + 1 - length;
      let spanKind = kind;
      while (spans.length && spans.at(-1).end > start) {
        const last = spans.pop();
        if (last.start <= start) { start = last.start; spanKind = last.kind; }
      }
      spans.push({ kind: spanKind, start, end: at + 1, prefix: 0 });
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
  const found = fields.map(field => findSecrets(field.text));
  const values = new Map();
  fields.forEach((field, index) => {
    for (const finding of found[index]) {
      for (const value of copyValues(field.text, finding)) {
        if (value.length >= minCopyLength && !values.has(value)) values.set(value, finding.kind);
      }
    }
  });
  const copiesIn = values.size ? copyMatcher(values) : () => [];
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
