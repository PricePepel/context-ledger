// The console's state, built only from published graphs. Pure: no DOM and no fetch,
// so node:test can check it. Times are milliseconds on the caller's clock.

const kindOrder = ['goal', 'constraint', 'decision', 'offer', 'action', 'blocker', 'question'];

/** A v2 graph belongs to its party; a v1 graph has none and stands for its session. */
export const partyKey = packet => (packet.party ? `party:${packet.party}` : `session:${packet.sessionId}`);
export const nodeKey = (party, id) => `${party}/${id}`;

/** The G7 mark when a node carries one, otherwise null (every node is drawn neutral). */
export function nodeMark(node) {
  const mark = node.grounding ?? node.mark;
  return mark === 'quoted' || mark === 'inferred' ? mark : null;
}

const startOfDay = at => {
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
};

/**
 * The transcript lines a node cites. Card P2b: a version 3 node cites message keys, which
 * the ledger resolved to lines when the graph was published (the graph's `citations`).
 */
export function citedLines(graph, node) {
  if (graph.packet.version !== 3) return node.evidenceLines;
  const entry = Array.isArray(graph.citations) ? graph.citations.find(citation => citation.id === node.id) : undefined;
  return Array.isArray(entry?.lines) ? entry.lines.filter(line => Number.isSafeInteger(line)) : [];
}

/**
 * The artifacts a version 3 node cites (P2b review): { kind, repo, ref } strings, as the
 * ledger stored them when the graph was published. Anything else is left out.
 */
export function citedArtifacts(graph, node) {
  if (graph.packet.version !== 3) return [];
  const entry = Array.isArray(graph.citations) ? graph.citations.find(citation => citation.id === node.id) : undefined;
  return (Array.isArray(entry?.artifacts) ? entry.artifacts : [])
    .filter(artifact => ['kind', 'repo', 'ref'].every(field => typeof artifact?.[field] === 'string'))
    .map(({ kind, repo, ref }) => ({ kind, repo, ref }));
}

export function createModel({ workingMs = 60_000 } = {}) {
  const parties = new Map(); // key -> { key, party, label, provider, sessionId, graph, meter, at }
  const graphParty = new Map(); // graph ID -> party key, for every graph seen
  const published = new Map(); // graph ID -> publish time, for every graph seen
  const snapshots = new Map(); // graph ID -> graph, for every graph read in full

  /** Party key and node ID of a link's target, when its graph has been seen. */
  const linkTarget = link => {
    const party = graphParty.get(link.graph);
    return party ? { party, id: link.to } : null;
  };

  // The same evidence: the same citations in the same session (P2b review: a key such as
  // l:1, or a line number, names another turn in another session).
  const sameCitations = (graphA, nodeA, graphB, nodeB) => graphA.packet.sessionId === graphB.packet.sessionId
    && JSON.stringify(nodeA.evidenceLines ?? nodeA.evidence) === JSON.stringify(nodeB.evidenceLines ?? nodeB.evidence);

  // Everything a person sees or checks on a node: a change to any of it is a change.
  // Card P2b: a version 3 node cites `evidence` (message keys or artifacts) instead.
  const nodeText = node => JSON.stringify([node.kind, node.label, node.status ?? null, node.to ?? null, node.evidenceLines ?? node.evidence]);
  function nodeLabels(graph) {
    // The session too: the same lines or keys in another session cite other turns (P2b review).
    return new Map(graph.packet.nodes.map(node => [node.id, graph.packet.sessionId + nodeText(node)]));
  }

  /** Open questions of a party's current graph that no current graph answers. */
  function openQuestions(entry, answered) {
    const open = new Set(entry.graph.openQuestionIds ?? entry.graph.packet.nodes
      .filter(node => node.kind === 'question' && node.status === 'open').map(node => node.id));
    return new Set([...open].filter(id => !answered.has(nodeKey(entry.key, id))));
  }

  return {
    /**
     * Record one published graph. Returns what moved: nodes new to the party, nodes
     * whose label or status changed, and nodes of other parties it links to.
     */
    apply({ summary, graph, meter = null, provider, at }) {
      const key = partyKey(graph.packet);
      graphParty.set(graph.id, key);
      snapshots.set(graph.id, graph);
      if (!published.has(graph.id)) published.set(graph.id, at);
      const previous = parties.get(key);
      // Both sources deliver snapshots in publish order (the live one by place in the
      // ledger list, not by time, since clocks can move back), so the last one wins.
      if (previous?.graph.id === graph.id) return { party: key, added: [], changed: [], read: [] };

      const before = previous ? nodeLabels(previous.graph) : new Map();
      const added = [];
      const changed = [];
      for (const [id, text] of nodeLabels(graph)) {
        if (!before.has(id)) added.push(nodeKey(key, id));
        else if (before.get(id) !== text) changed.push(nodeKey(key, id));
      }
      const read = (graph.packet.links ?? []).map(linkTarget).filter(Boolean)
        .map(target => nodeKey(target.party, target.id));
      parties.set(key, {
        key,
        party: graph.packet.party ?? null,
        label: graph.packet.party ?? summary?.sessionTitle ?? graph.packet.sessionId.slice(0, 12),
        provider,
        sessionId: graph.packet.sessionId,
        graph,
        meter,
        at,
        firstAt: previous?.firstAt ?? at,
      });
      return { party: key, added, changed, read: [...new Set(read)] };
    },

    /** Remember a graph read only because a current graph links to it. */
    noteGraph(graph) {
      if (!graphParty.has(graph.id)) graphParty.set(graph.id, partyKey(graph.packet));
      snapshots.set(graph.id, graph);
    },

    /** Graphs that current graphs link to but that have not been read. */
    unknownLinkedGraphs() {
      const ids = new Set();
      for (const { graph } of parties.values()) {
        for (const link of graph.packet.links ?? []) if (!snapshots.has(link.graph)) ids.add(link.graph);
      }
      return [...ids];
    },

    /** Count a graph from the list without reading it (an older snapshot on first load). */
    noteSummary(summary, at) {
      if (!graphParty.has(summary.id)) graphParty.set(summary.id, partyKey(summary));
      if (!published.has(summary.id)) published.set(summary.id, at);
    },

    /** Attach a meter read later (the live source fetches it only for current graphs). */
    setMeter(graphId, meter) {
      for (const entry of parties.values()) if (entry.graph.id === graphId) entry.meter = meter;
    },

    currentGraphIds: () => [...parties.values()].map(entry => entry.graph.id),
    hasGraph: id => published.has(id),

    /**
     * Questions answered by a link from any current graph, as node keys. The link
     * names one snapshot; it answers the current question only when that snapshot's
     * question has the same label, recipient and cited lines, so a reused ID is not closed.
     */
    answeredByLink() {
      const answered = new Set();
      for (const { graph } of parties.values()) {
        for (const link of graph.packet.links ?? []) {
          const target = link.type === 'answers' && linkTarget(link);
          const asked = target && snapshots.get(link.graph)?.packet.nodes.find(node => node.id === link.to);
          const current = asked && parties.get(target.party)?.graph.packet.nodes.find(node => node.id === link.to);
          if (current && current.label === asked.label && (current.to ?? null) === (asked.to ?? null)
            && sameCitations(parties.get(target.party).graph, current, snapshots.get(link.graph), asked)) {
            answered.add(nodeKey(target.party, target.id));
          }
        }
      }
      return answered;
    },

    /** The office: one agent per party (only today's with todayOnly), with its state at `now`. */
    agents(now, { todayOnly = false } = {}) {
      const answered = this.answeredByLink();
      const today = startOfDay(now);
      return [...parties.values()].filter(entry => !todayOnly || entry.at >= today).map(entry => {
        const open = openQuestions(entry, answered);
        const waiting = entry.graph.packet.nodes.some(node => node.kind === 'question' && open.has(node.id)
          && node.to && node.to !== entry.party);
        const state = now - entry.at < workingMs ? 'working' : waiting ? 'waiting' : 'idle';
        return { key: entry.key, provider: entry.provider, label: entry.label, state };
      });
    },

    /** Every node of every current graph, grouped by party, in kind order. */
    graph() {
      const answered = this.answeredByLink();
      // Columns keep the order in which parties first published, so they never jump.
      const columns = [...parties.values()].sort((a, b) => a.firstAt - b.firstAt).map(entry => {
        const open = openQuestions(entry, answered);
        const superseded = new Set(entry.graph.packet.edges.filter(edge => edge.type === 'supersedes').map(edge => edge.to));
        const nodes = [...entry.graph.packet.nodes]
          .sort((a, b) => kindOrder.indexOf(a.kind) - kindOrder.indexOf(b.kind))
          .map(node => ({
            key: nodeKey(entry.key, node.id),
            id: node.id,
            kind: node.kind,
            label: node.label,
            status: node.status ?? null,
            to: node.to ?? null,
            evidenceLines: citedLines(entry.graph, node),
            artifacts: citedArtifacts(entry.graph, node),
            mark: nodeMark(node),
            superseded: node.kind === 'decision' && superseded.has(node.id),
            answered: node.kind === 'question' && node.status === 'open' && !open.has(node.id),
          }));
        return { key: entry.key, label: entry.label, provider: entry.provider, sessionId: entry.sessionId, graphId: entry.graph.id, nodes };
      });
      const edges = [];
      for (const entry of parties.values()) {
        for (const edge of entry.graph.packet.edges) {
          edges.push({ from: nodeKey(entry.key, edge.from), to: nodeKey(entry.key, edge.to), type: edge.type, link: false });
        }
        for (const link of entry.graph.packet.links ?? []) {
          const target = linkTarget(link);
          if (target) edges.push({ from: nodeKey(entry.key, link.from), to: nodeKey(target.party, target.id), type: link.type, link: true });
        }
      }
      return { columns, edges };
    },

    /** The numbers strip at `now`. */
    numbers(now) {
      const today = startOfDay(now);
      const handoffs = [...published.values()].filter(at => at >= today).length;
      let tokensSaved = 0;
      let metered = 0;
      let superseded = 0;
      for (const entry of parties.values()) {
        const decisions = entry.graph.packet.nodes.filter(node => node.kind === 'decision').length;
        superseded += decisions - (entry.graph.currentDecisionIds?.length ?? decisions);
        if (entry.at >= today && entry.meter) {
          tokensSaved += entry.meter.savedTokens;
          metered += 1;
        }
      }
      return { handoffs, tokensSaved, metered, superseded };
    },

    /** Where a node's evidence lives. */
    node(key) {
      const slash = key.lastIndexOf('/');
      const entry = parties.get(key.slice(0, slash));
      const node = entry?.graph.packet.nodes.find(candidate => candidate.id === key.slice(slash + 1));
      // P2b: the panel reads lines and artifacts, which a version 3 node keeps in the graph.
      return node ? { entry, node: { ...node, evidenceLines: citedLines(entry.graph, node), artifacts: citedArtifacts(entry.graph, node) } } : null;
    },
  };
}

// The same rule as visibleText in src/text.mjs (a node test keeps them in step):
// controls, bidi overrides and invisible characters in transcript text are shown as
// \u escapes, so the proof cannot be spoofed by text that reorders or hides itself.
const keptFormatCharacters = new Set([0x200c, 0x200d]);
const backslash = String.fromCodePoint(0x5c);
export function visibleText(text) {
  return text.replace(/\r\n/g, '\n').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, character => {
    if (character === '\n' || character === '\t') return character;
    if (keptFormatCharacters.has(character.codePointAt(0))) return character;
    return [...Array(character.length).keys()]
      .map(index => `${backslash}u` + character.charCodeAt(index).toString(16).padStart(4, '0')).join('');
  });
}

/**
 * The turns to show for a node's evidence: each cited message, with the message
 * before and after it, in transcript order.
 */
export function evidenceTurns(messages, evidenceLines) {
  const cited = new Set(evidenceLines);
  const keep = new Set();
  messages.forEach((message, index) => {
    if (!cited.has(message.line)) return;
    for (const near of [index - 1, index, index + 1]) if (near >= 0 && near < messages.length) keep.add(near);
  });
  return [...keep].sort((a, b) => a - b).map(index => ({
    ...messages[index],
    text: visibleText(messages[index].text),
    cited: cited.has(messages[index].line),
  }));
}
