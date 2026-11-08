// Hand-written graphs for the demo transcripts in fixtures.mjs. They are the expected
// result of each agent's publish step, the offline fallback if an agent misbehaves on
// stage, and the deterministic input of the Playwright demo check.
// Line numbers refer to demo/leo-orbit.jsonl and demo/ali-orbit.jsonl.

export function leoReference(sessionId) {
  return {
    version: 2,
    sessionId,
    party: 'leo',
    nodes: [
      { id: 'orbit-live', kind: 'goal', label: 'Orbit demo live by 19:00 on Saturday', evidenceLines: [1, 2] },
      { id: 'port-4400', kind: 'decision', label: 'The ledger runs on port 4400', evidenceLines: [3, 4] },
      { id: 'port-4317', kind: 'decision', label: 'The ledger stays on port 4317', evidenceLines: [27, 28] },
      { id: 'local-only', kind: 'constraint', label: 'Everything runs on the local laptop, not over stage Wi-Fi', evidenceLines: [35, 36] },
      { id: 'mcp-pairing', kind: 'offer', label: 'Pair with Ali on the MCP adapter', evidenceLines: [21, 22] },
      { id: 'record-video', kind: 'action', status: 'pending', label: 'Record the demo video on Saturday at 17:00', evidenceLines: [41, 42] },
      { id: 'gpu-owner', kind: 'question', to: 'ali', status: 'open', label: 'Who owns the GPU box?', evidenceLines: [51, 52] },
    ],
    edges: [
      { from: 'port-4317', to: 'port-4400', type: 'supersedes' },
      { from: 'record-video', to: 'orbit-live', type: 'advances' },
      { from: 'local-only', to: 'record-video', type: 'constrains' },
    ],
  };
}

export function aliReference(sessionId, leoGraphId) {
  return {
    version: 2,
    sessionId,
    party: 'ali',
    nodes: [
      { id: 'gpu-time', kind: 'offer', label: 'Two evenings of GPU time for the benchmark', evidenceLines: [1, 2] },
      { id: 'no-sunday', kind: 'constraint', label: 'No work on Sunday', evidenceLines: [3, 4] },
      { id: 'which-port', kind: 'question', to: 'leo', status: 'open', label: 'Which port does the ledger use?', evidenceLines: [5, 6] },
      { id: 'benchmark', kind: 'action', status: 'pending', label: 'Benchmark the Orbit handoff after the MCP adapter works', evidenceLines: [7, 8] },
    ],
    edges: [],
    links: [
      { from: 'benchmark', graph: leoGraphId, to: 'mcp-pairing', type: 'matches' },
      { from: 'gpu-time', graph: leoGraphId, to: 'orbit-live', type: 'matches' },
    ],
  };
}
