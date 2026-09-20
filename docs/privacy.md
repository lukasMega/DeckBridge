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

The binary makes two outbound network calls on its own, both on by default and each
with its own independent opt-out. Neither sends a machine id, a device serial, a file
path, or anything about what you press.

A **release-update check**. Every 24h (and once ~30s after startup) it runs one
unauthenticated `GET` to `api.github.com/repos/lukasMega/DeckBridge/releases/latest`,
carrying only a `User-Agent: DeckBridge/<version>` header. The result (a version
string + release URL) is cached in `settings.json` so a restart doesn't repeat the
request. Turn it off with the **Check for updates** toggle in Settings, or by setting
`"updateCheck": false` in `settings.json`.

A **daily usage ping**, on its own timer (first one 5 minutes after startup — see
below for why). One request per UTC day, carrying six things:

- **OS family** — `macos` / `windows` / `linux`.
- **OS major version** — `windows-11`, `macos-26`, `ubuntu-24.04`. Never the patch level.
- **DeckBridge version**.
- **Connected deck model ids**, or `none`.
- **Country locale hint** — `pl-PL` or `en-GB`, from OS language and region settings,
  falling back to the WebUI browser's own language if the OS setting can't be read.
  This is not physical location or IP geolocation; unavailable locales are `unknown`.
- **UTC offset** — `UTC+02:00`. The offset, never the named timezone.

The collector stores aggregate counters only: no row per install, no visitor id,
nothing to join two days' pings together. The only local state is `a7sDay`, the UTC day
of the last ping, which never leaves the machine. Turn it off with `"a7s": false` in
`settings.json` — a separate switch from the update check.

### When DeckBridge does not ping at all

Independently of the setting above, the ping is skipped outright when any of these
holds (`ts/src/daily-ping-env.ts` is the whole rule, in one file):

- **You turned it off at the command line or in the environment** —
  `--no-daily-ping`, `DECKBRIDGE_NO_DAILY_PING=1`, or the cross-tool convention
  `DO_NOT_TRACK=1`.
- **Mock mode** — `DECKBRIDGE_MOCK` set. No real device means no real user.
- **An automated environment** — `CI`, `GITHUB_ACTIONS`, `GITLAB_CI`, `JENKINS_URL`
  and a dozen similar markers. (`CI=false` and `CI=` do not count as set.)
- **The app has been running for less than 5 minutes.** This one exists so that
  malware-analysis sandboxes — VirusTotal and friends, which run a binary for a
  couple of minutes — never produce a network request at all. It also means a very
  short session is never counted.

So the first ping of a session comes no earlier than 5 minutes after start, on its
own timer rather than the update check's. A skipped ping leaves `a7sDay` untouched, so
a CI job or a sandbox run cannot consume the day's ping for a real machine.
`deckbridge diagnose` reports the current verdict on the `(daily-ping)` line of the
environment section.

Everything else it records stays on your machine, under the cache directory described
in [Troubleshooting](./troubleshooting.md).

One thing to know before sharing: the **diagnostics report** you can generate for a bug
report includes your `settings.json` verbatim — which means your extra-key shell
commands, plugin arguments and local file paths. But bug reports are public, so skim
the report before posting it, or omit the commands with
`./deckbridge diagnose --redact-commands` / the **Hide my commands** checkbox in the web
UI. The report's first line repeats this reminder.
