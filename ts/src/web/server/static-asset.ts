// Serves the static files embedded as gzip bytes (build.mjs, virtual:web-assets): the stored
// bytes go out as-is with Content-Encoding, so a request costs no compression and no JS-string
// copy of the text. Over a LAN/phone link that is what shortens the page load.
import type { EmbeddedAsset } from 'virtual:web-assets';

const decoded = new WeakMap<EmbeddedAsset, Uint8Array<ArrayBuffer>>();

/** Decoded once per asset: the latin1 string stays in the bundle, the bytes live only if served. */
function gzipBytes(asset: EmbeddedAsset): Uint8Array<ArrayBuffer> {
  let bytes = decoded.get(asset);
  if (!bytes) {
    bytes = new Uint8Array(asset.data.length);
    for (let i = 0; i < bytes.length; i++) bytes[i] = asset.data.charCodeAt(i);
    decoded.set(asset, bytes);
  }
  return bytes;
}

/** A missing header gets the inflated body (not "anything goes"): curl and probes read text. */
function acceptsGzip(accept: string | null): boolean {
  for (const token of (accept ?? '').split(',')) {
    const [name, ...params] = token.split(';').map((part) => part.trim().toLowerCase());
    if (name !== 'gzip' && name !== '*') continue;
    return !params.includes('q=0') && !params.includes('q=0.0');
  }
  return false;
}

/** If-None-Match is a list; a weak tag matches too (RFC 9110 8.8.3.2). */
function etagMatches(header: string | null, etag: string): boolean {
  if (header === null) return false;
  return header.split(',').some((tag) => {
    const value = tag.trim();
    return value === '*' || value.replace(/^W\//, '') === etag;
  });
}

export interface StaticAssetOptions {
  /** Default `no-cache`: always revalidate, the ETag makes that a 304. */
  cacheControl?: string;
  headers?: Record<string, string>;
}

export function staticAsset(
  req: Request,
  asset: EmbeddedAsset,
  contentType: string,
  { cacheControl = 'no-cache', headers = {} }: StaticAssetOptions = {},
): Response | Promise<Response> {
  const gzip = acceptsGzip(req.headers.get('Accept-Encoding'));
  // Each coding is its own representation, so each gets its own validator.
  const etag = `"${asset.etag}${gzip ? '' : '-id'}"`;
  const validators = {
    ...headers,
    'Cache-Control': cacheControl,
    ETag: etag,
    Vary: 'Accept-Encoding',
  };
  if (etagMatches(req.headers.get('If-None-Match'), etag)) {
    return new Response(null, { status: 304, headers: validators });
  }
  const bytes = gzipBytes(asset);
  if (gzip) {
    return new Response(bytes, {
      headers: { ...validators, 'Content-Type': contentType, 'Content-Encoding': 'gzip' },
    });
  }
  return inflate(bytes).then(
    (body) => new Response(body, { headers: { ...validators, 'Content-Type': contentType } }),
  );
}

function inflate(bytes: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}
