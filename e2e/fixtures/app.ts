import type { APIRequestContext } from '@playwright/test';
import { startAppServer, type AppServer } from '../helpers/app-server.js';
import { test as browserTest } from './browser.js';

/**
 * One DeckBridge instance per worker. The app project runs with `workers: 1` because the
 * CORA ports it binds (5343/5344) are hardcoded — two instances cannot coexist.
 */
// `{}` is Playwright's own spelling for "adds no test-scoped fixtures"; Record<string, never>
// would make every inherited fixture's type collapse to never.
export const test = browserTest.extend<{}, { app: AppServer; workerRequest: APIRequestContext }>({
  app: [
    async ({}, use) => {
      const server = await startAppServer();
      await use(server);
      await server.stop();
    },
    { scope: 'worker' },
  ],
  // `request` is test-scoped, so beforeAll/afterAll hooks (which restore the shared
  // instance between describe blocks) use this one.
  workerRequest: [
    async ({ playwright }, use) => {
      const ctx = await playwright.request.newContext();
      await use(ctx);
      await ctx.dispose();
    },
    { scope: 'worker' },
  ],
});

export { expect } from '@playwright/test';
export { api, getState, useDevice, waitForDriver, waitForState } from '../helpers/api.js';
export type { ApiResult, AppState } from '../helpers/api.js';
export { connectElgato, type ElgatoClient } from '../helpers/cora-client.js';
export {
  DEVICES,
  DEFAULT_DEVICE,
  PLAIN_DEVICES,
  PLUS_PROFILE,
  device,
} from '../helpers/devices.js';
export type { DeviceCase } from '../helpers/devices.js';
export {
  deviceEntry,
  dock0,
  getSettings,
  resetOverride,
  restoreSettings,
  setOverride,
} from '../helpers/state.js';
export type { DeviceEntry, DockState, SettingsJson } from '../helpers/state.js';
export { Marker } from '../helpers/marker.js';
export { nextFrame, type WsFrame } from '../helpers/ws.js';
