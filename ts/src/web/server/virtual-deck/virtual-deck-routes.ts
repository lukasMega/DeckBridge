// Admin routes of the browser deck (the loopback WebUI only; the deck listener has its own).
import { json, noContent } from '../http.js';
import { get, post, postJson, type Route } from '../router.js';

export const virtualDeckRoutes: Route[] = [
  get('/api/virtual-deck', ({ virtualDeck }) => json(virtualDeck.state())),
  postJson<{ enabled?: unknown; profile?: unknown }>(
    '/api/virtual-deck',
    (body, { virtualDeck }) => {
      const r = virtualDeck.setConfig(body);
      return 'error' in r ? json({ error: r.error }, r.status) : json(r);
    },
  ),
  post('/api/virtual-deck/pairing', ({ virtualDeck }) => {
    const r = virtualDeck.createPairing();
    return 'error' in r ? json({ error: r.error }, r.status) : json(r);
  }),
  post('/api/virtual-deck/pairing/cancel', ({ virtualDeck }) => {
    virtualDeck.cancelPairing();
    return noContent();
  }),
  postJson<{ id?: unknown }>('/api/virtual-deck/revoke', (body, { virtualDeck }) => {
    const err =
      typeof body.id === 'string'
        ? virtualDeck.revoke(body.id)
        : { status: 400, error: 'id required' };
    return err ? json({ error: err.error }, err.status) : noContent();
  }),
  post('/api/virtual-deck/revoke-all', ({ virtualDeck }) =>
    json({ revoked: virtualDeck.revokeAll() }),
  ),
];
