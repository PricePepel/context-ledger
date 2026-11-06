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
