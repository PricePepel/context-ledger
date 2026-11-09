// Import a Claude Code transcript by its path, for an agent that hands its own session
// to subagents. Only files inside the Claude Code projects folder are read, so a request
// to this local server cannot make it read anything else on the machine.
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative } from 'node:path';
import { InputError } from './errors.mjs';

export const maxTranscriptFileBytes = 64 * 1024 * 1024;

/** Where Claude Code keeps session transcripts, unless CONTEXT_LEDGER_TRANSCRIPT_ROOT says otherwise. */
export const transcriptRoot = (env = process.env) => env.CONTEXT_LEDGER_TRANSCRIPT_ROOT || join(homedir(), '.claude', 'projects');

/** Read a transcript file that must be a regular .jsonl file whose real path is inside `root`. */
export async function readTranscriptFile(path, { root = transcriptRoot(), maxBytes = maxTranscriptFileBytes } = {}) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.length > 4096 || path.includes('\0') || !path.endsWith('.jsonl')) {
    throw new InputError('Choose an absolute path to a .jsonl transcript.');
  }
  let realRoot;
  let real;
  try {
    realRoot = await realpath(root);
  } catch {
    throw new InputError('The Claude Code transcripts folder was not found.');
  }
  try {
    real = await realpath(path);
  } catch {
    throw new InputError('Transcript file not found.');
  }
  const inside = relative(realRoot, real);
  if (!inside || inside.startsWith('..') || isAbsolute(inside) || !real.endsWith('.jsonl')) {
    throw new InputError('Only transcripts in the Claude Code projects folder can be imported.');
  }

  const file = await open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new InputError('Transcript must be a regular file.');
    if (stat.size > maxBytes) throw new InputError(`Transcript exceeds ${Math.round(maxBytes / 1024 / 1024)} MiB.`);
    const bytes = await file.readFile();
    if (bytes.length > maxBytes) throw new InputError(`Transcript exceeds ${Math.round(maxBytes / 1024 / 1024)} MiB.`);
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new InputError('Transcript must be UTF-8 text.');
    }
    return { name: basename(real), text };
  } finally {
    await file.close();
  }
}
