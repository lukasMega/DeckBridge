# docs-analytics — Deno Deploy collector

Cookieless pageview collector for the DeckBridge docs site. No cookies, no IP
storage, no fingerprint → **no consent banner**. Stores daily aggregate counts
in Deno KV. Runs on the **new** Deno Deploy (`console.deno.com`).

## Files

| file             | what                                                     |
|------------------|----------------------------------------------------------|
| `main.ts`        | collector: `GET /e?v=…`, `GET /stats`, `GET /dashboard`  |
| `main_test.ts`   | round-trip tests over in-memory KV (`deno task test`)    |
| `dashboard.html` | manual test UI, served at `/dashboard`                   |
| `uPlot.*`        | vendored uPlot js+css (flat, sibling of `main.ts` — see below), served at `/vendor/*` |
| `deno.json`      | tasks + `unstable: [kv, cron]`                            |

## Local run (real KV, SQLite-backed)

```bash
deno task dev            # http://localhost:8000  (STATS_TOKEN=devtoken)
```

Then open **http://localhost:8000/dashboard** — this is the same code that
deploys. Send a beacon (or "Seed 30 random"), then Load stats (token `devtoken`).

Set a different token: `STATS_TOKEN=xyz deno task dev`.

## Endpoints

- **`GET /e?v=<base64>`** — beacon, sent as a 1×1 gif-pixel image request (adblock
  resilience). `v = base64(encodeURIComponent(JSON.stringify({p,r,l,ls,tz})))`;
  fields: `p` path, `r` referrer host, `l` language, `ls` languages, `tz` IANA
  timezone. Bland `/e` path + opaque `v` token dodge EasyPrivacy's generic
  `/i.gif?` pixel rule. Browser/OS derived from the request `user-agent` header
  **server-side** (client UA ignored). Bots
  (`/bot|crawl|spider|preview|monitor/i`) skipped. → **1×1 gif** (`image/gif`).
- **`GET /stats?day=YYYY-MM-DD`** — JSON counts. Auth via
  `Authorization: Bearer <token>` (dashboard — keeps the secret out of access
  logs) **or** `?token=…` (curl convenience). `day` defaults to today (UTC).
  Range: `&from=YYYY-MM-DD&to=YYYY-MM-DD` (inclusive) merges into totals; days
  are read in parallel. Add `&series=1` to also get a per-day series
  (`series: [[day, pv, uv, sessions], …]`) for the multi-line trend chart.
  **401** on bad/missing token.
- **`GET /dashboard`** — the test UI (period selector, uPlot trend chart, KPI tiles,
  breakdowns, CSV export). `GET /vendor/uPlot.iife.min.js` + `/vendor/uPlot.min.css`
  serve the **vendored** uPlot (no CDN dependency). Deploy caveat: the asset files
  live **flat** beside `main.ts` (not in a subdir) and are read with
  `Deno.readTextFile` — Deno Deploy bundles sibling new-URL files but skips subdirs
  and ignores `with { type: "text" }` at runtime. `GET /` — `ok`.

## Data model (Deno KV)

`key = ["c", day, dim, value]`, `value = bigint` via `kv.atomic().sum(key, 1n)`,
one atomic commit per hit. Dims are counted **independently** (no co-occurrence →
no cross-dim segmentation).

**Pageview** (`d.ev` absent) always writes 10 dims: `pv`, `path`, `host`, `ref`,
`lang`, `tz`, `browser`, `os`, `device`, `hour` (UTC hour, `00`–`23`). Plus, only
when present: `country` (server-side, **only if** a fronting CDN sets a country
header like `cf-ipcountry` — bare Deno Deploy exposes no visitor geo, so this dim
just never fires; no IP is ever read or stored), and from the beacon `viewport`,
`utm_source`, `utm_medium`, `utm_campaign`, plus the localStorage-derived flags
`uv` (first hit of day), `sessions` (new session), `bounce` (prior session had 1
pageview). Every stored value is clamped to 128 chars so a hostile/buggy client
can't inflate KV cost. **Event** (`d.ev` set) writes only `event` + `event_target`
and does **not** increment `pv`.

Write-budget: free tier ≈ 300K write units/mo ÷ 10 base dims ≈ **~30K pageviews/mo**
(fewer once optional dims fire). A top-level `Deno.cron` prunes days older than
400 (stops at the first in-range day — cost is O(days pruned), not a full scan).

## curl smoke test

```bash
BASE=http://localhost:8000                 # or https://stats.<yourdomain>

V=$(deno eval 'console.log(btoa(encodeURIComponent(JSON.stringify(
  {p:"/docs/intro",r:"google.com",l:"de-DE",ls:"de",tz:"Europe/Berlin"}))))')

curl -i "$BASE/e?v=$V" \
  -H 'user-agent: Mozilla/5.0 (Windows NT 10.0) Firefox/126.0'
# → 200 image/gif;  Firefox / Windows / de  (custom UA tests parseUA — the browser can't)

curl -s "$BASE/stats?token=devtoken" | jq .
```

## Deploy (new Deno Deploy — `console.deno.com`)

1. From this dir: `deno deploy` (follow prompts) — or link the GitHub repo in
   `console.deno.com`, point at `main.ts`, leave build command empty (plain TS,
   no build). **Do not** use `deployctl` — that's Deploy Classic only
   (shuts down 2026-07-20).
2. **Databases → Provision Database → Deno KV**, then **Assign** to the app. KV
   is not auto-provisioned; without this `Deno.openKv()` fails.
3. **Settings → Environment Variables**: set `STATS_TOKEN` to a long random
   secret.
4. **Settings → Domains**: add `stats.<yourdomain>` + the shown DNS record.
   First-party → stays off adblock filter lists.

## Retention (optional)

Add a top-level `Deno.cron` (before `Deno.serve`) to prune old days — must be
registered at module top level or Deploy won't pick it up.
