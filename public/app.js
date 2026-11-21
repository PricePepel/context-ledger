const agentNames = { claude: 'Claude Code', codex: 'Codex' };
const maxImportBytes = 8 * 1024 * 1024;
const importForm = document.querySelector('#import-form');
const sourceAgent = document.querySelector('#source-agent');
const transcriptFile = document.querySelector('#transcript-file');
const importButton = importForm.querySelector('button[type="submit"]');
const importStatus = document.querySelector('#import-status');
const searchForm = document.querySelector('#search-form');
const searchQuery = document.querySelector('#search-query');
const filterAgent = document.querySelector('#filter-agent');
const searchStatus = document.querySelector('#search-status');
const searchResults = document.querySelector('#search-results');
const readerHeading = document.querySelector('#reader-heading');
const readerSource = document.querySelector('#reader-source');
const readerStatus = document.querySelector('#reader-status');
const readerMessages = document.querySelector('#reader-messages');
const readerDelete = document.querySelector('#reader-delete');

let searchRequest;
let readerRequest;
let selectedId;

function textElement(tag, text, className) {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  return element;
}

function renderRows(container, entries, createRow) {
  const fragment = document.createDocumentFragment();
  for (const entry of entries) fragment.append(createRow(entry));
  container.replaceChildren(fragment);
}

async function request(path, options) {
  const response = await fetch(path, options);
  const body = await response.json();
  if (!response.ok) throw Object.assign(new Error(body.error || `Request failed (${response.status}).`), { status: response.status });
  return body;
}

function renderSelection() {
  for (const button of searchResults.querySelectorAll('button')) {
    if (button.dataset.session === selectedId) {
      button.setAttribute('aria-current', 'true');
    } else {
      button.removeAttribute('aria-current');
    }
  }
}

function resultRow(session) {
  const item = document.createElement('li');
  const button = textElement('button', session.title, 'result-button');
  button.type = 'button';
  button.dataset.session = session.id;
  button.addEventListener('click', () => openTranscript(session.id, true));
  const count = `${session.messageCount} ${session.messageCount === 1 ? 'message' : 'messages'}`;
  item.append(button, textElement('p', `${agentNames[session.provider]} · ${count}`, 'result-meta'));
  return item;
}

async function search() {
  searchRequest?.abort();
  searchRequest = new AbortController();
  const { signal } = searchRequest;
  const params = new URLSearchParams();
  const query = searchQuery.value.trim();
  if (query) params.set('q', query);
  if (filterAgent.value) params.set('provider', filterAgent.value);

  searchStatus.textContent = 'Searching the archive…';
  searchResults.replaceChildren();
  try {
    const { sessions } = await request(`/api/sessions?${params}`, { signal });
    if (signal.aborted) return;
    renderRows(searchResults, sessions, resultRow);
    renderSelection();
    searchStatus.textContent = sessions.length
      ? `${sessions.length} ${sessions.length === 1 ? 'transcript' : 'transcripts'}`
      : query || filterAgent.value ? 'No matching transcripts.' : 'The archive is empty. Add a transcript to get started.';
  } catch (error) {
    if (!signal.aborted) searchStatus.textContent = `Search failed. ${error.message}`;
  }
}

function messageRow(message) {
  const item = document.createElement('li');
  const meta = document.createElement('div');
  meta.className = 'message-meta';
  meta.append(
    textElement('span', message.role === 'user' ? 'User' : 'Assistant'),
    textElement('span', `Line ${message.line}`, 'line-number'),
  );
  item.append(meta, textElement('p', message.text, 'message-text'));
  return item;
}

async function openTranscript(id, focusHeading = false) {
  readerRequest?.abort();
  readerRequest = new AbortController();
  const { signal } = readerRequest;
  selectedId = id;
  renderSelection();
  readerDelete.hidden = true;
  readerHeading.textContent = 'Opening transcript';
  readerSource.textContent = '';
  readerMessages.replaceChildren();
  readerStatus.textContent = 'Loading messages…';

  try {
    const { session } = await request(`/api/sessions/${encodeURIComponent(id)}`, { signal });
    if (signal.aborted) return;
    readerHeading.textContent = session.title;
    readerSource.textContent = `${agentNames[session.provider]} · ${session.source}`;
    renderRows(readerMessages, session.messages, messageRow);
    readerStatus.textContent = '';
    readerDelete.hidden = false;
    if (focusHeading) readerHeading.focus();
  } catch (error) {
    if (signal.aborted) return;
    selectedId = undefined;
    renderSelection();
    readerHeading.textContent = 'Unable to open transcript';
    readerStatus.textContent = error.message;
  }
}

// Card I2: a partial import says so, with what was kept and which lines were skipped.
function importNote(session, skipped) {
  if (!skipped?.count) return `Imported ${session.source}.`;
  const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;
  const which = skipped.lines.length < skipped.count ? `, first ${skipped.lines.join(', ')}` : ` (${skipped.lines.join(', ')})`;
  return `Partially imported ${session.source}: kept ${plural(session.messageCount, 'message')}, `
    + `skipped ${plural(skipped.count, 'unreadable line')}${which}. Messages on those lines are missing.`;
}

// Deleting asks first, with fixed text: transcript text never goes into the dialog.
readerDelete.addEventListener('click', async () => {
  const id = selectedId;
  if (!id || readerDelete.disabled) return;
  if (!window.confirm('Delete this transcript from the ledger? This cannot be undone.')) return;
  readerDelete.disabled = true;
  readerStatus.textContent = 'Deleting transcript…';
  try {
    await request(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
    // The person may have opened another transcript while the delete was in flight.
    if (selectedId === id) {
      readerRequest?.abort();
      selectedId = undefined;
      readerDelete.hidden = true;
      readerHeading.textContent = 'No transcript selected';
      readerSource.textContent = '';
      readerMessages.replaceChildren();
      readerStatus.textContent = 'Transcript deleted.';
    }
    await search();
  } catch (error) {
    if (selectedId === id) readerStatus.textContent = `Delete failed. ${error.message}`;
  } finally {
    readerDelete.disabled = false;
  }
});

importForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const file = transcriptFile.files[0];
  if (!file || importButton.disabled) return;
  const provider = sourceAgent.value;
  const tooLarge = () => "Import failed. This import is over the browser's 8 MiB limit; import it with: npm run ledger -- import --provider "
    + `${provider} <file>`;
  if (file.size >= maxImportBytes) {
    importStatus.textContent = tooLarge();
    return;
  }
  const readerAtImport = readerRequest;
  importButton.disabled = true;
  importStatus.textContent = 'Importing transcript…';

  try {
    const body = JSON.stringify({ provider, source: file.name, transcript: await file.text() });
    // A file under 8 MiB can still make a larger request once it is quoted as JSON. The
    // server refuses that before reading it, which the browser sees as a failed fetch.
    if (new Blob([body]).size > maxImportBytes) {
      importStatus.textContent = tooLarge();
      return;
    }
    const { session, skipped } = await request('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    if (transcriptFile.files[0] === file) transcriptFile.value = '';
    importStatus.textContent = importNote(session, skipped);
    const refresh = search();
    if (readerRequest === readerAtImport) await openTranscript(session.id);
    await refresh;
  } catch (error) {
    importStatus.textContent = error.status === 413 ? tooLarge() : `Import failed. ${error.message}`;
  } finally {
    importButton.disabled = false;
  }
});

searchForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void search();
});
filterAgent.addEventListener('change', search);
void search();

const roomForm = document.querySelector('#room-form');
const roomGraphA = document.querySelector('#room-graph-a');
const roomGraphB = document.querySelector('#room-graph-b');
const roomStatus = document.querySelector('#room-status');
const roomView = document.querySelector('#room-view');
const roomParties = document.querySelector('#room-parties');
const roomUpdates = document.querySelector('#room-updates');
const roomProposals = document.querySelector('#room-proposals');
const roomAgreed = document.querySelector('#room-agreed');
const linkVerbs = { matches: 'matches', conflicts: 'conflicts with', answers: 'answers' };
const roomSubmit = roomForm.querySelector('button[type="submit"]');
let currentRoomId;
let deciding = false;
let openingRoom = false;
// Bumped whenever the person asks for a room view. A response that arrives after a
// newer request is stale and must not replace the room now on screen.
let roomGeneration = 0;

// Labels come from the other party's agent. Each sits in its own <bdi> so bidi text
// cannot reorder the words around it, and never as markup.
function labelElement(text) {
  const label = textElement('bdi', text, 'node-label');
  label.dir = 'auto';
  return label;
}

function proposalSentence(proposal, tag = 'p') {
  const sentence = document.createElement(tag);
  sentence.className = 'proposal-text';
  const side = endpoint => [`${endpoint.party} · ${endpoint.kind} “`, labelElement(endpoint.label), '”'];
  sentence.append(...side(proposal.from), ` ${linkVerbs[proposal.type]} `, ...side(proposal.to));
  return sentence;
}

function partyColumn(party) {
  const column = document.createElement('section');
  column.className = 'party';
  column.setAttribute('aria-label', `Party ${party.party}`);
  column.append(textElement('h3', party.party), textElement('p', `Graph ${party.graphId.slice(0, 12)}…`, 'result-meta'));
  const list = document.createElement('ul');
  list.className = 'party-nodes';
  renderRows(list, party.nodes, node => {
    const item = document.createElement('li');
    // Card G7: quoted or inferred, from the cited lines; nothing for a graph stored before G7.
    const detail = [node.kind, node.grounding, node.status, node.to && `to ${node.to}`].filter(Boolean).join(' · ');
    if (node.grounding) item.dataset.grounding = node.grounding;
    item.append(textElement('span', detail, 'node-kind'), labelElement(node.label));
    return item;
  });
  column.append(list);
  return column;
}

function proposalRow(proposal, parties, takesChoices = true) {
  const item = document.createElement('li');
  item.dataset.proposal = proposal.id;
  item.dataset.state = proposal.state;
  item.append(proposalSentence(proposal), textElement('p', `State: ${proposal.state}`, 'proposal-state'));
  const actions = document.createElement('div');
  actions.className = 'proposal-actions';
  for (const party of parties) {
    const group = document.createElement('div');
    group.className = 'choice-group';
    const made = proposal.choices[party];
    group.append(textElement('span', `${party}: ${made ?? 'undecided'}`, 'choice-made'));
    // Card P2a: a read-only room keeps its recorded choices and offers no buttons.
    for (const choice of takesChoices ? ['confirm', 'reject'] : []) {
      const button = textElement('button', `${choice === 'confirm' ? 'Confirm' : 'Reject'} as ${party}`, 'choice-button');
      button.type = 'button';
      button.setAttribute('aria-pressed', String(made === choice));
      button.dataset.party = party;
      button.dataset.choice = choice;
      button.disabled = deciding;
      button.addEventListener('click', () => decide(proposal.id, party, choice));
      group.append(button);
    }
    actions.append(group);
  }
  item.append(actions);
  return item;
}

const changeWords = [['added', 'added'], ['removed', 'removed'], ['changed', 'changed'], ['superseded', 'decision superseded', 'decisions superseded'],
  ['answered', 'question answered', 'questions answered'], ['opened', 'question opened', 'questions opened'],
  ['readyGained', 'action now ready', 'actions now ready'], ['readyLost', 'action no longer ready', 'actions no longer ready'],
  ['edges', 'edge changed', 'edges changed'], ['links', 'link changed', 'links changed']];

function changeSummary(counts) {
  const parts = changeWords.filter(([key]) => counts[key]).map(([key, one, many = one]) => `${counts[key]} ${counts[key] === 1 ? one : many}`);
  return parts.length ? parts.join(', ') : 'no node, edge or link changes';
}

/** Card G11: the labels that changed, from the diff of the two snapshots. */
async function fillUpdate(list, update, generation) {
  try {
    const { diff } = await request(`/api/graphs/${update.graphId}/diff?from=${update.fromGraphId}`);
    if (generation !== roomGeneration) return;
    // Each node once, with the first thing that happened to it.
    const seen = new Set();
    const rows = [
      ...diff.nodes.added.map(node => ['Added', node]),
      ...diff.nodes.removed.map(node => ['Removed', node]),
      ...diff.supersededDecisions.map(node => ['Superseded', node]),
      ...diff.answeredQuestions.map(node => ['Answered', node]),
      ...diff.readyActionsGained.map(node => ['Now ready', node]),
      ...diff.readyActionsLost.map(node => ['No longer ready', node]),
      ...diff.nodes.changed.map(node => ['Changed', node]),
    ].filter(([, node]) => !seen.has(node.id) && seen.add(node.id));
    renderRows(list, rows.slice(0, 12), ([what, node]) => {
      const item = document.createElement('li');
      item.append(`${what} ${node.kind}: `, labelElement(node.label));
      return item;
    });
  } catch {
    if (generation === roomGeneration) list.replaceChildren(textElement('li', 'The changes could not be loaded.', 'room-note'));
  }
}

function renderUpdates(room) {
  const updates = room.newerGraphs ?? [];
  const generation = roomGeneration;
  renderRows(roomUpdates, updates, update => {
    const box = document.createElement('section');
    box.className = 'room-update';
    box.setAttribute('aria-label', `Newer graph from ${update.party}`);
    // Party names are not verified: a graph from another transcript is shown, not offered.
    const who = update.sameSession ? `${update.party} has published a newer graph`
      : `A newer graph from another transcript uses the party name ${update.party}, which is not verified`;
    box.append(textElement('p', `${who} (${update.graphId.slice(0, 12)}…): ${changeSummary(update.counts)}. This room still shows the older one.`));
    const list = document.createElement('ul');
    box.append(list);
    const use = textElement('button', `Use ${update.party}'s newer graph`);
    use.type = 'button';
    use.addEventListener('click', () => {
      // Fill the form with the newer graph and the other party's graph; the person opens the room.
      const other = room.parties.find(party => party.graphId !== update.fromGraphId);
      roomGraphA.value = update.graphId;
      roomGraphB.value = other?.graphId ?? '';
      roomGraphA.focus();
    });
    if (update.sameSession) box.append(use);
    void fillUpdate(list, update, generation);
    return box;
  });
}

function renderRoom(room) {
  currentRoomId = room.id;
  renderUpdates(room);
  const parties = room.parties.map(party => party.party);
  renderRows(roomParties, room.parties, partyColumn);
  // A ledger from before P2a sends no takesChoices; its rooms take choices as before.
  const takesChoices = room.takesChoices !== false;
  renderRows(roomProposals, room.proposals, proposal => proposalRow(proposal, parties, takesChoices));
  if (!takesChoices) {
    roomProposals.prepend(textElement('li', 'This room joins graphs from two projects, so it takes no choices. Open a room within one project.', 'room-note'));
  }
  const agreed = room.proposals.filter(proposal => proposal.state === 'agreed');
  renderRows(roomAgreed, agreed, proposal => proposalSentence(proposal, 'li'));
  if (!agreed.length) roomAgreed.append(textElement('li', 'Nothing agreed yet.', 'room-note'));
  if (!room.proposals.length) roomProposals.append(textElement('li', 'These graphs have no links to each other yet.', 'room-note'));
  roomView.hidden = false;
  roomStatus.textContent = `Room ${room.id.slice(0, 12)}… · ${room.proposals.length} ${room.proposals.length === 1 ? 'proposal' : 'proposals'}`;
}

function closeRoom(message) {
  currentRoomId = undefined;
  roomView.hidden = true;
  if (location.hash.startsWith('#room=')) history.replaceState(null, '', location.pathname + location.search);
  roomStatus.textContent = message;
}

async function loadRoom(id) {
  const generation = ++roomGeneration;
  roomStatus.textContent = 'Opening room…';
  try {
    const { room } = await request(`/api/rooms/${encodeURIComponent(id)}`);
    if (generation === roomGeneration) renderRoom(room);
  } catch (error) {
    if (generation === roomGeneration) closeRoom(`Unable to open room. ${error.message}`);
  }
}

function setChoiceButtons(disabled) {
  for (const button of roomProposals.querySelectorAll('.choice-button')) button.disabled = disabled;
}

// One decision at a time: the buttons stay disabled until the server answers, so the
// last click a person makes is the one that is stored and shown.
async function decide(proposalId, party, choice) {
  if (deciding) return;
  deciding = true;
  setChoiceButtons(true);
  const roomId = currentRoomId;
  const generation = roomGeneration;
  let message;
  try {
    const { room } = await request(`/api/rooms/${roomId}/decisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposalId, party, choice }),
    });
    deciding = false;
    // The person may have opened another room while this decision was in flight.
    if (generation !== roomGeneration) return;
    renderRoom(room);
    message = `Recorded ${party}: ${choice}.`;
  } catch (error) {
    if (generation !== roomGeneration) return;
    message = `Decision failed. ${error.message}`;
  } finally {
    deciding = false;
    setChoiceButtons(false);
  }
  roomStatus.textContent = message;
  // Re-rendering replaced the clicked button; return keyboard focus to its successor.
  roomProposals.querySelector(`li[data-proposal="${proposalId}"] button[data-party="${party}"][data-choice="${choice}"]`)?.focus();
}

roomForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  // One open at a time: a second Enter while the first request is pending does nothing.
  if (openingRoom) return;
  openingRoom = true;
  roomSubmit.disabled = true;
  const generation = ++roomGeneration;
  roomStatus.textContent = 'Opening room…';
  try {
    const { room } = await request('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ graphIds: [roomGraphA.value.trim(), roomGraphB.value.trim()] }),
    });
    if (generation !== roomGeneration) return;
    history.replaceState(null, '', `#room=${room.id}`);
    renderRoom(room);
  } catch (error) {
    if (generation === roomGeneration) closeRoom(`Unable to open room. ${error.message}`);
  } finally {
    openingRoom = false;
    roomSubmit.disabled = false;
  }
});

const hashRoom = location.hash.match(/^#room=([a-f0-9]{64})$/u)?.[1];
if (hashRoom) void loadRoom(hashRoom);
