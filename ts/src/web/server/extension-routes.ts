// Extension routes: the list and on/off switch (Settings), each extension's own API
// (proxied to its worker) and its ui.js. See docs/extensions.md (server.js, ui.js).
import { get, post, postJson } from './router.js';
import type { Route, RouteContext } from './router.js';
import { badRequest, json, notFound } from './http.js';
import type { ExtensionRequest } from '../../extension/api.js';

/** Bodies are buffered on the main thread and cloned to a worker; extension calls are small. */
const MAX_BODY = 64 * 1024;
const tooLarge = (): Response => json({ error: `body over ${MAX_BODY} bytes` }, 413);

async function proxy({ extensions, params, req, url }: RouteContext): Promise<Response> {
  // A cross-site <img>/<script> GET has no Origin header, so the request guard passes it.
  const site = req.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin' && site !== 'none') {
    return json({ error: 'cross-site request' }, 403);
  }
  if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY) return tooLarge();
  let body: unknown;
  const raw = req.method === 'POST' ? await req.text() : '';
  if (raw.length > MAX_BODY) return tooLarge();
  if (raw !== '') {
    try {
      body = JSON.parse(raw) as unknown;
    } catch {
      return badRequest('invalid JSON');
    }
  }
  const request: ExtensionRequest = {
    method: req.method === 'POST' ? 'POST' : 'GET',
    path: params.path ?? '',
    query: Object.fromEntries(url.searchParams.entries()),
    ...(body === undefined ? {} : { body }),
  };
  const reply = await extensions.request(params.id ?? '', request);
  return new Response(reply.json, {
    status: reply.status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const extensionRoutes: Route[] = [
  get('/api/extensions', ({ extensions }) => json(extensions.view())),
  post('/api/extensions/rescan', async ({ extensions }) => {
    await extensions.rescan();
    return json(extensions.view());
  }),
  postJson('/api/extensions/enabled', async (body: { id?: unknown; enabled?: unknown }, ctx) => {
    const err = await ctx.extensions.setEnabled(body.id, body.enabled);
    return err ? json({ error: err.error }, err.status) : json(ctx.extensions.view());
  }),
  get('/api/ext/:id/:path', proxy),
  post('/api/ext/:id/:path', proxy),
  get('/ext/:id/ui.js', ({ extensions, params }) => {
    const source = extensions.uiScript(params.id ?? '');
    if (source === null) return notFound();
    return new Response(source, {
      headers: { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' },
    });
  }),
];
