import { readJson } from './http.js';
import type { WebUIController } from './types.js';

export interface RouteContext {
  req: Request;
  url: URL;
  params: Record<string, string>;
  ui: WebUIController;
}

export type RouteHandler = (ctx: RouteContext) => Response | Promise<Response>;

export interface Route {
  method: string;
  segments: string[];
  handler: RouteHandler;
}

function route(method: string, path: string, handler: RouteHandler): Route {
  return { method, segments: path.split('/').filter(Boolean), handler };
}

export const get = (path: string, handler: RouteHandler): Route => route('GET', path, handler);
export const post = (path: string, handler: RouteHandler): Route => route('POST', path, handler);

/** `post`, with the JSON body already parsed — a parse failure short-circuits to 400.
 *  T exists only to be inferred from `handler`, so each route's body type flows in. */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- see above
export const postJson = <T>(
  path: string,
  handler: (body: T, ctx: RouteContext) => Response | Promise<Response>,
  message?: string,
): Route =>
  post(path, async (ctx) => {
    const parsed = await readJson<T>(ctx.req, message);
    return 'error' in parsed ? parsed.error : handler(parsed.body, ctx);
  });

export interface RouteMatch {
  handler: RouteHandler;
  params: Record<string, string>;
}

/** First route whose method and segment pattern match; `:name` segments capture into params. */
export function matchRoute(routes: Route[], method: string, pathname: string): RouteMatch | null {
  const parts = pathname.split('/').filter(Boolean);
  for (const r of routes) {
    if (r.method !== method || r.segments.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let matched = true;
    for (let i = 0; i < r.segments.length; i++) {
      const seg = r.segments[i]!;
      if (seg.startsWith(':')) params[seg.slice(1)] = parts[i]!;
      else if (seg !== parts[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return { handler: r.handler, params };
  }
  return null;
}
