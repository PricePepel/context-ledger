import { resolve } from 'node:path';
import { defineConfig } from '@playwright/test';

const port = 4318;
const baseURL = `http://127.0.0.1:${port}`;
// Set once in the runner and inherited by the workers, which read the server's token
// file next to this database (tests/e2e/fixtures.mjs).
const database = process.env.CONTEXT_LEDGER_E2E_DB ??= resolve(`.context-ledger/e2e-${process.pid}.sqlite`);
// The token file is per port (<database>.<port>.token), so the workers need the port too.
process.env.CONTEXT_LEDGER_E2E_PORT = String(port);

export default defineConfig({
  testDir: './tests/e2e',
  forbidOnly: Boolean(process.env.CI),
  use: {
    baseURL,
    browserName: 'chromium',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm start',
    url: baseURL,
    env: {
      PORT: String(port),
      CONTEXT_LEDGER_DB: database,
      // Card U11: an unset SWARM_URLS asks 127.0.0.1:8000; the evals expect a simulated swarm.
      SWARM_URLS: 'off',
    },
  },
});
