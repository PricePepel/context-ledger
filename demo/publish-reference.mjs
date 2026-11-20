#!/usr/bin/env node
// Stage fallback: publish the reference graphs for the imported demo transcripts on a
// running ledger and open their room, without any agent.
//   PORT=4317 node demo/publish-reference.mjs
// It reads the ledger's access token from the file next to CONTEXT_LEDGER_DB (the
// repository's .context-ledger/ledger.sqlite by default).
import { clientToken } from '../src/token.mjs';
import { inlineText } from '../src/text.mjs';
import { aliReference, leoReference } from './reference-graphs.mjs';

const port = Number(process.env.PORT ?? 4317);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT.');
const origin = `http://127.0.0.1:${port}`;
// Only for the port the token file names; without it nothing is sent.
const { token, otherPort, exposed } = await clientToken(port);
const auth = token === undefined ? {} : { Authorization: `Bearer ${token}` };

async function api(path, body) {
  if (token === undefined) {
    throw new Error(otherPort !== undefined
      ? `The ledger's access token is for port ${otherPort}: run this with PORT=${otherPort}.`
      : exposed
        ? 'The ledger\'s access token file can be read by other users, so it was not used: restart the ledger to write a private one.'
        : 'Cannot read the ledger\'s access token: start it with npm start, with the same PORT and CONTEXT_LEDGER_DB as this script.');
  }
  const init = body === undefined ? { headers: auth } : {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...auth }, body: JSON.stringify(body),
  };
  const response = await fetch(origin + path, init);
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) throw new Error('The ledger refused the request: start it with npm start, with the same CONTEXT_LEDGER_DB as this script.');
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${inlineText(String(data.error ?? '')).slice(0, 200)}`);
  return data;
}

async function session(provider, query) {
  const { sessions } = await api(`/api/sessions?q=${encodeURIComponent(query)}&provider=${provider}`);
  if (!sessions.length) throw new Error(`Import demo/${provider === 'claude' ? 'leo' : 'ali'}-orbit.jsonl first.`);
  return sessions[0].id;
}

try {
  const leo = (await api('/api/graphs', leoReference(await session('claude', 'orbit grafana')))).graph;
  const ali = (await api('/api/graphs', aliReference(await session('codex', 'orbit benchmark'), leo.id))).graph;
  const { room } = await api('/api/rooms', { graphIds: [leo.id, ali.id] });
  console.log(`Leo's graph: ${leo.id}\nAli's graph: ${ali.id}\nRoom: ${origin}/#room=${room.id}`);
} catch (error) {
  console.error(error.cause?.code === 'ECONNREFUSED' ? `No ledger on port ${port}. Start it with npm start.` : error.message);
  process.exitCode = 1;
}
