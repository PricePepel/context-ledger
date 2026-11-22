// Shared pieces of the MCP adapter: error types, argument checks and result text.
import { terminalJson, visibleText } from '../text.mjs';

export const maxPacketBytes = 8 * 1024 * 1024;
export const hexId = /^[a-f0-9]{64}$/;
export const partyName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Stored party names are lowercase ASCII (the graph v2 schema), so a filter may use any
// ASCII case. Only A-Z folds: toLowerCase would also map KELVIN SIGN to k.
export const partyFilter = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;
export const foldParty = value => value.replace(/[A-Z]/g, letter => letter.toLowerCase());
export const maxOffset = 16 * 1024 * 1024;

export class ToolError extends Error {}

export class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);

export function checkArguments(args, allowed) {
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) throw new ToolError(`Unknown argument "${/^[\w-]{1,64}$/.test(key) ? key : '?'}".`);
  }
}

export function requireHex(args, name, label) {
  if (typeof args[name] !== 'string' || !hexId.test(args[name])) {
    throw new ToolError(`${name} must be a 64-character lowercase hex ${label} ID.`);
  }
  return args[name];
}

export const tooLarge = name => new ToolError(`${name} returned an item too large to show.`);

export function optionalInteger(args, name, minimum, maximum, message) {
  const value = args[name];
  if (value !== undefined && (!Number.isSafeInteger(value) || value < minimum || value > maximum)) throw new ToolError(message);
  return value;
}
export const fromItemArgument = args => optionalInteger(args, 'fromItem', 1, Number.MAX_SAFE_INTEGER, 'fromItem must be a positive integer.') ?? 1;
export const fromLineArgument = args => optionalInteger(args, 'fromLine', 1, Number.MAX_SAFE_INTEGER, 'fromLine must be a positive integer.') ?? 1;
export const fromOffsetArgument = args => optionalInteger(args, 'fromOffset', 0, maxOffset, 'fromOffset must be a non-negative integer.') ?? 0;

export function listArguments(args, defaultLimit) {
  const limit = optionalInteger(args, 'limit', 1, 100, 'limit must be an integer from 1 to 100.') ?? defaultLimit;
  if (args.after !== undefined && (typeof args.after !== 'string' || !hexId.test(args.after))) {
    throw new ToolError('after must be a 64-character lowercase hex ID from a previous page.');
  }
  return { limit: String(limit), after: args.after };
}

export function optionalParty(args) {
  const { party } = args;
  if (party === undefined) return undefined;
  const folded = typeof party === 'string' ? foldParty(party) : '';
  if (folded.length > 32 || !partyName.test(folded)) {
    throw new ToolError('party must be a party name of at most 32 lowercase letters, digits and single hyphens.');
  }
  return folded;
}

// Card P2a (ADR-7a): a project slug filter, folded like party (A-Z only).
const projectName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const projectSchema = description => ({ type: 'string', maxLength: 64, pattern: partyFilter.source, description });
export function optionalProject(args) {
  const { project } = args;
  if (project === undefined) return undefined;
  const folded = typeof project === 'string' ? foldParty(project) : '';
  if (folded.length > 64 || !projectName.test(folded)) {
    throw new ToolError('project must be a slug of at most 64 lowercase letters, digits and single hyphens.');
  }
  return folded;
}
// A ledger from before P2a ignores the filter and sends rows of every project. Each row
// must name the project asked for, so such a list is refused, never passed on as scoped.
export function assertProjectRows(rows, project) {
  if (project !== undefined && !rows.every(row => isObject(row) && row.project === project)) {
    throw new ToolError('This Context Ledger cannot filter by project. Restart it with npm start.');
  }
}

export const text = value => ({ type: 'text', text: value });
// visibleText keeps U+2028/U+2029; escape them too so a briefing cannot fake line breaks.
export const briefingText = value => visibleText(value)
  .replace(/[\p{Zl}\p{Zp}]/gu, character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));
export const jsonResult = data => ({ content: [text(terminalJson(data))] });

export const hexSchema = description => ({ type: 'string', pattern: '^[a-f0-9]{64}$', description });
