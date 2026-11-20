import { fitCount, maxResultCharacters, pageSections, resultSize } from '../paging.mjs';
import { terminalJson } from '../text.mjs';
import { ToolError, briefingText, hexId, isObject, jsonResult, text, tooLarge } from './common.mjs';

// Paging (cycle 10). A result that fits maxResultCharacters and was not asked to
// continue is exactly what it was before paging existed. Anything longer comes in
// pages that say what remains and which argument values read it. Notes carry only
// fixed words, numbers, IDs from the same result and JSON-quoted paths.
// Tool-specific paging lives with each tool group; file text paging is in file-pages.mjs.

// A partial text page starts and ends with its continuation note. The first line says
// the result is partial even when a client drops the end, and data cannot forge it:
// every text result starts with the tool's own words, never with transcript or file text.
export const partialMark = '[Partial result: ';
export const notesText = note => ({ top: `${partialMark}${note}]\n\n`, end: `\n\n[${note}]` });
export const notesSize = note => {
  const { top, end } = notesText(note);
  return resultSize(briefingText(top)) + resultSize(briefingText(end));
};
/** body is already escaped. */
export const partialPage = (body, note) => {
  const { top, end } = notesText(note);
  return briefingText(top) + body + briefingText(end);
};

/**
 * Rows of one list page, trimmed from the end to fit. Without more rows and without
 * trimming the result is { [key]: rows }; otherwise more.after is the last row shown.
 */
export function listResult(key, rows, next, note, kind) {
  const build = count => {
    if (count === rows.length && next === null) return { [key]: rows };
    const after = count > 0 ? rows[count - 1]?.id : next;
    if (typeof after !== 'string' || !hexId.test(after)) throw new ToolError(`Context Ledger returned an unexpected ${kind} response.`);
    return { more: { after, note }, [key]: rows.slice(0, count) };
  };
  return jsonResult(build(fitCount(count => terminalJson(build(count)), rows.length, maxResultCharacters)));
}

export const listShape = (data, key) => isObject(data) && Array.isArray(data[key]) && Object.hasOwn(data, 'next')
  && (data.next === null || (typeof data.next === 'string' && hexId.test(data.next)));

export const arrayOrAbsent = value => value === undefined || Array.isArray(value);
// The derived state comes first, so the first page of a paged graph_publish result
// carries the derived ID lists (ready actions, current choices, open questions) it promises.
// The G7 marks hold one ID per node, so they are paged too rather than repeated on every
// page. They come last: republishing a graph stored before G7 adds them, and items after
// them would otherwise be renumbered under a client that is part way through reading.
export const graphSections = [['readyActionIds'], ['currentDecisionIds'], ['openQuestionIds'],
  ['packet', 'nodes'], ['packet', 'edges'], ['packet', 'links'], ['quotedNodeIds'], ['inferredNodeIds']];
// Item numbers must not move between calls. Every room section but agreedProposalIds has
// a length fixed by the two graph snapshots; that one changes with people's choices, so
// it comes last, where a change cannot shift the numbers of any other item.
export const roomSections = [['proposals'], ['parties', 0, 'nodes'], ['parties', 1, 'nodes'],
  ...[0, 1].flatMap(index => ['readyActionIds', 'currentDecisionIds', 'openQuestionIds'].map(key => ['parties', index, key])),
  ['agreedProposalIds']];
export const validGraph = data => isObject(data?.graph) && isObject(data.graph.packet)
  && graphSections.every(([first, second]) => arrayOrAbsent(second ? data.graph[first][second] : data.graph[first]));
export const validRoom = data => isObject(data?.room) && arrayOrAbsent(data.room.proposals) && arrayOrAbsent(data.room.agreedProposalIds)
  && Array.isArray(data.room.parties) && data.room.parties.length === 2
  && data.room.parties.every(party => isObject(party)
    && ['nodes', 'readyActionIds', 'currentDecisionIds', 'openQuestionIds'].every(key => arrayOrAbsent(party[key])));
export const asOfCall = ' Choices and states are as of this call.';
export const pastEnd = suffix => (from, total) => `No items at or after ${from}; there are ${total}.${suffix}`;

/**
 * A graph or room as JSON, paged by whole items when it does not fit (src/paging.mjs).
 * Unpaged output, the common case, is exactly the ledger's response.
 */
export function pagedJson(name, data, { kind, fromItem, note, suffix = '' }) {
  if (fromItem === 1) {
    const whole = terminalJson(data);
    if (resultSize(whole) <= maxResultCharacters) return { content: [text(whole)] };
  }
  const graph = kind === 'graph';
  if (!(graph ? validGraph(data) : validRoom(data))) throw new ToolError(`Context Ledger returned an unexpected ${kind} response.`);
  const paged = pageSections({
    rootKey: kind,
    root: data[kind],
    paths: graph ? graphSections : roomSections,
    fromItem,
    limit: maxResultCharacters,
    render: terminalJson,
    note: (next, total) => `Items ${next} to ${total} remain. ${note(next)}${suffix}`,
    pastEnd: pastEnd(suffix),
  });
  if (paged.tooLarge) throw tooLarge(name);
  return jsonResult(paged.result);
}
