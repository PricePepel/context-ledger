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
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`);
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
    if (focusHeading) readerHeading.focus();
  } catch (error) {
    if (signal.aborted) return;
    selectedId = undefined;
    renderSelection();
    readerHeading.textContent = 'Unable to open transcript';
    readerStatus.textContent = error.message;
  }
}

importForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const file = transcriptFile.files[0];
  if (!file || importButton.disabled) return;
  if (file.size >= maxImportBytes) {
    importStatus.textContent = 'Import failed. Choose a transcript smaller than 8 MiB.';
    return;
  }
  const provider = sourceAgent.value;
  const readerAtImport = readerRequest;
  importButton.disabled = true;
  importStatus.textContent = 'Importing transcript…';

  try {
    const { session } = await request('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, source: file.name, transcript: await file.text() }),
    });
    if (transcriptFile.files[0] === file) transcriptFile.value = '';
    importStatus.textContent = `Imported ${session.source}.`;
    const refresh = search();
    if (readerRequest === readerAtImport) await openTranscript(session.id);
    await refresh;
  } catch (error) {
    importStatus.textContent = `Import failed. ${error.message}`;
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
const roomProposals = document.querySelector('#room-proposals');
const roomAgreed = document.querySelector('#room-agreed');
const linkVerbs = { matches: 'matches', conflicts: 'conflicts with', answers: 'answers' };
let currentRoomId;

function nodeSummary(endpoint) {
  return `${endpoint.party} · ${endpoint.kind} “${endpoint.label}”`;
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
    const detail = [node.kind, node.status, node.to && `to ${node.to}`].filter(Boolean).join(' · ');
    item.append(textElement('span', detail, 'node-kind'), textElement('span', node.label, 'node-label'));
    return item;
  });
  column.append(list);
  return column;
}

function proposalRow(proposal, parties) {
  const item = document.createElement('li');
  item.dataset.proposal = proposal.id;
  item.dataset.state = proposal.state;
  const sentence = `${nodeSummary(proposal.from)} ${linkVerbs[proposal.type]} ${nodeSummary(proposal.to)}`;
  item.append(
    textElement('p', sentence, 'proposal-text'),
    textElement('p', `State: ${proposal.state}`, 'proposal-state'),
  );
  const actions = document.createElement('div');
  actions.className = 'proposal-actions';
  for (const party of parties) {
    const group = document.createElement('div');
    group.className = 'choice-group';
    const made = proposal.choices[party];
    group.append(textElement('span', `${party}: ${made ?? 'undecided'}`, 'choice-made'));
    for (const choice of ['confirm', 'reject']) {
      const button = textElement('button', `${choice === 'confirm' ? 'Confirm' : 'Reject'} as ${party}`, 'choice-button');
      button.type = 'button';
      button.setAttribute('aria-pressed', String(made === choice));
      button.addEventListener('click', () => decide(proposal.id, party, choice));
      group.append(button);
    }
    actions.append(group);
  }
  item.append(actions);
  return item;
}

function renderRoom(room) {
  currentRoomId = room.id;
  const parties = room.parties.map(party => party.party);
  renderRows(roomParties, room.parties, partyColumn);
  renderRows(roomProposals, room.proposals, proposal => proposalRow(proposal, parties));
  const agreed = room.proposals.filter(proposal => proposal.state === 'agreed');
  renderRows(roomAgreed, agreed, proposal => textElement('li',
    `${nodeSummary(proposal.from)} ${linkVerbs[proposal.type]} ${nodeSummary(proposal.to)}`));
  if (!agreed.length) roomAgreed.append(textElement('li', 'Nothing agreed yet.', 'room-note'));
  if (!room.proposals.length) roomProposals.append(textElement('li', 'These graphs have no links to each other yet.', 'room-note'));
  roomView.hidden = false;
  roomStatus.textContent = `Room ${room.id.slice(0, 12)}… · ${room.proposals.length} ${room.proposals.length === 1 ? 'proposal' : 'proposals'}`;
}

async function loadRoom(id) {
  roomStatus.textContent = 'Opening room…';
  try {
    const { room } = await request(`/api/rooms/${encodeURIComponent(id)}`);
    renderRoom(room);
  } catch (error) {
    roomView.hidden = true;
    roomStatus.textContent = `Unable to open room. ${error.message}`;
  }
}

async function decide(proposalId, party, choice) {
  try {
    const { room } = await request(`/api/rooms/${currentRoomId}/decisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposalId, party, choice }),
    });
    renderRoom(room);
    roomStatus.textContent = `Recorded ${party}: ${choice}.`;
  } catch (error) {
    roomStatus.textContent = `Decision failed. ${error.message}`;
  }
}

roomForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  roomStatus.textContent = 'Opening room…';
  try {
    const { room } = await request('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ graphIds: [roomGraphA.value.trim(), roomGraphB.value.trim()] }),
    });
    history.replaceState(null, '', `#room=${room.id}`);
    renderRoom(room);
  } catch (error) {
    roomView.hidden = true;
    roomStatus.textContent = `Unable to open room. ${error.message}`;
  }
});

const hashRoom = location.hash.match(/^#room=([a-f0-9]{64})$/u)?.[1];
if (hashRoom) void loadRoom(hashRoom);
