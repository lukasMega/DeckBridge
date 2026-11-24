---
sidebar_position: 9
sidebar_label: Privacy
title: Privacy & Analytics
slug: /privacy
description: What this docs site measures — cookieless, first-party, no personal data sold or shared.
---

# Privacy & Analytics

This site uses **first-party, self-hosted analytics**: no cookies, no stored IPs, no
fingerprinting, no third-party trackers, nothing sold or shared. Site data is daily totals
only, so we cannot identify you. In-app survey answers are stored one by one (see below).

## What is measured

Per page view, stored only as running daily counts:

- **Page path** and **referrer host** (e.g. `google.com`), not the full URL.
- **Browser, OS, device type** from the User-Agent. No version fingerprint.
- **Language** and **timezone**, as a rough hint instead of IP geolocation.
- **Viewport bucket** (`<640`, `640–1024`, `>1024`).
- **Campaign tags** (`utm_source` / `utm_medium` / `utm_campaign`) when present. App links
  carry them. The page removes them from the address bar once counted.
- **Outbound-link / download clicks**: destination host or file name.
- **Any interaction**, and how soon after load, in one of three rough buckets. No mouse
  data. It only tells humans from bots.

Single visits are never stored, and no measurement can be joined to another. The
collector is open source: [deno-kv-analytics](https://github.com/lukasMega/deno-kv-analytics).

## Live demo

The docs-site demo reports the device model you tried (model id, or USB vendor/product
ids for an unknown real device), unsupported real-device mode, and connection failures
(one-word reasons). It uses the same beacon. No serial numbers, images or key presses are
sent. Nothing is sent from localhost.

## Visitor & session counting

Your browser keeps a random, non-personal id in `localStorage`. It never leaves the
browser. Only a "first visit today" / "new session" flag is sent. Clearing storage resets it.

## Opting out

The beacon is a plain image request. Block it with a content blocker, turn off JavaScript
for this site, or clear `localStorage`. The docs work either way. No consent banner is
needed, because nothing personal is stored.

## The DeckBridge app

The binary makes two automatic calls. Both are on by default, each with its own opt-out.
Neither sends a machine id, device serial, file path, or what you press.

- **Release-update check.** Every 24h (and once ~30s after startup): one unauthenticated
  `GET` to `api.github.com/repos/lukasMega/DeckBridge/releases/latest`, with only a
  `User-Agent: DeckBridge/<version>` header. The result is cached in `settings.json`.
  Turn it off with **Check for updates** in Settings, or `"updateCheck": false`. Only when
  you click **Install** does the app fetch `latest.json` and the signed update.
- **Daily usage ping.** On its own timer, first one 5 minutes after startup, then one
  request per UTC day. Turn it off with `"a7s": false` in `settings.json` (separate from
  the update check). It sends eight items:
  - **OS family**: `macos` / `windows` / `linux`.
  - **OS major version**: `windows-11`, `macos-26`, `ubuntu-24.04`. Never the patch level.
  - **DeckBridge version**.
  - **Connected deck model ids**, or `none`.
  - **Country locale hint**: `pl-PL` or `en-GB`, from OS settings (else the browser
    language, else `unknown`). Not IP geolocation.
  - **Timezone**: IANA zone such as `Europe/Bratislava`, or a UTC offset such as
    `UTC+02:00`. Never saved in settings.
  - **Elgato Stream Deck app version**, e.g. `7.6.0`, from the default install path
    (macOS/Windows). Left out if not installed.
  - **Docs topics opened from the WebUI** since the last ping: names only (e.g.
    `push-api`), no count or time. Not recorded while the ping is off.

The collector keeps aggregate counters only: no row per install, no visitor id, nothing to
join two days. Local state is only `a7sDay` (UTC day of the last ping, never sent) and the
topics waiting for the next ping.

The **Statistics** [extension](./extensions.md), if you install it, counts presses,
images, and reconnects for the session. The numbers stay in memory, reset on restart, and
are never sent.

<details>
<summary>When DeckBridge does not ping at all</summary>

The ping is skipped when any of these is true (`ts/src/infra/daily-ping-env.ts` has the
whole rule):

- **You turned it off**: `--no-daily-ping`, `DECKBRIDGE_NO_DAILY_PING=1`, or `DO_NOT_TRACK=1`.
- **Development mock mode**: `DECKBRIDGE_MOCK` in a mock build. Release builds have no mock.
- **An automated environment**: `CI`, `GITHUB_ACTIONS`, `GITLAB_CI`, `JENKINS_URL` and a
  dozen similar markers. (`CI=false` and `CI=` do not count.)
- **Running for less than 5 minutes.** This keeps malware sandboxes (VirusTotal and
  similar run a binary for a couple of minutes) from making any request.

A skipped ping leaves `a7sDay` untouched, so a CI job or sandbox cannot use up a real
machine's daily ping. `deckbridge diagnose` shows the verdict on the `(daily-ping)` line.

</details>

### Optional feedback survey

A third call happens only when you press **Send** in the feedback survey (Settings →
Maintenance → **Give feedback**, About, or the footer **Feedback** link). Every question is
optional. **What gets sent** shows the exact JSON first. Nothing leaves before Send.

Unlike the ping, each response is **stored as one row** by the same collector. Rows have no
IP, install id, device serial, device key, paths, commands, locale or timezone. Please put
no personal information in text fields.

<details>
<summary>Survey details</summary>

The body has the survey version, ids of the questions shown, your answers, an optional
comment (max 280 characters), DeckBridge version, OS family and major version, and
connected model ids. If you pick **Other**, a description is required: max 300 characters
in **What do you use it for?**, max 100 in **How did you find DeckBridge?**, **What bothers
you most?**, **What should come next?** and **Would you support DeckBridge?**.

Ping opt-outs do not block the survey: pressing Send is consent. Mock mode never sends. A
draft (answers, text, step) stays in your browser's local storage, is deleted after a send
or 30 days, and is never sent. The app saves only the survey version and submission date,
a 30-day snooze, or **Don't ask again**. The Ready screen may show a feedback prompt seven
days after first pairing, once per survey version.

</details>

Everything else stays on your machine, in the cache directory described in
[Troubleshooting](./troubleshooting.md).

**Before you share a diagnostics report:** it includes your `settings.json` verbatim,
with extra-key shell commands, plugin arguments and local paths. Bug reports are public,
so skim it first. Or omit the commands with `./deckbridge diagnose --redact-commands` or
the **Hide my commands** checkbox in the web UI. The report's first line repeats this.
