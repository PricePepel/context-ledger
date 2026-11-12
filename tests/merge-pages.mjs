import assert from 'node:assert/strict';

// Put paged JSON results back together, as a client following more would.
export function mergePages(rootKey, pages) {
  const [first] = pages;
  const merged = structuredClone(first[rootKey]);
  const ranges = first.page.sections;
  // Rebuild each section in order from the pages' slices.
  for (const name of Object.keys(ranges)) {
    if (ranges[name] === null) continue;
    const items = [];
    for (const page of pages) {
      const value = readPath(page[rootKey], name);
      if (Array.isArray(value)) items.push(...value);
    }
    writePath(merged, name, items);
  }
  return merged;
}

const parseName = name => [...name.matchAll(/([^.[\]]+)|\[(\d+)\]/g)].map(match => (match[2] === undefined ? match[1] : Number(match[2])));

function readPath(root, name) {
  let value = root;
  for (const key of parseName(name)) value = value?.[key];
  return value;
}

function writePath(root, name, items) {
  const path = parseName(name);
  let value = root;
  for (const key of path.slice(0, -1)) value = value[key];
  value[path.at(-1)] = items;
}

export const resultSize = result => result.content.reduce((sum, item) => sum + item.text.length, 0);

/**
 * Follow more.fromItem from a first call until the last page. Checks the bound, that
 * more is the first key of every partial page, and that pages cover items in order.
 */
export async function walkJson(client, firstId, name, args, { first } = {}) {
  const pages = [];
  let id = firstId;
  let result = first ?? await client.call(id++, name, args);
  for (;;) {
    assert.equal(result.isError, undefined, result.content[0].text);
    assert.ok(resultSize(result) <= 40_000, `${name} page of ${resultSize(result)} characters`);
    const parsed = JSON.parse(result.content[0].text);
    pages.push(parsed);
    if (!parsed.more) break;
    assert.equal(Object.keys(parsed)[0], 'more');
    assert.equal(parsed.more.fromItem, parsed.page.toItem + 1);
    assert.ok(parsed.page.toItem >= parsed.page.fromItem, 'a page holds at least one item');
    assert.ok(pages.length < 500, 'paging ends');
    result = await client.call(id++, name, { ...args, fromItem: parsed.more.fromItem });
  }
  return { pages, id };
}
