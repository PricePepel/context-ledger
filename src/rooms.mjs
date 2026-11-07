import { createHash } from 'node:crypto';
import { InputError } from './errors.mjs';

const hashPattern = /^[a-f0-9]{64}$/u;
const choices = new Set(['confirm', 'reject']);

const digest = (...parts) => createHash('sha256').update(parts.join('\0')).digest('hex');

/**
 * Negotiation rooms pair two stored v2 graphs from different parties. Every link
 * from one graph to the other is a proposal. Each party records its own confirm or
 * reject; a proposal is agreed only when both confirm. Agents can open and read a
 * room, but choices are recorded by people (see the decisions route in server.mjs).
 */
export function mountRooms(database, readGraph) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      graph_a TEXT NOT NULL REFERENCES graphs(id),
      graph_b TEXT NOT NULL REFERENCES graphs(id),
      CHECK (graph_a < graph_b)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS room_choices (
      room_id TEXT NOT NULL REFERENCES rooms(id),
      proposal_id TEXT NOT NULL,
      party TEXT NOT NULL,
      choice TEXT NOT NULL CHECK (choice IN ('confirm', 'reject')),
      PRIMARY KEY (room_id, proposal_id, party)
    ) STRICT;
  `);
  const insertRoom = database.prepare('INSERT INTO rooms (id, graph_a, graph_b) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING');
  const selectRoom = database.prepare('SELECT graph_a AS a, graph_b AS b FROM rooms WHERE id = ?');
  const selectChoices = database.prepare('SELECT proposal_id AS proposalId, party, choice FROM room_choices WHERE room_id = ?');
  const upsertChoice = database.prepare(`
    INSERT INTO room_choices (room_id, proposal_id, party, choice) VALUES (?, ?, ?, ?)
    ON CONFLICT (room_id, proposal_id, party) DO UPDATE SET choice = excluded.choice
  `);

  function endpoint(graph, nodeId) {
    const node = graph.packet.nodes.find(candidate => candidate.id === nodeId);
    return { party: graph.packet.party, graphId: graph.id, nodeId, kind: node.kind, label: node.label };
  }

  function view(id) {
    const row = selectRoom.get(id);
    if (!row) return;
    const graphs = [readGraph(row.a), readGraph(row.b)].sort((x, y) => (x.packet.party < y.packet.party ? -1 : 1));
    const parties = graphs.map(graph => graph.packet.party);

    // Maps, not objects: a party may be named "constructor", and an inherited
    // property must never stand in for a person's missing choice.
    const recorded = new Map();
    for (const { proposalId, party, choice } of selectChoices.all(id)) {
      if (!recorded.has(proposalId)) recorded.set(proposalId, new Map());
      recorded.get(proposalId).set(party, choice);
    }

    const proposals = [];
    for (const [index, graph] of graphs.entries()) {
      const other = graphs[1 - index];
      for (const link of graph.packet.links ?? []) {
        if (link.graph !== other.id) continue;
        const proposalId = digest('proposal', graph.id, link.type, link.from, link.to);
        const made = recorded.get(proposalId) ?? new Map();
        const partyChoices = Object.fromEntries(parties.map(party => [party, made.get(party) ?? null]));
        const values = Object.values(partyChoices);
        proposals.push({
          id: proposalId,
          type: link.type,
          from: endpoint(graph, link.from),
          to: endpoint(other, link.to),
          choices: partyChoices,
          state: values.includes('reject') ? 'rejected' : values.every(value => value === 'confirm') ? 'agreed' : 'proposed',
        });
      }
    }

    return {
      id,
      parties: graphs.map(graph => ({
        party: graph.packet.party,
        graphId: graph.id,
        sessionId: graph.packet.sessionId,
        nodes: graph.packet.nodes,
        readyActionIds: graph.readyActionIds,
        currentDecisionIds: graph.currentDecisionIds,
        openQuestionIds: graph.openQuestionIds,
      })),
      proposals,
      agreedProposalIds: proposals.filter(proposal => proposal.state === 'agreed').map(proposal => proposal.id),
    };
  }

  return {
    openRoom(input) {
      const graphIds = input?.graphIds;
      if (!Array.isArray(graphIds) || graphIds.length !== 2 || !graphIds.every(id => typeof id === 'string' && hashPattern.test(id))) {
        throw new InputError('A room needs exactly two graph IDs.');
      }
      if (graphIds[0] === graphIds[1]) throw new InputError('A room needs two different graphs.');
      const graphs = graphIds.map(readGraph);
      if (graphs.some(graph => !graph)) throw new InputError('Room graph not found.');
      if (graphs.some(graph => graph.packet.version !== 2)) throw new InputError('A room needs version 2 graphs.');
      const [a, b] = graphs.map(graph => graph.packet);
      if (a.party === b.party) throw new InputError('A room needs graphs from two different parties.');
      if (a.sessionId === b.sessionId) throw new InputError('A room needs graphs from two different sessions.');

      const [first, second] = [...graphIds].sort();
      const id = digest('room', first, second);
      insertRoom.run(id, first, second);
      return view(id);
    },

    getRoom: view,

    decide(id, input) {
      const room = view(id);
      if (!room) return;
      const { proposalId, party, choice } = input ?? {};
      if (!room.proposals.some(proposal => proposal.id === proposalId)) throw new InputError('Unknown proposal in this room.');
      if (!room.parties.some(entry => entry.party === party)) throw new InputError('Only a party in this room can decide.');
      if (!choices.has(choice)) throw new InputError('Choice must be confirm or reject.');
      upsertChoice.run(id, proposalId, party, choice);
      return view(id);
    },
  };
}
