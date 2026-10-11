// Headers on every WebUI response: no framing by other sites (clickjacking), no inline
// script, no MIME sniffing. See docs/ARCHITECTURE.md (Network exposure).

const COMMON: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  // Not no-referrer: isOwnNavigation (docs-links.ts) falls back to Referer on old Safari.
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
};

// data: = key previews; streamdeck: = the hidden-iframe deeplink (ui-helpers.ts deeplink()).
const APP_CSP = [
  "default-src 'self'",
  `script-src 'self' ${__UI_SCRIPT_HASHES__}`,
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self' streamdeck:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

// A standalone page with inline script, style and onclick.
const REQUIREMENTS_CSP = "object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

// Moved from pairing-qr.tsx: nothing leaves the frame except postMessage.
// The frame is the same origin (SAMEORIGIN), so it may load while the app page itself is not framable.
const QR_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' https://cdn.jsdelivr.net",
  "connect-src 'none'",
  "img-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
  // Opened top-level, the page must not run in the WebUI origin either.
  'sandbox allow-scripts',
].join('; ');

export function securityHeaders(pathname: string): Record<string, string> {
  if (pathname === '/qr-sandbox') {
    return { ...COMMON, 'X-Frame-Options': 'SAMEORIGIN', 'Content-Security-Policy': QR_CSP };
  }
  const csp = pathname === '/requirements' ? REQUIREMENTS_CSP : APP_CSP;
  return { ...COMMON, 'Content-Security-Policy': csp };
}

// A handler that sets its own policy (the /go/docs no-referrer redirect) keeps it.
export function withSecurityHeaders(res: Response, pathname: string): Response {
  for (const [name, value] of Object.entries(securityHeaders(pathname))) {
    if (!res.headers.has(name)) res.headers.set(name, value);
  }
  return res;
}
