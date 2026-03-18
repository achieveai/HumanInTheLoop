import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 15_000,
  use: {
    baseURL: 'http://127.0.0.1:3848',
  },
  webServer: {
    command: 'npx http-server src -p 3848 -c-1 --cors -s',
    port: 3848,
    reuseExistingServer: !process.env.CI,
  },
});
