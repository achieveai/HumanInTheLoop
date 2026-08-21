import { defineConfig } from '@playwright/test';

// Mirrors client/playwright.config.ts. Port 3849 rather than the client's 3848
// so both suites can run at the same time without one killing the other's
// static server.
//
// There is deliberately no `inbox/node_modules`: `@playwright/test` and its
// browsers are already installed at `hitl-mcp-server/node_modules`, and `npx`
// walks up from the cwd to find them. Run with `npx playwright test` from this
// directory. The inbox is *not* an npm workspace — `version-sync.test.ts` pins
// the root `workspaces` array to exactly `['server', 'client']`.
export default defineConfig({
  testDir: './tests',
  // Refreshes the webview assets shared with client/src before anything runs.
  // See tests/global-setup.ts.
  globalSetup: './tests/global-setup.ts',
  timeout: 15_000,
  use: {
    baseURL: 'http://127.0.0.1:3849',
  },
  webServer: {
    command: 'npx http-server src -p 3849 -c-1 --cors -s',
    port: 3849,
    reuseExistingServer: !process.env.CI,
  },
});
