// Card P1c: times the schema version 3 upgrade on a large synthetic version 2 ledger
// (docs/evals.md, "P1c", review of PR #45). Synthetic text only; the file is deleted at the end.
//
//   node evals/migration/v3-upgrade.mjs [--sessions 2000] [--messages 200] [--keep]
//
// The version 2 file is a new version 3 file with the messages table and its trigger dropped
// and user_version set to 2, which is exactly the version 2 schema. Sessions are inserted with
// the JSON the store writes. A second process opens the file while the upgrade runs, to show
// whether it waits or fails on the 5 s busy_timeout.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { openStore } from '../../src/store.mjs';

const { values } = parseArgs({ options: {
  sessions: { type: 'string', default: '2000' },
  messages: { type: 'string', default: '200' },
  keep: { type: 'boolean', default: false },
} });
const sessionCount = Number(values.sessions);
const messageCount = Number(values.messages);

// A fixed pseudo-random sequence, so every run builds the same file.
let seed = 42;
const random = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const words = ['ledger', 'orion', 'deploy', 'review', 'schema', 'session', 'graph', 'party', 'agent', 'route',
  'test', 'fixture', 'commit', 'branch', 'outline', 'rehearse', 'migrate', 'index', 'search', 'token'];
// Turn text of 20 to 1,000 characters (about 510 on average).
const turnText = () => {
  const length = 20 + Math.floor(random() * 981);
  let text = '';
  while (text.length < length) text += words[Math.floor(random() * words.length)] + ' ';
  return text.slice(0, length);
};

const directory = await mkdtemp(join(tmpdir(), 'ledger-p1c-bench-'));
const path = join(directory, 'ledger.sqlite');
try {
  openStore(path).close();
  const setup = new DatabaseSync(path);
  setup.exec('DROP TRIGGER sessions_messages; DROP TABLE messages; PRAGMA user_version = 2;');
  const project = setup.prepare("SELECT id FROM projects WHERE slug = 'default'").get().id;
  const insert = setup.prepare(`INSERT INTO sessions (id, provider, source, title, message_count, messages, search_text, project_id)
    VALUES (?, 'claude', ?, ?, ?, ?, ?, ?)`);
  const started = performance.now();
  setup.exec('BEGIN');
  let textCharacters = 0;
  for (let index = 0; index < sessionCount; index += 1) {
    const messages = [];
    for (let line = 1; line <= messageCount; line += 1) {
      const text = turnText();
      textCharacters += text.length;
      messages.push({ role: line % 2 ? 'user' : 'assistant', text, line });
    }
    const id = index.toString(16).padStart(64, '0');
    const searchText = [messages[0].text, ...messages.map(message => message.text)].join('\n');
    insert.run(id, `bench-${index}.jsonl`, messages[0].text.slice(0, 120), messageCount, JSON.stringify(messages), searchText, project);
  }
  setup.exec('COMMIT');
  setup.close();
  const built = performance.now() - started;
  const before = (await stat(path)).size;

  // The upgrade, in a child process so that this one can open the file at the same time.
  const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', `
    import { openStore } from ${JSON.stringify(new URL('../../src/store.mjs', import.meta.url).href)};
    console.log('start');
    const started = performance.now();
    openStore(${JSON.stringify(path)}).close();
    console.log(JSON.stringify({ upgradeMs: Math.round(performance.now() - started) }));
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  const closed = once(child, 'close');
  let output = '';
  let ready;
  const starting = new Promise(resolve => { ready = resolve; });
  child.stdout.on('data', chunk => {
    output += chunk;
    if (output.includes('start')) ready();
  });
  // Once the child is about to open the file, give it time to take the write lock. A child
  // that exits before that fails the run here, so the folder is still removed.
  const early = await Promise.race([starting.then(() => null), closed]);
  if (early) throw new Error(`The upgrade process exited with ${early[0]} before it started.`);
  await new Promise(resolve => setTimeout(resolve, 300));
  const second = performance.now();
  let secondOpen;
  try {
    openStore(path).close();
    secondOpen = { ok: true, ms: Math.round(performance.now() - second) };
  } catch (error) {
    secondOpen = { ok: false, ms: Math.round(performance.now() - second), error: error.message };
  }
  const [code] = await closed;
  if (code !== 0) throw new Error(`The upgrade process exited with ${code}.`);
  const { upgradeMs } = JSON.parse(output.trim().split('\n').at(-1));
  const after = (await stat(path)).size;
  const check = new DatabaseSync(path, { readOnly: true });
  const rows = check.prepare('SELECT count(*) AS n FROM messages').get().n;
  const version = check.prepare('PRAGMA user_version').get().user_version;
  check.close();
  console.log(JSON.stringify({
    sessions: sessionCount, messagesPerSession: messageCount, rows, version,
    textMiB: +(textCharacters / 2 ** 20).toFixed(1), buildMs: Math.round(built), upgradeMs,
    secondOpen, fileMiBBefore: +(before / 2 ** 20).toFixed(1), fileMiBAfter: +(after / 2 ** 20).toFixed(1),
  }, null, 2));
} finally {
  if (values.keep) console.log(`Kept ${path}`);
  else await rm(directory, { recursive: true, force: true });
}
