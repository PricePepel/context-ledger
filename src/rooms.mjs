import { createHash } from 'node:crypto';
import { diffCounts, diffGraphs } from './diff.mjs';
import { InputError } from './errors.mjs';
import { isPartyGraph } from './graph.mjs';
import { nodeGrounding } from './grounding.mjs';

const hashPattern = /^[a-f0-9]{64}$/u;
const choices = new Set(['confirm', 'reject']);

const digest = (...parts) => createHash('sha256').update(parts.join('\0')).digest('hex');

/**
 * Negotiation rooms pair two stored v2 graphs from different parties. Every link
 * from one graph to the other is a proposal. Each party records its own confirm or
 * reject; a proposal is agreed only when both confirm. Agents can open and read a
 * room, but choices are recorded by people (see the decisions route in server.mjs).
 */
/** The version 0 room tables; openStore creates them under the migration lock. */
export const roomsSchema = `
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
  `;

export function mountRooms(database, readGraph, graphProject = () => null) {
  const insertRoom = database.prepare('INSERT INTO rooms (id, graph_a, graph_b) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING');
  const selectRoom = database.prepare('SELECT graph_a AS a, graph_b AS b FROM rooms WHERE id = ?');
  const selectChoices = database.prepare('SELECT proposal_id AS proposalId, party, choice FROM room_choices WHERE room_id = ?');
  const upsertChoice = database.prepare(`
    INSERT INTO room_choices (room_id, proposal_id, party, choice) VALUES (?, ?, ?, ?)
    ON CONFLICT (room_id, proposal_id, party) DO UPDATE SET choice = excluded.choice
  `);
  let selectCursor;
  let selectRooms;
  // Prepared on first use: the party column comes from a migration that runs after mounting.
  let selectSameSession;
  let selectOtherSession;

  /**
   * Card G11: the newest graph of the same party, when it is not this one, and what
   * changed. Party names are self-asserted, so a graph from another transcript under the
   * same name is marked sameSession: false; only the room's person can tell if it is theirs.
   */
  // The same session and other sessions are looked up apart, so a graph from another
  // transcript cannot hide the room's own party's newer graph (G11 review round 2).
  function newerGraphs(graph) {
    selectSameSession ??= database.prepare('SELECT id FROM graphs WHERE party = ? AND session_id = ? ORDER BY rowid DESC LIMIT 1');
    // P2a: only graphs of sessions in the same project as this one (= never matches a
    // missing project).
    selectOtherSession ??= database.prepare(`SELECT g.id FROM graphs g JOIN sessions s ON s.id = g.session_id
      WHERE g.party = ? AND g.session_id <> ?
        AND s.project_id = (SELECT project_id FROM sessions WHERE id = ?)
        AND g.rowid > (SELECT rowid FROM graphs WHERE id = ?) ORDER BY g.rowid DESC LIMIT 1`);
    const { party, sessionId } = graph.packet;
    const candidates = [selectSameSession.get(party, sessionId)?.id, selectOtherSession.get(party, sessionId, sessionId, graph.id)?.id];
    return candidates.flatMap(newest => {
      if (!newest || newest === graph.id) return [];
      const newer = readGraph(newest);
      if (!isPartyGraph(newer?.packet)) return [];
      // Both snapshots are loaded here, so the diff reads nothing again.
      const { any, ...counts } = diffCounts(diffGraphs(graph, newer));
      return [{ party, graphId: newest, fromGraphId: graph.id, sameSession: newer.packet.sessionId === sessionId, changed: any, counts }];
    });
  }

  function endpoint(graph, nodeId) {
    const node = graph.packet.nodes.find(candidate => candidate.id === nodeId);
    return { party: graph.packet.party, graphId: graph.id, nodeId, kind: node.kind, label: node.label };
  }

  // P2a: one project for both graphs, or null (a room opened across projects, or with a
  // graph whose project is missing, before rooms were project-scoped).
  const roomProject = row => {
    const [a, b] = [graphProject(row.a), graphProject(row.b)];
    return a !== null && a === b ? a : null;
  };

  function view(id) {
    const row = selectRoom.get(id);
    if (!row) return;
    const project = roomProject(row);
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
        nodes: graph.packet.nodes.map(node => ({ ...node, grounding: nodeGrounding(graph, node.id) })),
        readyActionIds: graph.readyActionIds,
        currentDecisionIds: graph.currentDecisionIds,
        openQuestionIds: graph.openQuestionIds,
      })),
      proposals,
      // A room across projects points at no newer graph in either (P2a review).
      newerGraphs: project === null ? [] : graphs.flatMap(newerGraphs),
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
      if (graphs.some(graph => !isPartyGraph(graph.packet))) throw new InputError('A room needs version 2 or 3 graphs.');
      const [a, b] = graphs.map(graph => graph.packet);
      if (a.party === b.party) throw new InputError('A room needs graphs from two different parties.');
      if (a.sessionId === b.sessionId) throw new InputError('A room needs graphs from two different sessions.');
      // Card P2a (ADR-7a): rooms are project-scoped, like links.
      const projects = graphIds.map(graphProject);
      if (projects[0] === null || projects[0] !== projects[1]) throw new InputError('A room needs two graphs from the same project.');

      const [first, second] = [...graphIds].sort();
      const id = digest('room', first, second);
      insertRoom.run(id, first, second);
      return view(id);
    },

    getRoom: view,

    decide(id, input) {
      const room = view(id);
      if (!room) return;
      // A room opened across projects before P2a stays readable but takes no choices.
      if (roomProject(selectRoom.get(id)) === null) {
        throw new InputError('This room joins graphs from two projects, so it takes no choices; open a room within one project.');
      }
      const { proposalId, party, choice } = input ?? {};
      if (!room.proposals.some(proposal => proposal.id === proposalId)) throw new InputError('Unknown proposal in this room.');
      if (!room.parties.some(entry => entry.party === party)) throw new InputError('Only a party in this room can decide.');
      if (!choices.has(choice)) throw new InputError('Choice must be confirm or reject.');
      upsertChoice.run(id, proposalId, party, choice);
      return view(id);
    },

    /**
     * Rooms, newest first, for one graph (either side), one party (either party) and/or
     * one project (both graphs in it; P2a). Rows name the two parties and the project
     * (null for a room opened across projects before P2a): no proposals or choices.
     * Prepared on first use.
     */
    listRooms({ graphId = null, party = null, project = null, limit, after }) {
      selectCursor ??= database.prepare('SELECT rowid FROM rooms WHERE id = ?');
      selectRooms ??= database.prepare(`
        SELECT r.id, r.created_at AS createdAt,
          a.id AS graphA, a.party AS partyA, a.session_id AS sessionA,
          b.id AS graphB, b.party AS partyB, b.session_id AS sessionB,
          CASE WHEN sa.project_id = sb.project_id THEN pa.slug END AS project
        FROM rooms r JOIN graphs a ON a.id = r.graph_a JOIN graphs b ON b.id = r.graph_b
          LEFT JOIN sessions sa ON sa.id = a.session_id LEFT JOIN projects pa ON pa.id = sa.project_id
          LEFT JOIN sessions sb ON sb.id = b.session_id LEFT JOIN projects pb ON pb.id = sb.project_id
        WHERE ($graphId IS NULL OR r.graph_a = $graphId OR r.graph_b = $graphId)
          AND ($party IS NULL OR a.party = $party OR b.party = $party)
          AND ($project IS NULL OR (pa.slug = $project AND pb.slug = $project))
          AND ($before IS NULL OR r.rowid < $before)
        ORDER BY r.rowid DESC LIMIT $n
      `);
      let before = null;
      if (after !== undefined && after !== null) {
        const row = selectCursor.get(after);
        if (!row) throw new InputError('Unknown cursor.');
        before = row.rowid;
      }
      const rows = selectRooms.all({ $graphId: graphId, $party: party, $project: project, $before: before, $n: limit + 1 });
      const rooms = rows.slice(0, limit).map(row => ({
        id: row.id,
        createdAt: row.createdAt,
        project: row.project ?? null,
        parties: [
          { party: row.partyA, graphId: row.graphA, sessionId: row.sessionA },
          { party: row.partyB, graphId: row.graphB, sessionId: row.sessionB },
        ].sort((x, y) => ((x.party ?? '') < (y.party ?? '') ? -1 : (x.party ?? '') > (y.party ?? '') ? 1 : 0)),
      }));
      return { rooms, next: rows.length > limit ? rows[limit - 1].id : null };
    },
  };
}
