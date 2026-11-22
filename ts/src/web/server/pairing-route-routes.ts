import type { PairingRoute, PairingRouteRequest } from '../contract-pairing-route.js';
import { badRequest, json, notFound } from './http.js';
import { get, post, postJson, type Route } from './router.js';

// A Record so adding a route to the contract union fails to compile until it is listed here.
const ROUTES: Record<PairingRoute, true> = {
  none: true,
  downgrade: true,
  wsl: true,
  device: true,
  container: true,
  orbstack: true,
};

function isPairingRoute(v: unknown): v is PairingRoute {
  return typeof v === 'string' && Object.hasOwn(ROUTES, v);
}

export const pairingRouteRoutes: Route[] = [
  get('/api/pairing-route', ({ pairingRoute }) => json(pairingRoute.status())),
  postJson<Partial<PairingRouteRequest>>('/api/pairing-route', async (body, { pairingRoute }) => {
    if (!isPairingRoute(body.route)) return badRequest('route must be a known pairing route');
    return json(await pairingRoute.setRoute(body.route));
  }),
  post('/api/pairing-route/dismiss', ({ pairingRoute }) => json(pairingRoute.dismiss())),
  get('/api/pairing-route/command', async ({ pairingRoute, url }) => {
    const kind = url.searchParams.get('kind');
    if (kind !== 'curl' && kind !== 'wget' && kind !== 'node') {
      return badRequest('kind must be curl, wget or node');
    }
    const command = await pairingRoute.command(kind);
    // No script route selected, or no LAN address: nothing to run.
    return command === null ? notFound() : json({ command });
  }),
  get('/api/pairing-route/probe', async ({ pairingRoute }) => json(await pairingRoute.probe())),
];
