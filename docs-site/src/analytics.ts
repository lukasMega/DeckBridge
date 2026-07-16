import ExecutionEnvironment from '@docusaurus/ExecutionEnvironment';

const ENDPOINT = 'https://tst.lukasmega.deno.net/e';

function track(pathname: string): void {
  if (!navigator.onLine) return; // offline: skip → no failed request/row/log

  // One opaque base64 token — no pixel filename, no readable param names
  // (p/r/l/ls/tz), so EasyPrivacy generic pixel rules (e.g. `/i.gif?`) don't match.
  // encodeURIComponent first → btoa is UTF-8-safe for non-Latin1 paths.
  const v = btoa(
    encodeURIComponent(
      JSON.stringify({
        p: pathname,
        h: location.origin,
        r: document.referrer ? new URL(document.referrer).host : '',
        l: navigator.language,
        ls: (navigator.languages || []).join(','),
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
    ),
  );
  const q = new URLSearchParams({ v }); // percent-encodes +/= for the query

  // GET as image → resource type `image`, dodges $ping/$xhr filter rules.
  // Server replies with a 1×1 gif.
  const img = new Image();
  img.onerror = () => {}; // silence JS-level noise (not the browser console log)
  img.src = `${ENDPOINT}?${q}`;
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
  // fires on first load (previousLocation === null) AND every SPA navigation
  if (location.pathname !== previousLocation?.pathname) {
    track(location.pathname);
  }
}
