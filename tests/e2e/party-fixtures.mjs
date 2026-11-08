import { expect } from '@playwright/test';

// Synthetic two-person fixtures for the cycle 4 negotiation evals.
const claudeTurn = (role, content) => JSON.stringify({ type: role, message: { role, content } });
const codexTurn = (role, text) => JSON.stringify({
  type: 'response_item',
  payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] },
});

export const transcripts = {
  leo: {
    provider: 'claude',
    source: 'leo-orbit-demo.jsonl',
    transcript: [
      claudeTurn('user', 'I want the synthetic Orbit demo live by 19:00. I can pair on the MCP adapter.'),
      claudeTurn('assistant', 'Noted. The ledger stays on port 4317. Next: record the demo. Who owns the GPU box?'),
    ].join('\n'),
  },
  ali: {
    provider: 'codex',
    source: 'ali-orbit-demo.jsonl',
    transcript: [
      codexTurn('user', 'I can offer two evenings of GPU time. I cannot work on Sunday. Which port does the ledger use?'),
      codexTurn('assistant', 'I will benchmark the Orbit handoff once the adapter exists.'),
    ].join('\n'),
  },
};

export async function importParty(request, baseURL, party) {
  const response = await request.post('/api/import', { headers: { origin: baseURL }, data: transcripts[party] });
  expect(response.ok()).toBe(true);
  return (await response.json()).session.id;
}

export function aliPacket(sessionId, label = 'Two evenings of GPU time') {
  return {
    version: 2,
    sessionId,
    party: 'ali',
    nodes: [
      { id: 'gpu-time', kind: 'offer', label, evidenceLines: [1] },
      { id: 'no-sunday', kind: 'constraint', label: 'No work on Sunday', evidenceLines: [1] },
      { id: 'which-port', kind: 'question', to: 'leo', status: 'open', label: 'Which port does the ledger use?', evidenceLines: [1] },
      { id: 'benchmark', kind: 'action', status: 'pending', label: 'Benchmark the Orbit handoff', evidenceLines: [2] },
    ],
    edges: [],
  };
}

export function leoPacket(sessionId, aliGraphId) {
  return {
    version: 2,
    sessionId,
    party: 'leo',
    nodes: [
      { id: 'orbit-demo', kind: 'goal', label: 'Orbit demo live by 19:00', evidenceLines: [1] },
      { id: 'mcp-pairing', kind: 'offer', label: 'Pair on the MCP adapter', evidenceLines: [1] },
      { id: 'port-4317', kind: 'decision', label: 'The ledger stays on port 4317', evidenceLines: [2] },
      { id: 'record-demo', kind: 'action', status: 'pending', label: 'Record the demo on Sunday', evidenceLines: [2] },
      { id: 'gpu-owner', kind: 'question', to: 'ali', status: 'open', label: 'Who owns the GPU box?', evidenceLines: [2] },
    ],
    edges: [{ from: 'record-demo', to: 'orbit-demo', type: 'advances' }],
    links: [
      { from: 'mcp-pairing', graph: aliGraphId, to: 'gpu-time', type: 'matches' },
      { from: 'record-demo', graph: aliGraphId, to: 'no-sunday', type: 'conflicts' },
      { from: 'port-4317', graph: aliGraphId, to: 'which-port', type: 'answers' },
    ],
  };
}

export async function publish(request, baseURL, packet) {
  const response = await request.post('/api/graphs', { headers: { origin: baseURL }, data: packet });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).graph;
}
