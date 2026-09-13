import { startDocsServer, type DocsServer } from '../helpers/docs-server.js';
import { test as browserTest } from './browser.js';

/** One `docusaurus serve` of docs-site/build per worker. */
// `{}` is Playwright's own spelling for "adds no test-scoped fixtures" — see fixtures/app.ts.
export const test = browserTest.extend<{}, { docs: DocsServer }>({
  docs: [
    async ({}, use) => {
      const server = await startDocsServer();
      await use(server);
      await server.stop();
    },
    { scope: 'worker' },
  ],
});

export { expect } from '@playwright/test';
