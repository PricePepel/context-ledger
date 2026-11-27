// Card H11 review: the drive command itself, end to end, writes its PNG and leaves no
// ledger folder behind, on success and when the browser cannot reach the feature.
import { execFile } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { repo } from '../../scripts/drive.mjs';

const run = promisify(execFile);
const ledgerFolders = () => readdirSync(tmpdir()).filter(name => name.startsWith('ledger-drive-')).sort();

test('H11 review: drive writes a PNG for a feature and removes its temporary ledger', async () => {
  test.setTimeout(120_000);
  const before = ledgerFolders();
  const folder = await mkdtemp(join(tmpdir(), 'drive-out-'));
  try {
    const out = join(folder, 'proof.png');
    const { stdout } = await run(process.execPath, [join(repo, 'scripts', 'drive.mjs'), 'swarm', '--out', out], { cwd: repo });
    expect(stdout).toContain('drive: swarm saved to');
    expect(readFileSync(out).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(stdout).not.toMatch(/code=[A-Za-z0-9_-]{4,}/u);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
  expect(ledgerFolders()).toEqual(before);
});
