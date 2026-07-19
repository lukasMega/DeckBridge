// DeckBridge docs analytics collector — Deno Deploy (console.deno.com).
// Cookieless, no IP, no fingerprint → no consent banner. See README.md.

const kv = await Deno.openKv();
const today = () => new Date().toISOString().slice(0, 10);
const BOT = /bot|crawl|spider|preview|monitor/i;

// 1×1 transparent gif (43 bytes)
const GIF = Uint8Array.from(
  atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"),
  (c) => c.charCodeAt(0),
);
const gif = () =>
  new Response(GIF, {
    headers: { "content-type": "image/gif", "cache-control": "no-store" },
  });

const DASHBOARD = new URL("./dashboard.html", import.meta.url);

function parseUA(ua: string): { browser: string; os: string; device: string } {
  const browser =
    /Edg\//.test(ua)              ? "Edge"
    : /OPR\/|Opera/.test(ua)      ? "Opera"
    : /Firefox\//.test(ua)        ? "Firefox"
    : /Chrome\//.test(ua)         ? "Chrome"
    : /Safari\//.test(ua)         ? "Safari"
    : "Other";
  const os =
    /Windows/.test(ua)            ? "Windows"
    : /iPhone|iPad|iPod/.test(ua) ? "iOS"
    : /Android/.test(ua)          ? "Android"
    : /Mac OS X/.test(ua)         ? "macOS"
    : /Linux/.test(ua)            ? "Linux"
    : "Other";
  const device =
    /iPad|Tablet/i.test(ua)              ? "tablet"
    : /Mobi|Android|iPhone|iPod/i.test(ua) ? "mobile"
    : "desktop";
  return { browser, os, device };
}

// constant-time-ish string compare for the stats token
function eq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function readStats(day: string) {
  const out: Record<string, Record<string, number>> = {};
  // .sum() stores Deno.KvU64 (bigint wrapper) — count is at .value.value
  for await (const row of kv.list<Deno.KvU64>({ prefix: ["c", day] })) {
    const [, , dim, value] = row.key as [string, string, string, string];
    (out[dim] ??= {})[value] = Number(row.value.value);
  }
  return out;
}

const RETENTION_DAYS = 400;

// Caps unbounded KV growth — must be registered at module top level (before
// Deno.serve) or Deno Deploy skips it.
Deno.cron("prune old analytics", "0 3 * * *", async () => {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - RETENTION_DAYS);
  const cutoffDay = cutoff.toISOString().slice(0, 10);
  for await (const row of kv.list({ prefix: ["c"] })) {
    const day = row.key[1] as string;
    if (day < cutoffDay) await kv.delete(row.key);
  }
});

Deno.serve(async (req) => {
  const url = new URL(req.url);

  // --- beacon ingest ---
  if (req.method === "GET" && url.pathname === "/e") {
    const ua = req.headers.get("user-agent") ?? "";
    if (BOT.test(ua)) return gif();

    let host = "unknown";
    try {
      host = new URL(req.headers.get("referer") ?? "").origin;
    } catch { /* no/invalid referer */ }

    // opaque token: base64(encodeURIComponent(JSON)) — mirror the client encoding
    let d: Record<string, string> = {};
    try {
      d = JSON.parse(decodeURIComponent(atob(url.searchParams.get("v") ?? "")));
    } catch { /* ignore malformed */ }

    const { browser, os, device } = parseUA(ua);
    const day = today();

    const isEvent = !!d.ev;
    let dims: [string, string][];
    if (isEvent) {
      dims = [["event", d.ev]];
      if (d.t) dims.push(["event_target", d.t]);
    } else {
      const lang = (d.l ?? "").split("-")[0] || "unknown";
      dims = [
        ["pv", "_"],
        ["path", d.p ?? "/"],
        ["host", d.h ?? host],
        ["ref", d.r ?? "direct"],
        ["lang", lang],
        ["tz", d.tz ?? "unknown"],
        ["browser", browser],
        ["os", os],
        ["device", device],
      ];
      if (d.vw) dims.push(["viewport", d.vw]);
      if (d.us) dims.push(["utm_source", d.us]);
      if (d.um) dims.push(["utm_medium", d.um]);
      if (d.uc) dims.push(["utm_campaign", d.uc]);
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
    const token = url.searchParams.get("token") ?? "";
    const want = Deno.env.get("STATS_TOKEN") ?? "";
    if (!want || !eq(token, want)) {
      return new Response("unauthorized", { status: 401 });
    }

    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    if (from && to) {
      const wantSeries = !!url.searchParams.get("series");
      // merge an inclusive day range into one accumulator
      const out: Record<string, Record<string, number>> = {};
      const series: [string, number][] = [];
      for (let day = from; day <= to; day = nextDay(day)) {
        const part = await readStats(day);
        for (const dim in part) {
          for (const v in part[dim]) {
            (out[dim] ??= {})[v] = (out[dim][v] ?? 0) + part[dim][v];
          }
        }
        if (wantSeries) series.push([day, part.pv?._ ?? 0]);
      }
      if (wantSeries) return Response.json({ from, to, series, ...out });
      return Response.json({ from, to, ...out });
    }

    const day = url.searchParams.get("day") ?? today();
    return Response.json({ day, ...await readStats(day) });
  }

  // --- manual test dashboard (dev tool; harmless on Deploy) ---
  if (req.method === "GET" && url.pathname === "/dashboard") {
    return new Response(await Deno.readTextFile(DASHBOARD), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  return new Response("ok");
});

function nextDay(day: string): string {
  const d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
