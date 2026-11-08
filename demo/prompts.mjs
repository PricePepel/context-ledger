// The prompts pasted on stage. demo/rehearse.mjs sends the same text, so a rehearsal
// tests exactly what the presenter types.

export const leoPublish = 'Use context-ledger. Find my Claude session about orbit with session_search and read all of it ' +
  'with session_read. Check graph_schema (version 2) for the allowed edge kinds, then publish a version 2 graph for party leo ' +
  'with graph_publish. Include only what Ali needs to work with me: the goal, the decisions about the demo (keep a replaced ' +
  'decision and add a supersedes edge from the new decision to the old one), constraints, my offers, pending actions and my ' +
  'open questions for Ali. Skip housekeeping chatter such as UI tweaks, tests and docs. Cite line numbers. ' +
  'If graph_publish rejects the packet, fix what the error names and publish again. End with the graph ID alone on the last line.';

export const aliPublish = leoGraphId => 'Use context-ledger. Find my Codex session about orbit with session_search and read it ' +
  `with session_read. Read Leo's graph ${leoGraphId} with graph_read and check graph_schema (version 2) for the allowed kinds. ` +
  'Publish a version 2 graph for party ali with graph_publish, citing line numbers, with links to Leo\'s current nodes only: ' +
  '"matches" where my offer or action fits his goal, offer or action, and "conflicts" only for a real clash with a plan he ' +
  'still has. If graph_publish rejects the packet, fix what the error names and publish again. ' +
  'End with the graph ID alone on the last line.';

export const aliHandoff = leoGraphId => `Call context_for on Leo's graph ${leoGraphId}. Which port does the ledger use, ` +
  'when is the video recorded, and what does Leo still need from me?';
