#!/usr/bin/env node
// Stage fallback: publish the reference graphs for the imported demo transcripts on a
// running ledger and open their room, without any agent.
//   PORT=4317 node demo/publish-reference.mjs
import { aliReference, leoReference } from './reference-graphs.mjs';

const port = Number(process.env.PORT ?? 4317);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT.');
const origin = `http://127.0.0.1:${port}`;

async function api(path, body) {
  const init = body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body),
  };
  const response = await fetch(origin + path, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${data.error ?? ''}`);
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
