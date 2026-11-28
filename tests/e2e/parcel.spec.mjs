// Card R1 (ADR-19): a session received in a parcel holds only the lines a graph cites, and
// the library says so. The parcel is built from an in-memory ledger and stored with
// `ledger receive` into the database the e2e server runs on. Synthetic data only.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildParcel, serializeParcel } from '../../src/parcel.mjs';
import { openStore } from '../../src/store.mjs';
import { test, expect } from './fixtures.mjs';

const turns = [
  ['user', 'Quasar aside that the graph never cites.'],
  ['assistant', 'The Quasar relay ships on port 6100.'],
  ['user', 'Agreed, and Quasar never deploys on Sunday.'],
];
const transcript = turns.map(([role, text]) => JSON.stringify({ type: role, message: { role, content: text } })).join('\n');

test('R1: a session received from another machine is labelled as excerpts', async ({ page, request }) => {
  const sender = openStore(':memory:');
  const session = sender.importTranscript({ provider: 'claude', source: 'quasar.jsonl', transcript });
  const graph = sender.publishGraph({ version: 2, sessionId: session.id, party: 'quasar', edges: [], nodes: [
    { id: 'port', kind: 'decision', label: 'Port 6100', evidenceLines: [2] },
    { id: 'no-sunday', kind: 'constraint', label: 'No deploys on Sunday', evidenceLines: [3] },
  ] });
  const { parcel } = buildParcel(sender.getGraph(graph.id), sender.get(session.id));
  sender.close();
  const folder = mkdtempSync(join(tmpdir(), 'ledger-r1-e2e-'));
  try {
    const file = join(folder, 'quasar.parcel.json');
    writeFileSync(file, serializeParcel(parcel));
    execFileSync(process.execPath, ['src/cli.mjs', 'receive', file], { env: { ...process.env, CONTEXT_LEDGER_DB: process.env.CONTEXT_LEDGER_E2E_DB }, stdio: 'pipe' });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }

  const list = await (await request.get('/api/sessions?q=quasar')).json();
  expect(list.sessions.map(({ id, excerpts, messageCount }) => ({ id, excerpts, messageCount }))).toEqual([{ id: session.id, excerpts: true, messageCount: 2 }]);
  const detail = await (await request.get(`/api/sessions/${session.id}`)).json();
  expect(detail.session.excerpts).toBe(true);
  expect(detail.session.messages.map(message => message.line)).toEqual([2, 3]);
  expect(await (await request.get(`/api/graphs/${graph.id}`)).json()).toMatchObject({ graph: { id: graph.id } });

  await page.goto('/');
  await page.getByLabel('Search transcripts').fill('quasar');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  const row = page.getByRole('listitem').filter({ has: page.getByRole('button', { name: 'Agreed, and Quasar never deploys on Sunday.', exact: true }) });
  await expect(row).toContainText('2 messages · excerpts');
  await row.getByRole('button').click();
  await expect(page.getByText('quasar.jsonl · excerpts received from another machine')).toBeVisible();
  await expect(page.getByText('The Quasar relay ships on port 6100.')).toBeVisible();
  await expect(page.getByText('Quasar aside')).toHaveCount(0);
});
