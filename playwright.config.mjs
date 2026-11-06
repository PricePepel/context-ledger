import { defineConfig } from '@playwright/test';

const port = 4318;
const baseURL = `http://127.0.0.1:${port}`;

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
      CONTEXT_LEDGER_DB: `.context-ledger/e2e-${process.pid}.sqlite`,
    },
  },
});
