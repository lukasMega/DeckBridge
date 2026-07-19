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

Individual visits are never stored as rows, so a single page view cannot be reconstructed.

## Visitor & session counting

To count visitors and sessions **without cookies**, your browser keeps a random,
non-personal id in `localStorage`. It never leaves the browser — only a "first visit
today" / "new session" flag is sent, never the id. Clearing browser storage resets it.

## Opting out

The beacon is a plain image request. Block it with any content blocker, disable
JavaScript for this site, or clear `localStorage` — the docs work fully either way. No
consent banner is needed, since nothing personal is stored locally or server-side.
