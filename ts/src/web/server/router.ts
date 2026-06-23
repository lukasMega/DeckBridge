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
