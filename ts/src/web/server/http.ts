// Response constructors — keep every handler free of `new Response(JSON.stringify(...))` noise.

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

export const badRequest = (error: string): Response => json({ error }, 400);
export const noContent = (): Response => new Response(null, { status: 204 });
export const notFound = (): Response => new Response(null, { status: 404 });
export const forbidden = (): Response => new Response('Forbidden', { status: 403 });

export const html = (body: string): Response =>
  new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
export const css = (body: string): Response =>
  new Response(body, { headers: { 'Content-Type': 'text/css' } });
export const js = (body: string): Response =>
  new Response(body, { headers: { 'Content-Type': 'application/javascript' } });
/** Plain text, no-store — the diagnostics report (a fresh snapshot every time). */
export const text = (body: string): Response =>
  new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
export const jpeg = (body: Buffer): Response =>
  new Response(body, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' } });

export type ParsedBody<T> = { body: T } | { error: Response };

/** Parse a request body as JSON, or hand back the 400 response to return as-is. */
export async function readJson<T>(req: Request, message = 'invalid JSON'): Promise<ParsedBody<T>> {
  try {
    const body = JSON.parse(await req.text()) as T | null;
    return body === null ? { error: badRequest(message) } : { body };
  } catch {
    return { error: badRequest(message) };
  }
}
