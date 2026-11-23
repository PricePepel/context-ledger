// Card R1 (ADR-19): a parcel carries one graph to another machine, with the transcript
// lines it cites and nothing else of the session. `ledger share` builds it from a stored
// graph and `ledger receive` checks it before the store takes it in (receiveParcel in
// store.mjs). Errors are fixed sentences that never echo a value from the file.
import Ajv2020 from 'ajv/dist/2020.js';
import parcelSchema from '../schemas/parcel-v1.schema.json' with { type: 'json' };
import { artifactId, checkArtifact } from './artifacts.mjs';
import { InputError } from './errors.mjs';
import { nodeArtifacts, packetCitations, packetId } from './graph.mjs';
import { findSecrets, redactSession } from './secrets.mjs';

export const parcelFormat = 'context-ledger-parcel';
export const maxParcelBytes = 8 * 1024 * 1024;

const ajv = new Ajv2020({ strict: true, ownProperties: true });
const validShape = ajv.compile(parcelSchema);
const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Transcript order: by line, then by key, so two parcels of one session merge the same way. */
export const byLine = (a, b) => a.line - b.line || compareText(a.key, b.key);

const redactionMarker = /\[REDACTED [a-z0-9-]{1,40}\]/gu;

/**
 * True when `shown` is `original`, or `original` with some non-empty parts replaced by
 * the scanner's [REDACTED <kind>] markers. It does not depend on which values a scanner
 * finds, so text redacted by an older or newer build still matches its original; text
 * changed in any other way does not.
 */
export function matchesRedacted(shown, original) {
  if (shown === original) return true;
  const parts = shown.split(redactionMarker);
  if (parts.length === 1) return false;
  const last = parts.at(-1);
  if (!original.startsWith(parts[0]) || !original.endsWith(last)) return false;
  const end = original.length - last.length;
  let at = parts[0].length;
  // Each marker stands for at least one character. The leftmost place for a part leaves
  // the most room for the parts after it, so no other placement needs trying.
  for (const part of parts.slice(1, -1)) {
    const found = original.indexOf(part, at + 1);
    if (found < 0) return false;
    at = found + part.length;
  }
  return at + 1 <= end;
}

/** True when a turn as a parcel shows it is the stored turn, whole or redacted. */
export const sameTurn = (shown, original) => shown.line === original.line && shown.role === original.role
  && matchesRedacted(shown.text, original.text)
  && (shown.role !== 'agent' || (matchesRedacted(shown.author, original.author) && matchesRedacted(shown.recipient, original.recipient)));

// A session's title is the first 120 code points of its first user turn with white space
// squeezed (titleFor in store.mjs), so the same form of every uncited turn is looked for.
const squeezed = text => text.trim().split(/\s+/u).join(' ').toLowerCase();
const leadOf = text => [...squeezed(text.slice(0, 4096))].slice(0, 120).join('');
const shortestLead = 20;

const strings = value => {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
};

/**
 * The parcel for a stored graph and its session (a store.get() detail). It holds the
 * messages the packet cites, after the secret scanner, in transcript order, and the
 * packet and its artifacts as published.
 *
 * The packet cannot be redacted, because the graph's ID covers it. So a graph is refused
 * when its own text holds what the scanner takes for a credential, or when a label repeats
 * a line the graph does not cite (the session's title is such a line). A label can still
 * say in other words what an uncited line says: a person reads the labels before sharing.
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
  if ([graph.packet, [...artifacts.values()]].flatMap(strings).some(text => findSecrets(text).length > 0)) {
    throw new InputError('This graph\'s own text (a label, a name or an artifact) holds what looks like a credential, so it was not shared.');
  }
  const labels = graph.packet.nodes.map(node => squeezed(node.label));
  for (const message of session.messages) {
    if (isCited(message)) continue;
    const lead = leadOf(message.text);
    if ([...lead].length >= shortestLead && labels.some(label => label.includes(lead))) {
      throw new InputError('A label of this graph repeats a transcript line the graph does not cite, so it was not shared. Cite that line or reword the label.');
    }
  }

  const { session: redacted, findings } = redactSession({ source: session.source, messages: carried });
  const parcel = {
    format: parcelFormat,
    version: 1,
    project: session.project,
    session: {
      id: session.id,
      provider: session.provider,
      source: redacted.source,
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
  // written. A stored graph whose citations do not resolve as its packet says fails here.
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
 * packet of the wrong shape). The shape follows schemas/parcel-v1.schema.json. The rules
 * a schema cannot say are checked here, and none of them needs a ledger: an agent turn
 * has an author and a recipient and no other turn does; keys and lines are unique; the
 * packet names the parcel's session; the messages and artifacts are exactly the ones the
 * packet cites, so nothing rides along and nothing is left for the receiver's ledger to
 * supply; and the graph ID is the packet's own. Links to other graphs are checked when
 * the store publishes the packet.
 */
export function checkParcel(value) {
  if (!validShape(value)) throw new InputError(notParcel);
  const { project, session, graph } = value;
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
  if (/\p{Cc}/u.test(session.source)) throw new InputError(notParcel);
  if (graph.packet.sessionId !== session.id) throw new InputError('The parcel\'s graph cites another session than the one it carries.');

  const cited = packetCitations(graph.packet);
  if (graph.packet.version === 3 ? !sameSet(cited.keys, [...keys]) : !sameSet(cited.lines, [...lines])) throw new InputError(notExact);
  // An artifact's ID covers its project, so the IDs are computed as this parcel's project gives them.
  const artifactIds = value.artifacts.map(artifact => artifactId(checkArtifact({ ...artifact, project })));
  if (new Set(artifactIds).size !== artifactIds.length || !sameSet(cited.artifacts, artifactIds)) throw new InputError(notExact);
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
