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
  **server-side** (client UA ignored). Bots are detected via
  [`npm:isbot`](https://github.com/omrilotan/isbot) (covers the JS-capable set a
  hand-rolled UA regex misses — headless Chromium, `Chrome-Lighthouse`, AI
  crawlers like GPTBot/ClaudeBot/PerplexityBot, `facebookexternalhit`, …) and
  **counted, not silently dropped** — see `bot`/`bot_kind` below — then served
  the same → **1×1 gif** (`image/gif`).
- **`GET /stats?day=YYYY-MM-DD`** — JSON counts. Auth via
  `Authorization: Bearer <token>` (dashboard — keeps the secret out of access
  logs) **or** `?token=…` (curl convenience). `day` defaults to today (UTC).
  Range: `&from=YYYY-MM-DD&to=YYYY-MM-DD` (inclusive) merges into totals; days
  are read in parallel. Add `&series=1` to also get a per-day series
  (`series: [[day, pv, uv, sessions], …]`) for the multi-line trend chart.
  **401** on bad/missing token.
- **`GET /dashboard`** — the test UI (period selector, uPlot trend chart, KPI tiles,
  day×hour heatmap, breakdowns, CSV export). `GET /vendor/uPlot.iife.min.js` + `/vendor/uPlot.min.css`
  serve the **vendored** uPlot (no CDN dependency). Deploy caveat: the asset files
  live **flat** beside `main.ts` (not in a subdir) and are read with
  `Deno.readTextFile` — Deno Deploy bundles sibling new-URL files but skips subdirs
  and ignores `with { type: "text" }` at runtime. `GET /` — `ok`.

## Data model (Deno KV)

`key = ["c", day, dim, value]`, `value = bigint` via `kv.atomic().sum(key, 1n)`,
one atomic commit per hit. Dims are counted **independently** (no co-occurrence →
no cross-dim segmentation), with exactly one deliberate exception: `dowhour`.

**Pageview** (`d.ev` absent) always writes 12 dims: `pv`, `path`, `host`, `ref`,
`ref_group`, `lang`, `tz`, `browser`, `os`, `device`, `hour` (UTC hour, `00`–`23`),
`dowhour`. Plus, only
when present: `country` (server-side, **only if** a fronting CDN sets a country
header like `cf-ipcountry` — bare Deno Deploy exposes no visitor geo, so this dim
just never fires; no IP is ever read or stored), and from the beacon `viewport`,
`utm_source`, `utm_medium`, `utm_campaign`, plus the localStorage-derived flags
`uv` (first hit of day), `sessions` (new session), `bounce` (prior session had 1
pageview). Every stored value is clamped to 128 chars so a hostile/buggy client
can't inflate KV cost. **Event** (`d.ev` set) writes only `event` + `event_target`
and does **not** increment `pv`.

**Bot traffic** never reaches the pageview path: a hit whose UA matches `isbot`
writes `bot["ua"]` (a running total) and `bot_kind[<match>]` (which isbot
pattern fired, e.g. `Googlebot`, `facebookexternalhit` — bounded cardinality,
same 128-char clamp as every other dim) instead of `pv`, then returns the same
gif so behavior is unchanged for the caller. This makes the filter tunable
against real traffic (compare `bot`/`bot_kind` counts over time) instead of
guesswork, and replaces the old approach of dropping bot hits with no signal
at all.

**Behavioral probe**: the client arms a one-shot listener set
(`pointerdown`/`keydown`/`touchstart`/`wheel`/`scroll`/`mousemove`, all
`{ passive: true, once: true }`) right after the pageview beacon fires. The
first of those to land reports a verdict as a normal event beacon: `event=hi`
with `event_target` bucketed from beacon-to-interaction latency (`<150`,
`150-2000`, `>2000`), or — if `event.isTrusted === false`, i.e. a script called
`dispatchEvent` rather than a real user acting — `event=bot`,
`event_target=synthetic`. **Nothing beyond that verdict leaves the browser**:
no coordinates, no movement deltas, no event trace, and nothing is written to
`localStorage`. `mousemove` is in the trigger set purely for its `isTrusted`
bit, not for tracking motion. The pageview beacon itself is never delayed or
gated on this — it still fires immediately for every visitor, mouse or no
mouse. Because the verdict lands on the existing `event`/`event_target` dims,
it can't be joined against `path`, `country`, or anything else, which is what
keeps this inside the no-consent-banner claim (see the privacy note in the
implementation plan for the full reasoning). Read it as a daily trend
(`1 − event.hi / pv` = share of pageviews with no observed human interaction),
not a per-hit verdict — a real visitor can legitimately bounce before touching
anything.

`day`, `hour` and `dowhour` all come from **one** clock read per hit, so a request
landing on the midnight boundary can't be filed under one day carrying the next
day's hour.

### `ref_group` — referrer bucketing

`ref_group` classifies the referrer host **server-side at ingest** into
`search` / `social` / `internal` / `direct` / `referral`, so the grouping is
consistent and lands in the CSV export instead of being re-derived per dashboard
render. `internal` is a referrer whose host equals the beacon's own origin (a
full-page reload inside the docs site), which keeps it out of the acquisition
numbers. The client sends `r: ""` for direct traffic; that is normalized to
`direct` (not stored as an empty key).

### `dowhour` — the one pairwise dim

`dowhour` stores `"<dow>-<hh>"` (dow `0`=Sun…`6`=Sat UTC, 168 possible values) —
a **true day×hour joint counter**, which is what the dashboard heatmap renders.
This is the schema's only pairwise key and it is intentional: `dow` and `hour` as
separate independent counters are *marginals*, and multiplying them into a grid
would fabricate an outer product rather than show real co-occurrence. Storing the
joint key directly costs the same 1 extra write unit as a standalone `dow` dim
would, so the honest version is free. Per-weekday totals are recovered by summing
`dowhour` over hours — no separate `dow` dim exists.

**Non-goal: user-flow Sankey.** A multi-hop flow diagram needs per-visitor page
sequences, which requires a cookie or fingerprint — that would break the
no-consent-banner model, so it will not be built. The degenerate 1-hop version
(pairwise `ref_group → landing page`) is just a grouped bar chart bent into
ribbons and isn't worth its write cost either.

Write-budget: free tier ≈ 300K write units/mo ÷ 12 base pageview dims ≈
**~25K pageviews/mo** for a pageview that sees no interaction. Most pageviews
also arm the behavioral probe (above), which — if it fires — is a *second*
beacon costing 2 more write units (`event` + `event_target`), so budget for
engaged traffic is closer to 300K ÷ 14 ≈ **~21K pv/mo**; bounces that never
trigger the probe stay at the ~25K figure. (Bot hits cost 2 write units each
but don't compete with the pv budget — they never write `pv`.) A top-level
`Deno.cron` prunes days older than 400 (stops at the first in-range day — cost
is O(days pruned), not a full scan).

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
