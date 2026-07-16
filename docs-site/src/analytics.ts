import ExecutionEnvironment from '@docusaurus/ExecutionEnvironment';

const ENDPOINT = 'https://tst.lukasmega.deno.net/e';

// Sends the opaque beacon shared by pageviews and custom events.
function send(payload: Record<string, string>): void {
  // One opaque base64 token — no pixel filename, no readable param names
  // (p/r/l/ls/tz), so EasyPrivacy generic pixel rules (e.g. `/i.gif?`) don't match.
  // encodeURIComponent first → btoa is UTF-8-safe for non-Latin1 paths.
  const v = btoa(encodeURIComponent(JSON.stringify(payload)));
  const q = new URLSearchParams({ v }); // percent-encodes +/= for the query

  // GET as image → resource type `image`, dodges $ping/$xhr filter rules.
  // Server replies with a 1×1 gif.
  const img = new Image();
  img.onerror = () => {}; // silence JS-level noise (not the browser console log)
  img.src = `${ENDPOINT}?${q}`;
}

// Visitor/session flags, deduped via localStorage (identity never leaves the browser —
// only these boolean-ish flags are sent). Private mode / storage disabled → no flags,
// pageview still sends.
function computeFlags(): Record<string, string> {
  const flags: Record<string, string> = {};
  try {
    const now = Date.now();
    const last = +(localStorage.getItem('da_last') || 0);
    const todayUTC = new Date().toISOString().slice(0, 10);
    const newSession = !localStorage.getItem('da_sid') || now - last > 30 * 60 * 1000;
    if (newSession) {
      // report whether the PRIOR session bounced (exactly 1 pageview)
      if (localStorage.getItem('da_sid') && +(localStorage.getItem('da_prevPv') || 0) === 1) flags.b = '1';
      localStorage.setItem('da_sid', Math.random().toString(36).slice(2));
      localStorage.setItem('da_prevPv', '0');
      flags.s = '1';
    }
    localStorage.setItem('da_prevPv', String(+(localStorage.getItem('da_prevPv') || 0) + 1));
    if (localStorage.getItem('da_seenDay') !== todayUTC) {
      flags.u = '1';
      localStorage.setItem('da_seenDay', todayUTC);
    }
    localStorage.setItem('da_last', String(now));
  } catch {
    // private mode / storage disabled → skip flags, still send the pageview
  }
  return flags;
}

function track(pathname: string): void {
  if (!navigator.onLine) return; // offline: skip → no failed request/row/log

  const flags = computeFlags();

  const w = window.innerWidth;
  const vw = w < 640 ? '<640' : w <= 1024 ? '640-1024' : '>1024';

  const payload: Record<string, string> = {
    p: pathname,
    h: location.origin,
    r: document.referrer ? new URL(document.referrer).host : '',
    l: navigator.language,
    ls: (navigator.languages || []).join(','),
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    vw,
    ...flags,
  };

  const search = new URLSearchParams(location.search);
  const us = search.get('utm_source');
  const um = search.get('utm_medium');
  const uc = search.get('utm_campaign');
  if (us) payload.us = us;
  if (um) payload.um = um;
  if (uc) payload.uc = uc;

  send(payload);
}

// Custom event beacon (outbound link / download click, …). No pageview fields.
export function trackEvent(ev: string, t: string): void {
  if (!navigator.onLine) return;
  send({ ev, t });
}

const DOWNLOAD_EXT = /\.(pdf|zip|dmg|exe|pkg|tar|gz|7z|mp4|csv)$/i;

let clickTrackingInstalled = false;

// One global click listener for outbound-link / download tracking. Installed once.
function installClickTracking(): void {
  if (clickTrackingInstalled) return;
  clickTrackingInstalled = true;

  document.addEventListener('click', (e: MouseEvent) => {
    if (e.button !== 0) return; // left-click only
    const target = e.target as Element | null;
    const a = target?.closest?.('a');
    if (!a || !(a instanceof HTMLAnchorElement) || !a.href) return;

    try {
      const url = new URL(a.href, location.href);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

      if (url.host !== location.host) {
        trackEvent('outbound', url.host);
        return;
      }
      if (DOWNLOAD_EXT.test(url.pathname)) {
        trackEvent('download', url.pathname.split('/').pop() || url.pathname);
      }
    } catch {
      // ignore anchors with an unparsable href
    }
  });
}

export function onRouteDidUpdate({
  location,
  previousLocation,
}: {
  location: { pathname: string };
  previousLocation: { pathname: string } | null;
}): void {
  if (process.env.NODE_ENV !== 'production') return; // dev: send nothing
  if (!ExecutionEnvironment.canUseDOM) return; // SSR/build guard

  installClickTracking();

  // fires on first load (previousLocation === null) AND every SPA navigation
  if (location.pathname !== previousLocation?.pathname) {
    track(location.pathname);
  }
}
