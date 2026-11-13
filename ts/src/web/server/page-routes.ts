// POST /api/pages/*: saved Elgato pages of the SELECTED dock (snapshot, edit, layout).
import { badRequest, json } from './http.js';
import { postJson } from './router.js';
import type { Route, RouteContext } from './router.js';
import type { ReqError } from './types.js';

type PageBody = Record<string, unknown>;

const isReqError = (result: object): result is ReqError => 'error' in result && 'status' in result;

function respond(result: object): Response {
  return isReqError(result) ? json({ error: result.error }, result.status) : json(result);
}

function pageRoute(path: string, handler: (body: PageBody, ctx: RouteContext) => object): Route {
  // A non-object body is a 400, not a crash.
  return postJson<unknown>(path, (body, ctx) =>
    typeof body === 'object' && body !== null && !Array.isArray(body)
      ? respond(handler(body as PageBody, ctx))
      : badRequest('body must be an object'),
  );
}

export const pageRoutes: Route[] = [
  pageRoute('/api/pages/snapshot', (body, { pages }) => pages.trySnapshot(body)),
  pageRoute('/api/pages/update', (body, { pages }) => pages.tryUpdate(body)),
  pageRoute('/api/pages/recapture', (body, { pages }) => pages.tryRecapture(body)),
  pageRoute('/api/pages/layout', (body, { pages }) => pages.trySetLayout(body)),
  pageRoute('/api/pages/delete', (body, { pages }) => pages.tryDelete(body)),
];
