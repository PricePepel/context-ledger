// Card H9: the AGENTS.md section 6 rules that reviews kept finding, checked on every
// tracked file at once. Each finding says what to write instead.
//   node scripts/check.mjs [folder]
// Node built-ins and `git ls-files` only; not part of the package.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { terminalLabel } from '../src/text.mjs';

const binaryExtensions = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.otf',
  '.mp4', '.webm', '.pdf', '.zip', '.gz', '.sqlite', '.pt',
]);
const codeFile = /\.(?:m?js|cjs|html)$/u;
// Test folders, and test files kept beside the code they test.
const testFile = /(?:^|\/)(?:tests?|__tests__)\/|\.(?:test|spec)\.[cm]?js$/u;
const vendored = /(?:^|\/)node_modules\//u;
// This file spells out the patterns it looks for, so the code rules skip it.
const selfPath = 'scripts/check.mjs';
const rawCharacter = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const allowedRaw = new Set(['\t', '\n', '\r']);

// A property by dot or by a quoted computed key: `.name` or `['name']`.
const property = name => String.raw`(?:\.\s*${name}\b|\[\s*(['"\x60])${name}\1\s*\])`;
const assignment = String.raw`\s*(?:\+|\?\?|\|\||&&)?=(?!=)`;
const htmlSinks = [
  [new RegExp(String.raw`(?:\.\s*(?:innerHTML|outerHTML)\b|\[\s*(['"\x60])(?:innerHTML|outerHTML)\1\s*\])${assignment}`, 'gu'), 'assigning HTML'],
  [/\binsertAdjacentHTML\b/gu, 'insertAdjacentHTML'],
  [new RegExp(String.raw`\bdocument\s*${property('write(?:ln)?')}`, 'gu'), 'document.write'],
  [/\bcreateContextualFragment\b/gu, 'createContextualFragment'],
  [/\bparseFromString\b/gu, 'DOMParser.parseFromString'],
  [/\bsrcdoc\b/giu, 'srcdoc'],
];
const listenCall = new RegExp(String.raw`${property('listen')}\s*\(`, 'gu');

const codePoint = character => 'U+' + character.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');

// Line starts after LF, CRLF and a lone CR, which JavaScript also ends a line on.
function lineStarts(text) {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n' || (text[index] === '\r' && text[index + 1] !== '\n')) starts.push(index + 1);
  }
  return starts;
}

function position(starts, index) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle] <= index) low = middle;
    else high = middle - 1;
  }
  return { line: low + 1, column: index - starts[low] + 1 };
}

// Comments (and regular expression bodies) turned into spaces, same length and lines,
// so a rule neither fires on a comment nor misses a call with a comment inside it.
// Strings are kept: a sink spelt inside a string is still reported.
function maskComments(text, html) {
  const out = text.split('');
  const blank = (from, to) => {
    for (let index = from; index < to; index += 1) if (out[index] !== '\n' && out[index] !== '\r') out[index] = ' ';
  };
  if (html) {
    for (const match of text.matchAll(/<!--[\s\S]*?(?:-->|$)/gu)) blank(match.index, match.index + match[0].length);
    return out.join('');
  }
  let quote = null;
  let last = '';
  for (let index = 0; index < text.length;) {
    const character = text[index];
    const next = text[index + 1];
    if (quote) {
      if (character === '\\') index += 2;
      else {
        if (character === quote) quote = null;
        index += 1;
      }
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      last = character;
      index += 1;
    } else if (character === '/' && next === '/') {
      let end = index;
      while (end < text.length && text[end] !== '\n' && text[end] !== '\r') end += 1;
      blank(index, end);
      index = end;
    } else if (character === '/' && next === '*') {
      const close = text.indexOf('*/', index + 2);
      const end = close === -1 ? text.length : close + 2;
      blank(index, end);
      index = end;
    } else if (character === '/' && (last === '' || /[(,=:[!&|?{};+\-*%<>~^]/u.test(last))) {
      let end = index + 1;
      let inClass = false;
      while (end < text.length && text[end] !== '\n') {
        const inner = text[end];
        if (inner === '\\') end += 1;
        else if (inner === '[') inClass = true;
        else if (inner === ']') inClass = false;
        else if (inner === '/' && !inClass) break;
        end += 1;
      }
      blank(index + 1, end);
      last = '/';
      index = end + 1;
    } else {
      if (!/\s/u.test(character)) last = character;
      index += 1;
    }
  }
  return out.join('');
}

// The argument text of a call whose "(" is at `open`, up to its matching ")".
function callArguments(text, open) {
  let depth = 0;
  let quote = null;
  for (let index = open; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === '\\') index += 1;
      else if (character === quote) quote = null;
    } else if (character === '"' || character === "'" || character === '`') quote = character;
    else if (character === '(' || character === '[' || character === '{') depth += 1;
    else if (character === ')' || character === ']' || character === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, index);
    }
  }
  return text.slice(open + 1);
}

function topLevelParts(text) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === '\\') index += 1;
      else if (character === quote) quote = null;
    } else if (character === '"' || character === "'" || character === '`') quote = character;
    else if (character === '(' || character === '[' || character === '{') depth += 1;
    else if (character === ')' || character === ']' || character === '}') depth -= 1;
    else if (character === ',' && depth === 0) {
      parts.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts.filter(part => part !== '');
}

const loopbackLiteral = /^(['"`])127\.0\.0\.1\1$/u;

// An options object listens on loopback when its last top-level host is the literal,
// with no spread after it that could replace it.
function optionsOnLoopback(text) {
  if (!text.startsWith('{') || !text.endsWith('}')) return false;
  let host = null;
  for (const part of topLevelParts(text.slice(1, -1))) {
    if (part.startsWith('...')) host = null;
    const match = /^(?:host|(['"`])host\1)\s*:\s*([\s\S]*)$/u.exec(part);
    if (match) host = match[2].trim();
    else if (part === 'host') host = null;
  }
  return host !== null && loopbackLiteral.test(host);
}

function listensOnLoopback(args) {
  const parts = topLevelParts(args);
  if (parts.length >= 2 && loopbackLiteral.test(parts[1])) return true;
  return optionsOnLoopback(parts[0] ?? '');
}

// Findings for one file, given its path relative to the repository (with "/") and bytes.
export function checkFile(path, bytes) {
  if (binaryExtensions.has(extname(path).toLowerCase())) return [];
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return [{ path, line: 1, column: 1, rule: 'utf8', message: 'not UTF-8; save it as UTF-8, or add its extension to binaryExtensions in scripts/check.mjs if it is binary' }];
  }
  const starts = lineStarts(text);
  const findings = [];
  const add = (index, rule, message) => findings.push({ path, ...position(starts, index), rule, message });

  for (const match of text.matchAll(rawCharacter)) {
    if (allowedRaw.has(match[0])) continue;
    add(match.index, 'raw-character', `raw ${codePoint(match[0])}; write it as an escape (\\u{...} in JavaScript, \\u.... in Python, the escape as text in Markdown) or String.fromCodePoint (AGENTS.md section 6)`);
  }

  if (codeFile.test(path) && !testFile.test(path) && !vendored.test(path) && path !== selfPath) {
    const html = path.endsWith('.html');
    const code = maskComments(text, html);
    for (const [pattern, name] of htmlSinks) {
      for (const match of code.matchAll(pattern)) {
        add(match.index, 'html-sink', `${name} parses text as HTML; build nodes with createElement and set textContent instead (AGENTS.md section 6)`);
      }
    }
    if (!html) {
      for (const match of code.matchAll(listenCall)) {
        const args = callArguments(code, match.index + match[0].length - 1);
        if (!listensOnLoopback(args)) {
          add(match.index, 'loopback-only', "listen without host '127.0.0.1'; pass it as the second argument or as host in the options (AGENTS.md section 6: loopback only)");
        }
      }
    }
  }
  return findings;
}

// Tracked files as raw byte paths, without submodules (a folder) or symbolic links.
export function trackedFiles(root) {
  const output = execFileSync('git', ['ls-files', '-z', '--stage'], { cwd: root, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
  const files = [];
  let start = 0;
  for (let end = output.indexOf(0); end !== -1; start = end + 1, end = output.indexOf(0, start)) {
    const entry = output.subarray(start, end);
    const tab = entry.indexOf(9);
    const mode = entry.subarray(0, 6).toString('latin1');
    if (tab === -1 || mode === '160000' || mode === '120000') continue;
    files.push(entry.subarray(tab + 1));
  }
  return [...new Map(files.map(path => [path.toString('latin1'), path])).values()];
}

export function checkTree(root) {
  const files = trackedFiles(root);
  const findings = [];
  for (const raw of files) {
    const path = new TextDecoder('utf-8').decode(raw);
    if (!Buffer.from(path, 'utf8').equals(raw)) {
      findings.push({ path, line: 1, column: 1, rule: 'utf8', message: 'file name is not UTF-8; rename it' });
    }
    let bytes;
    try {
      bytes = readFileSync(Buffer.concat([Buffer.from(root + '/', 'utf8'), raw]));
    } catch (error) {
      if (error.code === 'ENOENT') continue; // deleted in the working tree, not yet staged
      throw error;
    }
    findings.push(...checkFile(path, bytes));
  }
  return { files: files.length, findings };
}

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

export function formatFinding({ path, line, column, rule, message }) {
  return `${terminalLabel(path)}:${line}:${column}  ${rule}  ${message}`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[2] ?? join(fileURLToPath(new URL('.', import.meta.url)), '..'));
  const { files, findings } = checkTree(root);
  for (const finding of findings) console.log(formatFinding(finding));
  if (findings.length > 0) {
    console.log(`check: ${plural(files, 'file')}, ${plural(findings.length, 'finding')}`);
    process.exitCode = 1;
  } else {
    console.log(`check: ${plural(files, 'file')}, no findings`);
  }
}
