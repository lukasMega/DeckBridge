import { startAppServer, type AppServer } from '../helpers/app-server.js';
import { test as browserTest } from './browser.js';

/**
 * One DeckBridge instance per worker. The app project runs with `workers: 1` because the
 * CORA ports it binds (5343/5344) are hardcoded — two instances cannot coexist.
 */
// `{}` is Playwright's own spelling for "adds no test-scoped fixtures"; Record<string, never>
// would make every inherited fixture's type collapse to never.
export const test = browserTest.extend<{}, { app: AppServer }>({
  app: [
    async ({}, use) => {
      const server = await startAppServer();
      await use(server);
      await server.stop();
    },
    { scope: 'worker' },
  ],
});

export { expect } from '@playwright/test';
