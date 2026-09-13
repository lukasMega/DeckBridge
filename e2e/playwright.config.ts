import { defineConfig } from '@playwright/test';

/**
 * Two independent suites, one runtime: `app` (Web UI from the real bundle in mock mode)
 * and `docs` (built Docusaurus site). Servers live in fixtures/app.ts + fixtures/docs.ts
 * rather than in `webServer`, so a missing build or an occupied CORA port produces a
 * named error instead of a generic start-up timeout.
 */
export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',
  fullyParallel: false,
  // CORA ports 5343/5344 are hardcoded, so only one DeckBridge can run at a time; the
  // docs suite is fast enough that a second worker would not pay for the extra
  // `docusaurus serve` process.
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  projects: [
    { name: 'app', testDir: './tests/app' },
    { name: 'docs', testDir: './tests/docs' },
  ],
});
