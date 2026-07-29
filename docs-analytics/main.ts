// DeckBridge docs analytics collector — Deno Deploy (console.deno.com).
// Cookieless, no IP, no fingerprint → no consent banner. See README.md.
//
// Structure: pure helpers + a `createHandler(kv)` factory are exported for
// tests; the live server (Deno.serve) and prune cron only run when this module
// is the entrypoint (import.meta.main) — which it is on Deploy, so the cron
// still registers at module top level there.

// Deno resolves npm: specifiers straight off npm's ESM build — verified against
// isbot 5.2.1 (`index.mjs` via its `exports` map), so no build step is needed
// on Deno Deploy. If a future Deploy runtime ever fails to resolve this at
// deploy time, fall back to vendoring isbot's exported `list` + `createIsbotFromList`.
import { isbot, isbotMatch } from "npm:isbot@5";

const today = () => new Date().toISOString().slice(0, 10);

// 1×1 transparent gif (43 bytes)
const GIF = Uint8Array.from(
  atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"),
  (c) => c.charCodeAt(0),
);
const gif = () =>
  new Response(GIF, {
    headers: { "content-type": "image/gif", "cache-control": "no-store" },
  });

// Read as sibling files of main.ts. Deno Deploy bundles new-URL-referenced files
// that sit next to the entrypoint (dashboard.html works this way) but NOT ones in
// a subdir, and it ignores `with { type: "text" }` imports at runtime — so keep
// the uPlot assets flat in this dir, not under vendor/.
const DASHBOARD = new URL("./dashboard.html", import.meta.url);
const UPLOT_JS = new URL("./uPlot.iife.min.js", import.meta.url);
const UPLOT_CSS = new URL("./uPlot.min.css", import.meta.url);

// Cap any dimension value so a hostile/buggy client can't blow up KV storage or
// write-unit cost with megabyte strings.
const MAXLEN = 128;
const clamp = (s: string) => (s.length > MAXLEN ? s.slice(0, MAXLEN) : s);

export function parseUA(
  ua: string,
): { browser: string; os: string; device: string } {
  // Order matters: Edge/Opera/Samsung all carry "Chrome" in their UA, so match
  // the more specific brand first. Brave hides as plain Chrome (by design).
  const browser =
    /Edg\//.test(ua)                    ? "Edge"
    : /OPR\/|Opera/.test(ua)            ? "Opera"
    : /SamsungBrowser/.test(ua)         ? "Samsung Internet"
    : /Vivaldi/.test(ua)                ? "Vivaldi"
    : /Firefox\//.test(ua)              ? "Firefox"
    : /Chrome\//.test(ua)               ? "Chrome"
    : /Safari\//.test(ua)               ? "Safari"
    : "Other";
  const os =
    /Windows/.test(ua)                  ? "Windows"
    : /iPhone|iPad|iPod/.test(ua)       ? "iOS"
    : /Android/.test(ua)                ? "Android"
    : /Mac OS X/.test(ua)               ? "macOS"
    : /Linux/.test(ua)                  ? "Linux"
    : "Other";
  const device =
    /iPad|Tablet/i.test(ua)                  ? "tablet"
    : /Mobi|Android|iPhone|iPod/i.test(ua)   ? "mobile"
    : "desktop";
  return { browser, os, device };
}

// constant-time-ish string compare for the stats token
export function eq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// Referrer hosts we can classify. Matched against the registrable-ish tail of the
// host (leading `www.` stripped), so `www.google.co.uk` and `news.google.com` both
// land in `search`. Anything unmatched is a plain `referral`.
const SEARCH =
  /(^|\.)(google\.[a-z.]+|bing\.com|duckduckgo\.com|search\.brave\.com|yahoo\.[a-z.]+|yandex\.[a-z.]+|baidu\.com|ecosia\.org|startpage\.com|qwant\.com|searx\.[a-z.]+|kagi\.com|naver\.com|seznam\.cz|ask\.com|perplexity\.ai)$/i;
const SOCIAL =
  /(^|\.)(twitter\.com|x\.com|t\.co|facebook\.com|fb\.com|instagram\.com|linkedin\.com|lnkd\.in|reddit\.com|out\.reddit\.com|youtube\.com|youtu\.be|news\.ycombinator\.com|lobste\.rs|bsky\.app|threads\.net|mastodon\.[a-z.]+|discord\.com|t\.me|tiktok\.com|pinterest\.[a-z.]+|vk\.com)$/i;

// Bucket a referrer host into search / social / internal / direct / referral.
// Classified at ingest (server-side) so the grouping is consistent and survives
// CSV export, instead of being re-derived per dashboard render.
export function refGroup(ref: string, self: string): string {
  const host = ref.replace(/^www\./i, "").toLowerCase();
  if (!host || host === "direct") return "direct";
  if (SEARCH.test(host)) return "search";
  if (SOCIAL.test(host)) return "social";
  // `self` is the beacon's own origin (`location.origin`) or a bare host — compare
  // hosts so a full-page reload inside the docs site isn't counted as acquisition.
  let selfHost = self.replace(/^www\./i, "").toLowerCase();
  try {
    selfHost = new URL(self).host.replace(/^www\./i, "").toLowerCase();
  } catch { /* already a bare host */ }
  if (selfHost && host === selfHost) return "internal";
  return "referral";
}

// Best-effort visitor country: only present if a fronting CDN/proxy sets a
// country header (e.g. Cloudflare `cf-ipcountry`). Deno Deploy itself does not
// expose visitor geo, so on a bare deploy this dim simply never fires — no PII,
// no IP ever read or stored.
function country(req: Request): string | null {
  const c = req.headers.get("cf-ipcountry") ??
    req.headers.get("x-vercel-ip-country") ??
    req.headers.get("x-country-code");
  if (!c || c === "XX" || c.length > 3) return null;
  return c.toUpperCase();
}

export async function readStats(kv: Deno.Kv, day: string) {
  const out: Record<string, Record<string, number>> = {};
  // .sum() stores Deno.KvU64 (bigint wrapper) — count is at .value.value
  for await (const row of kv.list<Deno.KvU64>({ prefix: ["c", day] })) {
    const [, , dim, value] = row.key as [string, string, string, string];
    (out[dim] ??= {})[value] = Number(row.value.value);
  }
  return out;
}

function nextDay(day: string): string {
  const d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// Extract the stats token from either `Authorization: Bearer <t>` (dashboard —
// keeps the secret out of access logs) or `?token=` (curl convenience).
function statsToken(req: Request, url: URL): string {
  const auth = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m ? m[1] : (url.searchParams.get("token") ?? "");
}

// Serve a static asset file. On a read failure return a readable 404 instead of
// letting Deploy swallow it into an opaque 500 (which is what made this hard to
// debug the first time around).
async function asset(u: URL, type: string): Promise<Response> {
  try {
    return new Response(await Deno.readTextFile(u), {
      headers: {
        "content-type": `${type}; charset=utf-8`,
        "cache-control": "public, max-age=86400",
      },
    });
  } catch (e) {
    return new Response(`asset unavailable: ${e instanceof Error ? e.message : e}`, {
      status: 404,
    });
  }
}

export function createHandler(kv: Deno.Kv) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);

    // --- beacon ingest ---
    if (req.method === "GET" && url.pathname === "/e") {
      const ua = req.headers.get("user-agent") ?? "";
      // Count instead of silently dropping: `bot` is the total, `bot_kind` is which
      // isbot pattern fired, so the filter is tunable against real traffic instead
      // of guesswork. Still a 200 gif, still no `pv` — visitor-visible behavior is
      // unchanged. Bots reaching `/e` at all are rare (the beacon needs JS + DOM,
      // so curl/wget/classic crawlers never get here), so 2 extra write units per
      // hit is noise against the pageview budget.
      if (isbot(ua)) {
        const match = isbotMatch(ua) ?? "unknown";
        await kv.atomic()
          .sum(["c", today(), "bot", "ua"], 1n)
          .sum(["c", today(), "bot_kind", clamp(match)], 1n)
          .commit();
        return gif();
      }

      let host = "unknown";
      try {
        host = new URL(req.headers.get("referer") ?? "").origin;
      } catch { /* no/invalid referer */ }

      // opaque token: base64(encodeURIComponent(JSON)) — mirror client encoding
      let d: Record<string, string> = {};
      try {
        d = JSON.parse(decodeURIComponent(atob(url.searchParams.get("v") ?? "")));
      } catch { /* ignore malformed */ }

      const { browser, os, device } = parseUA(ua);
      // one clock read for day/hour/dow — otherwise a hit landing on the midnight
      // boundary could be filed under one day but carry the next day's hour.
      const now = new Date();
      const day = now.toISOString().slice(0, 10);

      const isEvent = !!d.ev;
      let dims: [string, string][];
      if (isEvent) {
        const ev = clamp(d.ev);
        // The behavioral probe rides the same beacon shape as a download/outbound
        // click, but its verdict is not a user action — give it its own dims so
        // `event`/`event_target` stay a list of real interactions. Without this
        // split, `event_target` interleaves latency buckets with filenames and
        // outbound hosts, and `hi` (≈1 per pageview) squashes the download/outbound
        // bars, which scale against the largest count in the dim.
        if (ev === "hi") {
          // one dim, not two: the bucket IS the value → 1 write unit, not 2
          dims = [["hi", clamp(d.t ?? "unknown")]];
        } else if (ev === "bot") {
          // same `bot` dim as the UA check, keyed by how it was caught:
          // "ua" (isbot matched the header) vs "synthetic" (untrusted DOM event)
          dims = [["bot", "synthetic"]];
        } else {
          dims = [["event", ev]];
          if (d.t) dims.push(["event_target", clamp(d.t)]);
        }
      } else {
        const lang = (d.l ?? "").split("-")[0] || "unknown";
        const hour = String(now.getUTCHours()).padStart(2, "0");
        const dow = String(now.getUTCDay()); // 0=Sun … 6=Sat, UTC
        // `||` not `??`: the client sends r:"" (empty string) for direct traffic.
        const ref = clamp(d.r || "direct");
        dims = [
          ["pv", "_"],
          ["path", clamp(d.p ?? "/")],
          ["host", clamp(d.h ?? host)],
          ["ref", ref],
          ["ref_group", refGroup(ref, d.h ?? host)],
          ["lang", clamp(lang)],
          ["tz", clamp(d.tz ?? "unknown")],
          ["browser", browser],
          ["os", os],
          ["device", device],
          ["hour", hour],
          // The ONE pairwise key in the schema: a true day×hour joint counter.
          // `dow` and `hour` alone are independent marginals — combining them
          // client-side would fabricate an outer product, not real co-occurrence.
          // Per-day `dow` bars are recoverable by summing this dim over hours.
          ["dowhour", `${dow}-${hour}`],
        ];
        const cc = country(req);
        if (cc) dims.push(["country", cc]);
        if (d.vw) dims.push(["viewport", clamp(d.vw)]);
        if (d.us) dims.push(["utm_source", clamp(d.us)]);
        if (d.um) dims.push(["utm_medium", clamp(d.um)]);
        if (d.uc) dims.push(["utm_campaign", clamp(d.uc)]);
        if (d.u === "1") dims.push(["uv", "_"]);
        if (d.s === "1") dims.push(["sessions", "_"]);
        if (d.b === "1") dims.push(["bounce", "_"]);
      }

      let tx = kv.atomic();
      for (const [dim, value] of dims) tx = tx.sum(["c", day, dim, value], 1n);
      await tx.commit();
      return gif();
    }

    // --- dashboard JSON ---
    if (req.method === "GET" && url.pathname === "/stats") {
      const token = statsToken(req, url);
      const want = Deno.env.get("STATS_TOKEN") ?? "";
      if (!want || !eq(token, want)) {
        return new Response("unauthorized", { status: 401 });
      }

      const from = url.searchParams.get("from");
      const to = url.searchParams.get("to");
      if (from && to) {
        const wantSeries = !!url.searchParams.get("series");
        // build the inclusive day list, then read all days in parallel
        const days: string[] = [];
        for (let day = from; day <= to; day = nextDay(day)) days.push(day);
        const parts = await Promise.all(days.map((day) => readStats(kv, day)));

        const out: Record<string, Record<string, number>> = {};
        // series rows: [day, pv, uv, sessions] — powers the multi-line trend
        const series: [string, number, number, number][] = [];
        for (let i = 0; i < days.length; i++) {
          const part = parts[i];
          for (const dim in part) {
            for (const v in part[dim]) {
              (out[dim] ??= {})[v] = (out[dim][v] ?? 0) + part[dim][v];
            }
          }
          if (wantSeries) {
            series.push([
              days[i],
              part.pv?._ ?? 0,
              part.uv?._ ?? 0,
              part.sessions?._ ?? 0,
            ]);
          }
        }
        if (wantSeries) return Response.json({ from, to, series, ...out });
        return Response.json({ from, to, ...out });
      }

      const day = url.searchParams.get("day") ?? today();
      return Response.json({ day, ...await readStats(kv, day) });
    }

    // --- vendored uPlot (served locally — no CDN dependency) ---
    if (req.method === "GET" && url.pathname === "/vendor/uPlot.iife.min.js") {
      return await asset(UPLOT_JS, "text/javascript");
    }
    if (req.method === "GET" && url.pathname === "/vendor/uPlot.min.css") {
      return await asset(UPLOT_CSS, "text/css");
    }

    // --- manual test dashboard (dev tool; harmless on Deploy) ---
    if (req.method === "GET" && url.pathname === "/dashboard") {
      return new Response(await Deno.readTextFile(DASHBOARD), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    return new Response("ok");
  };
}

const RETENTION_DAYS = 400;

// Registers the prune cron + live server. Only runs when this module is the
// entrypoint — on Deno Deploy that's the case, so the cron still registers at
// module top level (required or Deploy skips it). Skipped when imported by tests.
if (import.meta.main) {
  const kv = await Deno.openKv();

  // Caps unbounded KV growth. Scans forward from the tracked oldest day instead
  // of listing every key, so cost is O(days pruned), not O(all rows).
  Deno.cron("prune old analytics", "0 3 * * *", async () => {
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - RETENTION_DAYS);
    const cutoffDay = cutoff.toISOString().slice(0, 10);
    for await (const row of kv.list({ prefix: ["c"] })) {
      const day = row.key[1] as string;
      if (day < cutoffDay) await kv.delete(row.key);
      else break; // keys sort by day → first in-range day means we're done
    }
  });

  Deno.serve(createHandler(kv));
}
