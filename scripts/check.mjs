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

// Space, block comments and line comments, which may sit between any two tokens (Codex
// rounds 3 and 4).
const gap = String.raw`(?:\s|/\*[\s\S]*?\*/|//[^\n\r]*)*`;
// A property by dot or by a quoted computed key, optional chaining included: `.name`,
// `?.name`, `['name']` or `?.['name']` (Codex round 5).
const property = name => String.raw`(?:\??\.${gap}${name}\b|(?:\?\.)?${gap}\[${gap}(['"\x60])${name}\1${gap}\])`;
const assignment = String.raw`${gap}(?:\+|\?\?|\|\||&&)?=(?!=)`;
const htmlProperty = String.raw`(?:innerHTML|outerHTML)`;
const htmlSinks = [
  [new RegExp(String.raw`(?:\.${gap}${htmlProperty}\b|\[${gap}(['"\x60])${htmlProperty}\1${gap}\])${assignment}`, 'gu'), 'assigning HTML'],
  // A key in an object literal, as in Object.assign(node, { innerHTML }), and a
  // destructuring target, as in ({ html: node.innerHTML } = data). A plain read inside an
  // object literal is reported too; write it on a line of its own.
  [new RegExp(String.raw`[{,]${gap}(?:${htmlProperty}|(['"\x60])${htmlProperty}\1|\[${gap}(['"\x60])${htmlProperty}\2${gap}\])${gap}[:,}]`, 'gu'), 'an HTML property key'],
  [new RegExp(String.raw`(?:\.${gap}${htmlProperty}|\[${gap}(['"\x60])${htmlProperty}\1${gap}\])${gap}[,}\]]`, 'gu'), 'an HTML property in a pattern'],
  // The target of for...of or for...in is assigned on every pass (Codex round 5).
  [new RegExp(String.raw`(?:\.${gap}${htmlProperty}|\[${gap}(['"\x60])${htmlProperty}\1${gap}\])${gap}(?:of|in)\b`, 'gu'), 'an HTML property as a loop target'],
  [/\binsertAdjacentHTML\b/gu, 'insertAdjacentHTML'],
  // `document`, `doc`, `contentDocument`, `frameDoc`: any name with "doc" in it (round 6).
  [new RegExp(String.raw`\b[\w$]*[Dd]oc[\w$]*${gap}${property('write(?:ln)?')}`, 'gu'), 'document.write'],
  [/\bcreateContextualFragment\b/gu, 'createContextualFragment'],
  [/\bparseFromString\b/gu, 'DOMParser.parseFromString'],
  [/\b(?:setHTMLUnsafe|setHTML|parseHTMLUnsafe)\b/gu, 'setHTMLUnsafe'],
  [/\bsrcdoc\b/giu, 'srcdoc'],
];
// Browser code has no streams, so there any write() call is document.write under some
// name (Codex round 7: `const preview = iframe.contentDocument; preview.write(...)`).
const browserWrite = [new RegExp(String.raw`${property('write(?:ln)?')}${gap}(?:\?\.)?${gap}\(`, 'gu'), 'write() in browser code'];
// The browser app, and any HTML page with an inline script (Codex round 8).
const browserFile = /^public\/|\.html$/u;

// Card H10: a label's .length counts UTF-16 units; JSON Schema maxLength and the graph
// schemas count code points. The length of a name that ends in "label" (or "labelText"),
// or of a ['label'] key, with any member chain before it (`node.label`), next to any
// comparison is a finding, however the other side is written. Parentheses around the
// length do not hide it. Only the exact emptiness tests pass, where both counts agree,
// and only when the 0 or 1 stands alone (not `< 1 + MAX`): length < 1, length > 0,
// length >= 1, and 1 > length, 0 < length, 1 <= length. Plural names (labels,
// labelParts) are lists and are left out.
const labelLength = new RegExp(String.raw`(?:\b(?:[\w$]+(?:\([^()\n]*\)|\[[^\]\n]*\])*\??\.)*[\w$]*[Ll]abel(?:Text)?\b|(?:[\w$]|\??\.|\[[^\]\n]*\])*?\[\s*(['"\x60])label\1\s*\])\s*\??\.length\b`, 'gu');
const comparisonAfter = /^\s*\)*\s*([<>]=?)(?!=)\s*\(*\s*([\w$.]*)\s*(\S?)/u;
// Not the ">" of an arrow function (`label => label.length`).
const comparisonBefore = /(\S?)\s*([\w$.]*)\s*(?<!=)([<>]=?)\s*\(*\s*$/u;
const emptyAfter = new Set(['<1', '>0', '>=1']);
const emptyBefore = new Set(['1>', '0<', '1<=']);
// What may follow or precede a lone 0 or 1 for it to be the whole other side.
const aloneAfter = new Set(['', ')', ';', '&', '|', '?', ',', '}', ':']);
const aloneBefore = new Set(['', '(', ';', '&', '|', '?', ',', '{', '!', ':', '=']);
// Comments and an optional call (`?.`) may sit between the name and its arguments.
const listenCall = new RegExp(String.raw`${property('listen')}${gap}(?:\?\.)?${gap}\(`, 'gu');

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

// Comments removed from a call's argument text (strings kept), for the loopback rule only.
// The code rules otherwise read the text as it is: a rule spelt in a comment or a string
// is reported too, which is safer than a lexer that a regex or template could fool (H9,
// Codex round 2).
// A "/" where a value may start begins a regular expression, which is kept whole, so a
// "//" inside it is not taken for a comment (Codex round 3). Misreading a division as a
// regular expression only keeps more text, never less.
function stripComments(text) {
  let out = '';
  let quote = null;
  let last = '';
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (!quote && !/\s/u.test(character) && !(character === '/' && (text[index + 1] === '/' || text[index + 1] === '*'))) {
      if (character === '/' && (last === '' || /[(,=:[!&|?{};+\-*%<>~^]/u.test(last))) {
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
        out += text.slice(index, end + 1);
        index = end;
        last = '/';
        continue;
      }
      last = character;
    }
    if (quote) {
      out += character;
      if (character === '\\') {
        out += text[index + 1] ?? '';
        index += 1;
      } else if (character === quote) quote = null;
    } else if (character === '"' || character === "'" || character === '`') {
      quote = character;
      out += character;
    } else if (character === '/' && text[index + 1] === '*') {
      const close = text.indexOf('*/', index + 2);
      index = close === -1 ? text.length : close + 1;
      out += ' ';
    } else if (character === '/' && text[index + 1] === '/') {
      while (index + 1 < text.length && !/[\n\r]/u.test(text[index + 1])) index += 1;
      out += ' ';
    } else out += character;
  }
  return out;
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

// Keys of net.Server listen options that do not change where it binds. Any other key
// (fd, path, handle, a spread, a computed key, an accessor) may bind elsewhere and makes
// the call count as not loopback (Codex round 6: an inherited fd wins over host).
const harmlessOption = new Set(['port', 'backlog', 'exclusive', 'ipv6Only', 'reusePort', 'readableAll', 'writableAll', 'signal']);

// An options object listens on loopback when its last host key is the literal and every
// other key is one of the harmless ones.
function optionsOnLoopback(text) {
  if (!text.startsWith('{') || !text.endsWith('}')) return false;
  let host = null;
  let unknown = false;
  for (const part of topLevelParts(text.slice(1, -1))) {
    const match = /^(?:host|(['"`])host\1|\[\s*(['"`])host\2\s*\])\s*:\s*([\s\S]*)$/u.exec(part);
    if (match) {
      host = match[3].trim();
      continue;
    }
    const key = /^(?:([$\w]+)|(['"`])([^'"`]*)\2)\s*:/u.exec(part) ?? /^([$\w]+)$/u.exec(part);
    const name = key ? (key[1] ?? key[3]) : null;
    if (!harmlessOption.has(name)) unknown = true;
  }
  return !unknown && host !== null && loopbackLiteral.test(host);
}

// Node reads an options object first, so then only its host counts. The (port, host) form
// counts only with a literal port number: any variable may hold an options object, and
// Node would then ignore the host (Codex rounds 3 to 5). With a port in a variable, write
// listen({ port, host: '127.0.0.1' }).
const portArgument = /^\d+$/u;

function listensOnLoopback(args) {
  const parts = topLevelParts(stripComments(args));
  if ((parts[0] ?? '').startsWith('{')) return optionsOnLoopback(parts[0]);
  return parts.length >= 2 && portArgument.test(parts[0]) && loopbackLiteral.test(parts[1]);
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
    const code = text;
    // In browser code the broader write() rule replaces the document-name one.
    const sinks = browserFile.test(path) ? [...htmlSinks.filter(([, name]) => name !== 'document.write'), browserWrite] : htmlSinks;
    for (const [pattern, name] of sinks) {
      for (const match of code.matchAll(pattern)) {
        add(match.index, 'html-sink', `${name} parses text as HTML; build nodes with createElement and set textContent instead; in a comment or string, reword it (AGENTS.md section 6)`);
      }
    }
    for (const match of code.matchAll(labelLength)) {
      const after = comparisonAfter.exec(code.slice(match.index + match[0].length, match.index + match[0].length + 80));
      const before = comparisonBefore.exec(code.slice(Math.max(0, match.index - 80), match.index));
      if (!after && !before) continue;
      if (after && !before && emptyAfter.has(after[1] + after[2]) && aloneAfter.has(after[3])) continue;
      if (before && !after && emptyBefore.has(before[2] + before[3]) && aloneBefore.has(before[1])) continue;
      add(match.index, 'label-length', 'a label length counted in UTF-16 units; count code points with [...label].length, as JSON Schema maxLength and the graph schemas do (card H10)');
    }
    if (!html) {
      for (const match of code.matchAll(listenCall)) {
        const args = callArguments(code, match.index + match[0].length - 1);
        if (!listensOnLoopback(args)) {
          add(match.index, 'loopback-only', "listen without host '127.0.0.1'; write listen({ port, host: '127.0.0.1' }) with the object written out, or listen(0, '127.0.0.1') with a literal port (AGENTS.md section 6: loopback only)");
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
    const path = new TextDecoder('utf-8', { ignoreBOM: true }).decode(raw);
    if (!Buffer.from(path, 'utf8').equals(raw)) {
      findings.push({ path, line: 1, column: 1, rule: 'utf8', message: 'file name is not UTF-8; rename it' });
    }
    for (const match of path.matchAll(rawCharacter)) {
      findings.push({ path, line: 1, column: 1, rule: 'raw-character', message: `file name holds raw ${codePoint(match[0])}; rename it` });
    }
    let bytes;
    try {
      bytes = readFileSync(Buffer.concat([Buffer.from(root + '/', 'utf8'), raw]));
    } catch (error) {
      // Deleted, or replaced by a folder, in the working tree and not yet staged.
      // ENOTDIR: a parent folder was replaced by a file (Codex round 8).
      if (error.code === 'ENOENT' || error.code === 'EISDIR' || error.code === 'ENOTDIR') continue;
      throw error;
    }
    for (const finding of checkFile(path, bytes)) findings.push(finding);
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
