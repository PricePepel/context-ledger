// Card R1 (ADR-19): a parcel carries one graph to another machine, with the transcript
// lines it cites and nothing else of the session. `ledger share` builds it from a stored
// graph and `ledger receive` checks it before the store takes it in (receiveParcel in
// store.mjs). Errors are fixed sentences that never echo a value from the file.
import Ajv2020 from 'ajv/dist/2020.js';
import parcelSchema from '../schemas/parcel-v1.schema.json' with { type: 'json' };
import { artifactId, checkArtifact } from './artifacts.mjs';
import { InputError } from './errors.mjs';
import { nodeArtifacts, packetCitations, packetId, validateGraph } from './graph.mjs';
import { findSecrets, redactSession } from './secrets.mjs';
import { sourceName } from './text.mjs';

export const parcelFormat = 'context-ledger-parcel';
export const maxParcelBytes = 8 * 1024 * 1024;

const ajv = new Ajv2020({ strict: true, ownProperties: true });
const validShape = ajv.compile(parcelSchema);
const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Transcript order: by line, then by key, so two parcels of one session merge the same way. */
export const byLine = (a, b) => a.line - b.line || compareText(a.key, b.key);

const redactionMarker = /\[REDACTED [a-z0-9-]{1,40}\]/gu;
const isHigh = code => code >= 0xd800 && code <= 0xdbff;
const isLow = code => code >= 0xdc00 && code <= 0xdfff;
// True unless the index falls between the two halves of one character.
const betweenCharacters = (text, index) => !(isHigh(text.charCodeAt(index - 1)) && isLow(text.charCodeAt(index)));

/** The index `count` characters after `at`, or -1 when that passes `end`. */
function skipCharacters(text, at, count, end) {
  let index = at;
  for (let left = count; left > 0; left -= 1) {
    if (index >= end) return -1;
    index += isHigh(text.charCodeAt(index)) && isLow(text.charCodeAt(index + 1)) ? 2 : 1;
  }
  return index <= end ? index : -1;
}

/**
 * The first place at or after `from` where `part` lies in `text` before `end`, on whole
 * characters. Knuth-Morris-Pratt, so the time is linear whatever the two texts hold.
 */
function findPart(text, part, from, end) {
  const length = part.length;
  if (length > end - from) return -1;
  const fallback = new Int32Array(length);
  for (let index = 1, matched = 0; index < length; index += 1) {
    while (matched > 0 && part.charCodeAt(index) !== part.charCodeAt(matched)) matched = fallback[matched - 1];
    if (part.charCodeAt(index) === part.charCodeAt(matched)) matched += 1;
    fallback[index] = matched;
  }
  for (let index = from, matched = 0; index < end; index += 1) {
    const code = text.charCodeAt(index);
    while (matched > 0 && code !== part.charCodeAt(matched)) matched = fallback[matched - 1];
    if (code === part.charCodeAt(matched)) matched += 1;
    if (matched === length) {
      const start = index + 1 - length;
      if (betweenCharacters(text, start) && betweenCharacters(text, index + 1)) return start;
      matched = fallback[matched - 1];
    }
  }
  return -1;
}

/**
 * True when `shown` is `original`, or `original` with some parts replaced by the
 * scanner's [REDACTED <kind>] markers, each marker standing for at least one whole
 * character. It does not depend on which values a scanner finds, so text redacted by an
 * older or newer build still matches its original; text changed in any other way does
 * not. The time is linear in the two lengths.
 */
export function matchesRedacted(shown, original) {
  if (shown === original) return true;
  const parts = shown.split(redactionMarker);
  if (parts.length === 1) return false;
  const last = parts.at(-1);
  const end = original.length - last.length;
  let at = parts[0].length;
  if (at > end || !original.startsWith(parts[0]) || !original.endsWith(last)) return false;
  if (!betweenCharacters(original, at) || !betweenCharacters(original, end)) return false;
  // Markers since the last literal part. The leftmost place for a part leaves the most
  // room for the parts after it, so no other placement needs trying.
  let markers = 0;
  for (const part of parts.slice(1, -1)) {
    markers += 1;
    if (part === '') continue;
    const from = skipCharacters(original, at, markers, end);
    const found = from < 0 ? -1 : findPart(original, part, from, end);
    if (found < 0) return false;
    at = found + part.length;
    markers = 0;
  }
  return skipCharacters(original, at, markers + 1, end) >= 0;
}

const fieldsOf = turn => (turn.role === 'agent' ? ['text', 'author', 'recipient'] : ['text']);

/** True when a turn as a parcel shows it is the stored turn, whole or redacted. */
export const sameTurn = (shown, original) => shown.line === original.line && shown.role === original.role
  && fieldsOf(shown).every(field => matchesRedacted(shown[field], original[field]));

/**
 * For two sets of excerpts, where neither side is the transcript: the same line and role,
 * and each field equal or one a further redaction of the other. Two excerpts that redact
 * one line in different places are not recognised as the same turn.
 */
export const compatibleTurns = (a, b) => a.line === b.line && a.role === b.role
  && fieldsOf(a).every(field => matchesRedacted(a[field], b[field]) || matchesRedacted(b[field], a[field]));

// A session's title is the first 120 characters of its first user turn with white space
// squeezed (titleFor in store.mjs). The same form of a text is its lead.
const leadCharacters = 120;
const shortestLead = 20;
function leadOf(text) {
  const lead = [];
  let space = false;
  for (const character of text) {
    if (/\s/u.test(character)) {
      space = lead.length > 0;
      continue;
    }
    if (space) {
      lead.push(' ');
      space = false;
      if (lead.length >= leadCharacters) break;
    }
    lead.push(character);
    if (lead.length >= leadCharacters) break;
  }
  return folded(lead.join(''));
}
// Lower case one character at a time. Lower-casing a whole text depends on what follows
// a letter (a Greek capital sigma becomes one of two letters), so a lead cut from a text
// and the same words inside a label could come out different.
const folded = text => Array.from(text, character => character.toLowerCase()).join('');
const squeezed = text => folded(text.trim().split(/\s+/u).join(' '));
// Every character that ends a line, as the secret scanner and editors see lines.
const lineBreak = /\r\n|[\n\v\f\r\x85\p{Zl}\p{Zp}]/u;

/**
 * True when a label holds the lead of a turn the graph does not cite, or of one physical
 * line of such a turn, unless the text that is carried holds the same words anyway.
 * Leads are kept in sets by length, and each place in a label is looked up once per
 * length. A lead is at most 120 characters, so the work is bounded by the labels and
 * does not grow with the number of uncited lines.
 */
function repeatsUncited(labels, uncited, carried) {
  const byLength = new Map();
  for (const message of uncited) {
    for (const text of [message.text, ...message.text.split(lineBreak)]) {
      const lead = leadOf(text);
      if ([...lead].length < shortestLead) continue;
      if (!byLength.has(lead.length)) byLength.set(lead.length, new Set());
      byLength.get(lead.length).add(lead);
    }
  }
  if (byLength.size === 0) return false;
  let carriedText;
  const isCarried = new Map();
  for (const label of labels.map(squeezed)) {
    for (const [length, leads] of byLength) {
      for (let index = 0; index + length <= label.length; index += 1) {
        const lead = label.slice(index, index + length);
        if (!leads.has(lead)) continue;
        if (!isCarried.has(lead)) {
          carriedText ??= carried.map(message => squeezed(message.text)).join('\n');
          isCarried.set(lead, carriedText.includes(lead));
        }
        if (!isCarried.get(lead)) return true;
      }
    }
  }
  return false;
}

const strings = value => {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
};

// Used when the transcript's file name, once redacted, is no longer a name a ledger stores.
const redactedSourceName = 'source name redacted';

/**
 * The parcel for a stored graph and its session (a store.get() detail). It holds the
 * messages the packet cites, after the secret scanner, in transcript order, and the
 * packet and its artifacts as published.
 *
 * The packet, the artifacts and the project slug cannot be redacted, because the graph's
 * ID and the artifact IDs cover them. So a graph is refused when one of them holds what
 * the scanner takes for a credential, or when a label repeats a line the graph does not
 * cite (the session's title is such a line). A label can still say in other words what
 * an uncited line says: a person reads the labels before sharing.
 *
 * Returns the parcel, its file text, how many values the scanner replaced, and how many
 * other graphs the packet links to: the receiver needs those first.
 */
export function buildParcel(graph, session) {
  const cited = packetCitations(graph.packet);
  const isCited = graph.packet.version === 3 ? message => cited.keys.has(message.key) : message => cited.lines.has(message.line);
  const carried = session.messages.filter(isCited);
  // Only a version 3 graph whose every citation is an artifact cites no line.
  if (carried.length === 0) throw new InputError('This graph cites no transcript lines, so it cannot be shared.');
  if (typeof session.project !== 'string') throw new InputError('This graph\'s session has no project, so it cannot be shared.');

  const artifacts = new Map();
  for (const node of graph.packet.nodes) {
    for (const { id, kind, repo, ref } of nodeArtifacts(graph, node)) {
      if (cited.artifacts.has(id)) artifacts.set(id, { kind, repo, ref });
    }
  }
  if ([graph.packet, [...artifacts.values()], session.project].flatMap(strings).some(text => findSecrets(text).length > 0)) {
    throw new InputError('This graph\'s own text (a label, a name, an artifact or its project) holds what looks like a credential, so it was not shared.');
  }

  const { session: redacted, findings } = redactSession({ source: session.source, messages: carried });
  const uncited = session.messages.filter(message => !isCited(message));
  if (repeatsUncited(graph.packet.nodes.map(node => node.label), uncited, redacted.messages)) {
    throw new InputError('A label of this graph repeats a transcript line the graph does not cite, so it was not shared. Cite that line or reword the label.');
  }
  // A marker can make a long file name longer than a ledger stores; the name is only shown.
  let source = redacted.source;
  try {
    if (sourceName(source) !== source) source = redactedSourceName;
  } catch {
    source = redactedSourceName;
  }
  const parcel = {
    format: parcelFormat,
    version: 1,
    project: session.project,
    session: {
      id: session.id,
      provider: session.provider,
      source,
      messages: redacted.messages.map(({ key, line, role, text, author, recipient }) => (
        role === 'agent' ? { key, line, role, text, author, recipient } : { key, line, role, text })).sort(byLine),
    },
    artifacts: [...artifacts.values()],
    graph: { id: graph.id, packet: graph.packet },
    redacted: findings.length,
  };
  const text = serializeParcel(parcel);
  if (Buffer.byteLength(text) > maxParcelBytes) throw new InputError('This graph cites more text than a parcel can carry (8 MiB), so it was not shared.');
  // Checked as the receiver will check it, so a parcel that would be refused is never
  // written. A stored graph whose artifacts do not resolve as its packet says fails here.
  try {
    checkParcel(JSON.parse(text));
  } catch {
    throw new InputError('This graph\'s stored citations do not match its packet, so it was not shared.');
  }
  return { parcel, text, redacted: findings.length, links: new Set((graph.packet.links ?? []).map(link => link.graph)).size };
}

const escapeCodeUnits = character => [...Array(character.length).keys()]
  .map(index => '\\u' + character.charCodeAt(index).toString(16).padStart(4, '0')).join('');

/**
 * The parcel's JSON text: one line with a final newline. Control, format and line
 * separator characters are written as \u escapes, which JSON reads back unchanged, so the
 * file shows what it holds in any editor or terminal.
 */
export const serializeParcel = parcel => JSON.stringify(parcel).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, escapeCodeUnits) + '\n';

const notParcel = 'This is not a version 1 Context Ledger parcel.';
const notExact = 'A parcel must carry exactly the lines and artifacts its graph cites.';
const sameSet = (set, values) => set.size === values.length && values.every(value => set.has(value));

/**
 * A checked parcel from a parsed JSON value, or an InputError (a GraphInputError for a
 * packet that is not a valid graph). The shape follows schemas/parcel-v1.schema.json. The
 * rules a schema cannot say are checked here, and none of them needs a ledger: the source
 * is a file name a ledger stores; an agent turn has an author and a recipient and no
 * other turn does; keys and lines are unique; the packet names the parcel's session; the
 * messages and artifacts are exactly the ones the packet cites, so nothing rides along
 * and nothing is left for the receiver's ledger to supply; the packet is a valid graph
 * over them; and the graph ID is the packet's own. Only what needs the ledger is left for
 * the store: the session already there, and the graphs the packet links to.
 */
export function checkParcel(value) {
  if (!validShape(value)) throw new InputError(notParcel);
  const { project, session, graph } = value;
  let name;
  try {
    name = sourceName(session.source);
  } catch {
    throw new InputError(notParcel);
  }
  if (name !== session.source) throw new InputError(notParcel);
  const keys = new Set();
  const lines = new Set();
  for (const message of session.messages) {
    const agent = message.role === 'agent';
    if (agent !== (message.author !== undefined) || agent !== (message.recipient !== undefined)) throw new InputError(notParcel);
    // An import never stores an empty turn, so a parcel has none.
    if (!message.text.trim()) throw new InputError(notParcel);
    keys.add(message.key);
    lines.add(message.line);
  }
  if (keys.size !== session.messages.length || lines.size !== session.messages.length) {
    throw new InputError('A parcel must carry each message once.');
  }
  if (graph.packet.sessionId !== session.id) throw new InputError('The parcel\'s graph cites another session than the one it carries.');

  const cited = packetCitations(graph.packet);
  if (graph.packet.version === 3 ? !sameSet(cited.keys, [...keys]) : !sameSet(cited.lines, [...lines])) throw new InputError(notExact);
  // An artifact's ID covers its project, so the IDs are computed as this parcel's project gives them.
  const artifactIds = value.artifacts.map(artifact => artifactId(checkArtifact({ ...artifact, project })));
  if (new Set(artifactIds).size !== artifactIds.length || !sameSet(cited.artifacts, artifactIds)) throw new InputError(notExact);
  // Everything about the graph that its own packet decides; links wait for the ledger.
  validateGraph(graph.packet, [...lines], { messageKeys: [...keys], hasArtifact: id => cited.artifacts.has(id), withoutLinks: true });
  if (packetId(graph.packet) !== graph.id) throw new InputError('The parcel\'s graph ID does not match its packet.');
  return value;
}

/** A checked parcel from the bytes of a parcel file. */
export function parseParcel(bytes) {
  if (bytes.length > maxParcelBytes) throw new InputError('A parcel is at most 8 MiB.');
  let value;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new InputError(notParcel);
  }
  return checkParcel(value);
}
