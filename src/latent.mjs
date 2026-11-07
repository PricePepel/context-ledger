// Leo side of M2a: the ledger's proxy to Ali's warm latent pool (docs/latent-read.md).
// The ledger never trusts a slice as returned. Every finding must cite real lines of a
// file that was actually requested, or it is dropped before any agent sees it.
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { InputError } from './errors.mjs';

const maxPaths = 32;
const maxTextBytes = 512 * 1024;
const maxFindings = 12;
const maxSpans = 4;
const defaultTimeoutMs = 180_000;

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
    // Relative POSIX paths only: no absolute, drive, backslash, empty or dot segments.
    if (typeof path !== 'string' || !path || path.length > 512 || path.startsWith('/') || path.includes('\\')
      || /^[a-z]:/iu.test(path) || /[\p{C}]/u.test(path) || path.split('/').some(part => part === '' || part === '.' || part === '..')) {
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
    const buffer = await readFile(real);
    bytes += buffer.length;
    if (bytes > maxTextBytes) throw new LatentError(413, 'Latent read is limited to 512 KiB of file text.');
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

// One visible line: drop findings whose label could fake structure for the reader.
const goodLabel = label => typeof label === 'string' && label.length <= 500 && /[^\s\p{C}]/u.test(label)
  && !/[\p{Cc}\p{Zl}\p{Zp}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(label);

/** Keep only findings whose every span cites real lines of a requested file. */
export function validateSlice(slice, files, question) {
  if (typeof slice !== 'object' || slice === null || slice.kind !== 'latent-slice' || slice.version !== 1
    || typeof slice.answer !== 'string' || !Array.isArray(slice.findings)) {
    throw new LatentError(502, 'The latent runtime returned a malformed slice.');
  }
  const lineCounts = new Map(files.map(file => [file.path, file.lines.length]));
  const findings = [];
  let rejectedFindings = 0;
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
    findings.push({
      id: `f${findings.length + 1}`,
      label: finding.label,
      evidence: evidence.map(({ path, startLine, endLine }) => ({ path, startLine, endLine })),
    });
  }
  rejectedFindings += Math.max(0, slice.findings.length - maxFindings);
  return {
    version: 1,
    kind: 'latent-slice',
    question,
    answer: slice.answer.slice(0, 4000),
    findings,
    validated: true,
    rejectedFindings,
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
  const body = await response.json().catch(() => null);
  if (response.status === 503) return fallback(files, 'The latent model is not ready.');
  if (!response.ok) {
    const message = typeof body?.error === 'string' && body.error.length <= 200 && !/[\p{C}\p{Zl}\p{Zp}]/u.test(body.error)
      ? body.error : `The latent runtime returned HTTP ${response.status}.`;
    throw new LatentError(response.status === 400 || response.status === 413 ? response.status : 502, message);
  }
  return {
    mode: 'latent',
    graph: validateSlice(body?.graph, files, request.question),
    receipt: body?.receipt ?? null,
    stats: body?.stats ?? null,
  };
}

function fallback(files, reason) {
  return { mode: 'text', reason, files: files.map(file => ({ path: file.path, text: numbered(file) })) };
}
