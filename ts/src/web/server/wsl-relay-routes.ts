import type { WslRelayToggleRequest } from '../contract-wsl-relay.js';
import { badRequest, json } from './http.js';
import { get, post, postJson, type Route } from './router.js';

export const wslRelayRoutes: Route[] = [
  get('/api/wsl-relay', ({ wslRelay }) => json(wslRelay.status())),
  postJson<Partial<WslRelayToggleRequest>>('/api/wsl-relay', async (body, { wslRelay }) => {
    if (typeof body.enabled !== 'boolean') return badRequest('enabled must be a boolean');
    return json(await wslRelay.setEnabled(body.enabled));
  }),
  post('/api/wsl-relay/recheck', ({ wslRelay }) => json(wslRelay.recheck())),
];
