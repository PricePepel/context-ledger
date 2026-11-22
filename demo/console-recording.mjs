// The console's demo mode replays this recording. It is made by the real store: the
// two synthetic Orbit transcripts are imported, each agent publishes its graph in
// growing snapshots, and every response is saved as the API returns it. So each
// movement in the demo is a real ledger event, only replayed on a clock.
// Run `node demo/console-recording.mjs` to rewrite public/console/demo-recording.json.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openStore } from '../src/store.mjs';
import { aliReference, leoReference } from './reference-graphs.mjs';

const recordingUrl = new URL('../public/console/demo-recording.json', import.meta.url);

// Leo's snapshots grow along his transcript (line numbers of demo/leo-orbit.jsonl).
function leoSnapshot(step, sessionId, aliGraphId) {
  const full = leoReference(sessionId);
  const node = id => full.nodes.find(candidate => candidate.id === id);
  const sunday = { id: 'record-video', kind: 'action', status: 'pending', label: 'Record the demo video on Sunday morning', evidenceLines: [11, 12] };
  if (step === 1) return { ...full, nodes: [node('orbit-live'), node('port-4400')], edges: [] };
  if (step === 2) {
    return {
      ...full,
      nodes: [node('orbit-live'), node('port-4400'), sunday, node('mcp-pairing')],
      edges: [{ from: 'record-video', to: 'orbit-live', type: 'advances' }],
    };
  }
  if (step === 3) {
    return {
      ...full,
      nodes: [node('orbit-live'), node('port-4400'), node('port-4317'), node('local-only'), sunday, node('mcp-pairing')],
      edges: full.edges,
    };
  }
  // The final reference graph, which also answers Ali's question by link.
  return { ...full, links: [{ from: 'port-4317', graph: aliGraphId, to: 'which-port', type: 'answers' }] };
}

function aliSnapshot(step, sessionId, leoGraphId) {
  const full = aliReference(sessionId, leoGraphId);
  if (step === 1) {
    const { links: _links, ...rest } = full;
    return { ...rest, nodes: full.nodes.filter(node => node.id === 'gpu-time' || node.id === 'no-sunday') };
  }
  return full;
}

/** Build the recording from the committed demo transcripts with a fresh in-memory store. */
export async function buildRecording() {
  const store = openStore(':memory:');
  try {
    const transcript = name => readFile(new URL(name, import.meta.url), 'utf8');
    const leo = store.importTranscript({ provider: 'claude', source: 'leo-orbit.jsonl', transcript: await transcript('leo-orbit.jsonl') });
    const ali = store.importTranscript({ provider: 'codex', source: 'ali-orbit.jsonl', transcript: await transcript('ali-orbit.jsonl') });

    const events = [];
    const publish = (atMs, packet) => {
      const graph = store.publishGraph(packet);
      const { graphs: [summary] } = store.listGraphs({ sessionId: packet.sessionId, limit: 1 });
      // Times are replayed relative to the start of playback, so none is stored.
      summary.createdAt = null;
      const { meter } = store.getGraphContext(graph.id);
      events.push({ atMs, summary, graph, meter });
      return graph;
    };

    publish(2000, leoSnapshot(1, leo.id));
    publish(7000, leoSnapshot(2, leo.id));
    publish(11000, aliSnapshot(1, ali.id));
    const leo3 = publish(15000, leoSnapshot(3, leo.id));
    const ali2 = publish(20000, aliSnapshot(2, ali.id, leo3.id));
    publish(26000, leoSnapshot(4, leo.id, ali2.id));

    return {
      about: 'Synthetic demo for the CTM console: Leo works in Claude Code, Ali in Codex. Made by node demo/console-recording.mjs from demo/leo-orbit.jsonl and demo/ali-orbit.jsonl with the real store; every name and plan is made up.',
      durationMs: 34000,
      sessions: Object.fromEntries([leo, ali].map(({ id }) => [id, store.get(id)])),
      events,
    };
  } finally {
    store.close();
  }
}

export const recordingText = recording => JSON.stringify(recording, null, 1) + '\n';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await writeFile(recordingUrl, recordingText(await buildRecording()));
  console.log(`Wrote ${fileURLToPath(recordingUrl)}`);
}
