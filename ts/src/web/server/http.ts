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
export const jpeg = (body: Buffer): Response =>
  new Response(body, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' } });
