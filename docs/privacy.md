---
sidebar_position: 9
sidebar_label: Privacy
title: Privacy & Analytics
slug: /privacy
description: What this docs site measures — cookieless, first-party, no personal data sold or shared.
---

# Privacy & Analytics

This site uses **first-party, self-hosted analytics**: no cookies, no stored IPs, no
fingerprinting, no third-party trackers, nothing sold or shared. Data is aggregate daily
counts only — we cannot identify you or follow you across sites.

## What is measured

Per page view, stored only as running daily counts:

- **Page path** and **referrer host** (e.g. `google.com`) — not the full URL.
- **Browser, OS, device type** — from the server-side User-Agent, no version fingerprint.
- **Language** and **timezone** — coarse locale hint instead of IP geolocation.
- **Viewport bucket** (`<640`, `640–1024`, `>1024`) — layout only.
- **Campaign tags** (`utm_source` / `utm_medium` / `utm_campaign`) when present.
- **Outbound-link / download clicks** — destination host or file name.
- **Whether the page saw any interaction**, and how soon after load, as one of three
  coarse buckets. No mouse coordinates, no movement, no event trace — only that a real
  (browser-trusted) interaction happened. It is used to tell humans from automation.

Individual visits are never stored as rows, so a single page view cannot be reconstructed,
and no measurement can be joined to another (e.g. page path × country).

The collector is open source and self-hosted:
[deno-kv-analytics](https://github.com/lukasMega/deno-kv-analytics).

## Visitor & session counting

To count visitors and sessions **without cookies**, your browser keeps a random,
non-personal id in `localStorage`. It never leaves the browser — only a "first visit
today" / "new session" flag is sent, never the id. Clearing browser storage resets it.

## Opting out

The beacon is a plain image request. Block it with any content blocker, disable
JavaScript for this site, or clear `localStorage` — the docs work fully either way. No
consent banner is needed, since nothing personal is stored locally or server-side.

## The DeckBridge app

The binary sends no telemetry and no beacons. It makes exactly one outbound network
call on its own: a **release-update check**, on by default. Every 24h (and once ~30s
after startup) it runs one unauthenticated `GET` to
`api.github.com/repos/lukasMega/DeckBridge/releases/latest`, carrying only a
`User-Agent: DeckBridge/<version>` header — no machine id, no usage data, nothing
else. The result (a version string + release URL) is cached in `settings.json` so a
restart doesn't repeat the request. Turn it off with the **Check for updates** toggle
in Settings, or by setting `"updateCheck": false` in `settings.json`.

Everything else it records stays on your machine, under the cache directory described
in [Troubleshooting](./troubleshooting.md).

One thing to know before sharing: the **diagnostics report** you can generate for a bug
report includes your `settings.json` verbatim — which means your extra-key shell
commands, plugin arguments and local file paths. But bug reports are public, so skim
the report before posting it, or omit the commands with
`./deckbridge diagnose --redact-commands` / the **Hide my commands** checkbox in the web
UI. The report's first line repeats this reminder.
