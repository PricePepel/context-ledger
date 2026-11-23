// Card R1 (ADR-19): a parcel carries one graph to another machine, with the transcript
// lines it cites and nothing else of the session. `ledger share` builds it from a stored
// graph and `ledger receive` checks it before the store takes it in (receiveParcel in
// store.mjs). Errors are fixed sentences that never echo a value from the file.
import Ajv2020 from 'ajv/dist/2020.js';
import parcelSchema from '../schemas/parcel-v1.schema.json' with { type: 'json' };
import { InputError } from './errors.mjs';
import { nodeArtifacts, nodeLines } from './graph.mjs';
import { redactSession } from './secrets.mjs';

export const parcelFormat = 'context-ledger-parcel';
export const maxParcelBytes = 8 * 1024 * 1024;

const ajv = new Ajv2020({ strict: true, ownProperties: true });
const validShape = ajv.compile(parcelSchema);
const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Transcript order: by line, then by key, so two parcels of one session merge the same way. */
export const byLine = (a, b) => a.line - b.line || compareText(a.key, b.key);

/**
 * The parcel for a stored graph and its session (a store.get() detail). It holds the
 * messages on the lines the graph cites, after the secret scanner, in transcript order.
 * Returns the parcel, how many values the scanner replaced, and how many other graphs
 * the packet links to: the receiver needs those first.
 */
export function buildParcel(graph, session) {
  const lines = new Set(graph.packet.nodes.flatMap(node => nodeLines(graph, node)));
  const cited = session.messages.filter(message => lines.has(message.line));
  // Only a version 3 graph whose every citation is an artifact cites no line.
  if (cited.length === 0) throw new InputError('This graph cites no transcript lines, so it cannot be shared.');
  if (typeof session.project !== 'string') throw new InputError('This graph\'s session has no project, so it cannot be shared.');
  const { session: redacted, findings } = redactSession({ source: session.source, messages: cited });
  const artifacts = new Map();
  for (const node of graph.packet.nodes) {
    for (const { id, kind, repo, ref } of nodeArtifacts(graph, node)) artifacts.set(id, { kind, repo, ref });
  }
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
  // Checked as the receiver will check it, so a parcel that would be refused is never written.
  checkParcel(JSON.parse(serializeParcel(parcel)));
  return { parcel, redacted: findings.length, links: new Set((graph.packet.links ?? []).map(link => link.graph)).size };
}

/** The parcel's JSON text, one line with a final newline. */
export const serializeParcel = parcel => JSON.stringify(parcel) + '\n';

const notParcel = 'This is not a version 1 Context Ledger parcel.';

/**
 * A checked parcel from a parsed JSON value, or an InputError. The shape follows
 * schemas/parcel-v1.schema.json. The rules a schema cannot say are checked here: an agent
 * turn has an author and a recipient and no other turn does, keys and lines are unique,
 * and the packet names the parcel's session. The packet itself is validated when the
 * store publishes it.
 */
export function checkParcel(value) {
  if (!validShape(value)) throw new InputError(notParcel);
  const { session, graph } = value;
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
