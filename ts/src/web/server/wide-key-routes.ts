// /api/wide-key: the SELECTED dock's info window (Ulanzi D200 wide key).
import { json } from './http.js';
import { get, postJson } from './router.js';
import type { Route } from './router.js';
import type { ReqError } from './types.js';
import type { WideKeyView } from '../../shared/types.js';

function respond(result: WideKeyView | ReqError): Response {
  return 'error' in result ? json({ error: result.error }, result.status) : json(result);
}

export const wideKeyRoutes: Route[] = [
  get('/api/wide-key', ({ wideKey }) => respond(wideKey.view())),
  postJson<unknown>('/api/wide-key', (body, { wideKey }) => respond(wideKey.trySet(body))),
];
