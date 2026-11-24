---
sidebar_position: 3
title: Upgrading
description: How DeckBridge tells you about a new version and installs it on Windows, macOS and Linux.
---

DeckBridge checks GitHub for a new release once a day. When one exists, it tells you in
three places: a banner at the top of the Web UI, the tray menu item **Update available:
vX** (click it to open the Web UI), and one system notification per version.

## Windows installer and macOS app

Click **Install vX** in the banner or in **Settings → Updates**. DeckBridge closes, downloads
the new version, checks its signature, installs it and starts again. This takes a few
seconds; the tray icon is gone during that time, and the Web UI reconnects by itself.

- Windows shows a small progress window from the installer. No SmartScreen prompt, because
  the app downloads the file itself.
- macOS replaces `DeckBridge.app` in place. macOS can ask again for **Input Monitoring**
  after an update, because each build has a new ad-hoc signature.
- If the download or signature check fails, the old version starts again.

The **Install** button first appears in the version *after* the one that added it. To get
there from an older version, install it once by hand from
[Releases](https://github.com/lukasMega/DeckBridge/releases).

## Portable zip and Linux

The banner shows **Download vX**, a direct link to the zip for your OS and CPU. Quit
DeckBridge, unzip the new `deckbridge` over the old one, and start it again. Your
`settings.json` stays where it is, so nothing else changes.

## Turning it off

**Settings → Updates → Check for updates**, or `"updateCheck": false` in `settings.json`.
With the check off, DeckBridge never contacts GitHub, so the banner and the Install button
never show.

## For maintainers: the signing key

The installer builds verify updates with a minisign key. The public half is
`plugins.updater.pubkey` in `src-tauri/tauri.conf.json`. The private half lives only in the
GitHub secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
`release.yml` fails without the secret, so a release never ships without `latest.json`.
If the private key is lost, installed apps can no longer update themselves, and users have
to reinstall by hand.
