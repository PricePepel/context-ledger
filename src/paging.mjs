// Pure helpers that keep every MCP tool result under one bound and page the rest.
// Agents cap tool output (Codex cut long results without saying so in cycle 7), so a
// result either fits whole or says exactly how to get what it left out.

/** Text across all content items of one tool result, in UTF-16 code units, after escaping. */
export const maxResultCharacters = 40_000;

/**
 * The size of result text against maxResultCharacters. Clients cap tokens, not
 * characters, and cycle 7 measured English prose of 40,000 characters (about 4 per
 * token) reaching Codex whole. Token-dense text is weighted so that a page stays near
 * that token count: an ASCII letter or whitespace counts 1, any other ASCII character
 * (digits, punctuation, as in code, JSON, IDs and escapes) 2, and any other UTF-16 code
 * unit (Han script, for example, about one token per character) 4. Never less than the
 * length, so a page that fits is also at most 40,000 characters.
 */
export function resultSize(value) {
  let size = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0x80) size += 4;
    else if ((code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a) || code === 0x20 || code === 0x0a || code === 0x09) size += 1;
    else size += 2;
  }
  return size;
}

/** Largest x in [low, high] for which fits(x) holds, assuming fits is true then false. low - 1 if none. */
export function largest(low, high, fits) {
  let found = low - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (fits(middle)) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

/** The largest k from 1 to n with resultSize(render(k)) <= limit; at least 1, or 0 when n is 0. */
export function fitCount(render, n, limit) {
  if (n <= 0) return 0;
  if (resultSize(render(n)) <= limit) return n;
  return Math.max(1, largest(1, n - 1, k => resultSize(render(k)) <= limit));
}

const isHigh = code => code >= 0xd800 && code <= 0xdbff;
const isLow = code => code >= 0xdc00 && code <= 0xdfff;

/** Move an end index back so it never splits a surrogate pair or a CRLF. */
export function snapEnd(raw, end, start = 0) {
  if (end <= start || end >= raw.length) return Math.min(Math.max(end, start), raw.length);
  if (isLow(raw.charCodeAt(end)) && isHigh(raw.charCodeAt(end - 1))) end -= 1;
  if (end > start && raw[end] === '\n' && raw[end - 1] === '\r') end -= 1;
  return end;
}

/** The end of the first code point at start (a CRLF counts as one). */
function firstEnd(raw, start) {
  if (start >= raw.length) return start;
  if (raw[start] === '\r' && raw[start + 1] === '\n') return start + 2;
  return isHigh(raw.charCodeAt(start)) && isLow(raw.charCodeAt(start + 1)) ? start + 2 : start + 1;
}

/**
 * The largest end index for which render(end) fits the limit. render(end) renders the
 * part raw.slice(start, end) with whatever surrounds it, as a string or its resultSize. The
 * cut falls on a code-point boundary, never inside a CRLF, preferably just after a
 * newline in the last tenth of the part, and always takes at least one code point.
 * maxEnd bounds the search (escaping never shrinks text below half its raw length).
 */
export function cutText(raw, start, limit, render, maxEnd = raw.length) {
  const minimum = firstEnd(raw, start);
  const size = end => {
    const rendered = render(end);
    return typeof rendered === 'number' ? rendered : resultSize(rendered);
  };
  const found = largest(minimum, Math.min(maxEnd, raw.length), end => {
    const snapped = snapEnd(raw, end, start);
    return snapped >= minimum && size(snapped) <= limit;
  });
  let end = found < minimum ? minimum : snapEnd(raw, found, start);
  if (end < raw.length) {
    const newline = raw.lastIndexOf('\n', end - 1);
    if (newline >= start && newline + 1 < end && newline + 1 >= start + 0.9 * (end - start)) end = newline + 1;
  }
  return end;
}

const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);

function parentOf(root, path) {
  let value = root;
  for (const key of path.slice(0, -1)) {
    if (!isObject(value) && !Array.isArray(value)) return undefined;
    value = value[key];
  }
  return isObject(value) ? value : undefined;
}

/** "packet.nodes" or "parties[0].nodes" for a path of keys. */
export const pathName = path => path.reduce((name, key) => (typeof key === 'number'
  ? `${name}[${key}]` : name ? `${name}.${key}` : key), '');

/**
 * Page a JSON object by whole items of a fixed list of array sections.
 *
 * Items are numbered from 1 across the sections in order. Every field outside the
 * sections stays in a head that every page repeats; an array with no items on a page is
 * left out. sections maps each section that exists to its item range, or null when empty.
 * Returns { result } with the page object, or { tooLarge: true } when even one item
 * with the head exceeds the limit.
 *
 * - rootKey, root: the result is { more?, page, [rootKey]: head plus slices }.
 * - paths: arrays of keys from root to each section, in order. Missing ones are skipped.
 * - render: the function that turns the page object into the result text.
 * - note(nextItem, totalItems): the continuation note for a partial page.
 * - pastEnd(fromItem, totalItems): the note for a page past the last item.
 */
export function pageSections({ rootKey, root, paths, fromItem, limit, render, note, pastEnd }) {
  const sections = [];
  let total = 0;
  for (const path of paths) {
    const parent = parentOf(root, path);
    const items = parent?.[path.at(-1)];
    if (!Array.isArray(items)) continue;
    sections.push({ path, name: pathName(path), items, first: total + 1 });
    total += items.length;
  }
  // The head keeps every key in its place: section arrays become placeholders that a
  // page fills with its slice or removes. Empty sections stay as [] in the head.
  const template = structuredClone(root);
  for (const section of sections) if (section.items.length) parentOf(template, section.path)[section.path.at(-1)] = null;
  const ranges = Object.fromEntries(sections.map(section => [section.name,
    section.items.length ? [section.first, section.first + section.items.length - 1] : null]));

  const build = count => {
    const head = structuredClone(template);
    const last = fromItem + count - 1;
    for (const section of sections) {
      if (!section.items.length) continue;
      const parent = parentOf(head, section.path);
      const key = section.path.at(-1);
      const from = Math.max(fromItem, section.first) - section.first;
      const to = Math.min(last, section.first + section.items.length - 1) - section.first + 1;
      if (to > from) parent[key] = section.items.slice(from, to);
      else delete parent[key];
    }
    const page = { fromItem, toItem: last, totalItems: total, sections: ranges };
    const result = {};
    if (count > 0 && last < total) result.more = { fromItem: last + 1, note: note(last + 1, total) };
    if (fromItem > total) page.note = pastEnd(fromItem, total);
    result.page = page;
    result[rootKey] = head;
    return result;
  };

  if (fromItem > total) {
    const result = build(0);
    return resultSize(render(result)) <= limit ? { result } : { tooLarge: true };
  }
  const available = total - fromItem + 1;
  const count = fitCount(k => render(build(k)), available, limit);
  const result = build(count);
  return resultSize(render(result)) <= limit ? { result } : { tooLarge: true };
}
