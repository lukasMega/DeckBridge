---
sidebar_position: 3
title: Upgrading
description: How DeckBridge tells you about a new version and installs it on Windows, macOS and Linux.
---

DeckBridge checks GitHub once a day. A new release shows as a Web UI banner, the tray
item **Update available: vX**, and one system notification per version.

## Windows installer and macOS app

Click **Install vX** in the banner or **Settings → Updates**. DeckBridge downloads the
update, checks its signature, installs it, and restarts (a few seconds).

- Windows: the installer shows a small progress window. No SmartScreen prompt.
- macOS: `DeckBridge.app` is replaced in place. macOS can ask for **Input Monitoring**
  again, because each build has a new ad-hoc signature.
- If the download or signature check fails, the old version starts again.

The **Install** button appears only in the version *after* the one that added it. From an
older version, install once by hand from
[Releases](https://github.com/lukasMega/DeckBridge/releases).

## Portable zip and Linux

The banner shows **Download vX** (zip for your OS and CPU). Quit DeckBridge, unzip over
the old `deckbridge`, and start it. `settings.json` is kept.

## Turning it off

Use **Settings → Updates → Check for updates**, or set `"updateCheck": false` in
`settings.json`. Then DeckBridge never contacts GitHub, and no banner shows.
