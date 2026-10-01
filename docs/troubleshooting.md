---
sidebar_position: 7
sidebar_label: Troubleshooting
title: Troubleshooting & Diagnostics
slug: /troubleshooting
description: Where DeckBridge logs live, how to turn on debug logging, how to produce a diagnostics report, and how to reset device tuning.
---

# Troubleshooting & Diagnostics

Turn on debug logging, reproduce the problem, create a diagnostics report, attach it to
your issue.

## Common problems

- **Ports 5343/5344 busy** — stop a conflicting DeckBridge, Network Dock, or ESP32 bridge.
- **Elgato app will not pair another dock** — it takes one dock per IP address; see
  [one dock per IP address](./browser-deck.md#one-dock-per-ip-address).
- **Browser deck problems** — see [Browser deck → Troubleshooting](./browser-deck.md#troubleshooting).
- **No device found** — check the USB cable; on macOS grant Input Monitoring; on Linux
  install the [udev rule](./features.md#permissions).
- **Missing libhidapi** — see the [requirements check](./features.md#requirements).
- **Restrict LAN access** — set `DECKBRIDGE_BIND=127.0.0.1`.
- **Images rotated, mirrored, or on the wrong key** — see [Device tuning](#device-tuning).
- **AJAZZ AKP05E panel wedged** — unplug it, wait briefly, then reconnect. DeckBridge
  sends the full init sequence on open (`CRT VER`, then `DIS`, `LIG`, `CLE 0xff`, `STP`)
  and nothing on close; do not send other reset commands during recovery.

## Where the logs live

`deckbridge.log`, in the cache directory:

| OS | Path |
|---|---|
| macOS | `~/Library/Caches/deckbridge/logs/deckbridge.log` |
| Windows | `%LOCALAPPDATA%\deckbridge\logs\deckbridge.log` |
| Linux | `~/.cache/deckbridge/logs/deckbridge.log` (or `$XDG_CACHE_HOME/deckbridge/logs/`) |

Settings → **Logging & diagnostics** shows the path and opens the folder.
`--cache-dir <path>` moves it. Logs rotate at 2 MB, three files kept (~6 MB total).

## Turning on debug logging

Default is `info`; `debug` adds per-image, per-key and per-scan detail.

- **Web UI** — Settings → **Debug logging** (persists, covers the USB worker too)
- **CLI** — `./deckbridge --log-level debug`
- **Environment** — `DECKBRIDGE_LOG_LEVEL=debug ./deckbridge`

Levels: `debug`, `info`, `warn`, `error`, `silent`. Precedence, highest first:
`--log-level`, `$DECKBRIDGE_LOG_LEVEL`, `"logLevel"` in `settings.json` (what the web-UI
toggle writes), then the build default.

## Diagnostics report

One text file: version, platform, flags, every connected HID device, registry matches,
requirements check, active tuning, the log tail, and `settings.json`.

- **Web UI** — Settings → **Create diagnostics report**, or **Save & reveal** to write it
  to `<cache-dir>/diagnostics/`.
- **No UI** — `./deckbridge diagnose` (`--out <path>` to choose where). It starts no
  server and never opens a device, so it works when DeckBridge hangs at startup.

**Read it before posting.** It contains your `settings.json` verbatim — extra-key
commands, plugin arguments, local paths — because that is often the buggy part. To leave
commands out: `./deckbridge diagnose --redact-commands`, or tick **Hide my commands** in
the web UI. See also [Privacy](./privacy.md).

Push-API tokens appear in the report without their hashes.

## Push API errors

- **401** — missing or unknown token. Create one in Settings → Push API and send `Authorization: Bearer dbp_…`.
- **403** — the request carried a browser `Origin` header, or the token lacks the `push` scope.
- **429** — too many requests, or too many failed attempts from one address. Wait `Retry-After` seconds.
- The key shows `…` — nothing was pushed to its channel since DeckBridge started, or the value was deleted.

## Update check

DeckBridge checks GitHub for a newer release on startup and every 24h — notify only,
never a download or self-update. It sends one plain `GET` to the GitHub releases API
carrying just a `User-Agent: DeckBridge/<version>` header; see
[Privacy](./privacy.md#the-deckbridge-app) for exactly what that call sends. Turn it off
with **Settings → Check for updates**, or `"updateCheck": false` in `settings.json`. No
curl on the system (Linux minimal installs) silently disables the check — it never
blocks startup or shows an error, but the diagnostics report's **update check** section
will say so.

## Restarting the Elgato app

The Elgato Stream Deck app only re-dials network docks on launch, so a dock that appears
while the app is already running stays blank until the app is restarted. DeckBridge does
this for you automatically for a deck it has seen paired before, and always offers a
manual restart.

**"Paired before"** means the Elgato app's **child** CORA connection has attached to that
dock at least once — DeckBridge records the timestamp as `pairedAt` on the device's entry
in `settings.json` the first time that happens. It does not read the Elgato app's own
config. If you're updating from an older version, your existing decks have no `pairedAt`
yet — the auto-restart starts working after their next successful pairing.

**Automatic path**, once per DeckBridge start:

1. A dock with `pairedAt` connects over USB and the Elgato app is running **on this
   machine**. Only macOS and Windows — a remote Elgato app on another computer is out of
   reach and is left alone.
2. DeckBridge waits a grace delay (default **10 s**, configurable 3–120) for the Elgato
   app to attach to that dock by itself.
3. If it hasn't attached when the delay runs out, and nothing else disqualifies the
   restart, DeckBridge quits the Elgato app (deeplink, then a kill fallback if it doesn't
   quit in time), waits a few seconds, and launches it again.

The restart is skipped, with a one-line log explaining why, when: it already ran once
this process; the toggle is off; a dock connects that was never paired; the Elgato app
isn't running locally; every paired dock is already attached; or the Elgato app currently
holds the USB deck itself (the "Elgato conflict" state — see [Web UI
states](./features.md#web-ui-states)), since restarting it there risks it grabbing the
hardware back mid-handoff.

**Manual restart**, any time: **Settings → Elgato app → Restart Elgato app now** in the
web UI, or tray → **Restart Elgato App**. Both run the same code path, whether or not a
restart already fired automatically this session.

**Settings.** Web UI **Settings → Elgato app** has the toggle and the grace delay. The
same two values live in `settings.json`:

- `"elgatoAutoRestart": false` — turn the automatic path off (default: on, same as
  `updateCheck`). The manual restart (tray/WebUI) always works regardless of this.
- `"elgatoAutoRestartDelayS": 15` — grace delay in seconds, clamped to 3–120 (default 10).

## Device tuning

Some boards are supported from documentation, not hardware we own. **Settings → Device
tuning** fixes them at runtime:

- Rotation, flip H/V, image fit, JPEG quality and size.
- **Crop…** (next to Image fit) picks which part of the Elgato app's key image lands on
  the key: drag the region over a real key frame, then **Try on device** to see the exact
  result, **Save** to keep it or **Cancel** to go back. Useful for off-centre art or a dead
  border on one side. The same region is under Advanced as X/Y/Width/Height; leave all four
  blank for the whole image.
- **Key-map learn mode** records which raw code each physical key sends.
- **Copy overrides as JSON** — please send working values back, see
  [Adding a device](./adding-a-device.md).

Tuning is stored per model id under `modelOverrides` in `settings.json`. Image settings
(rotation, flip, fit, quality, size, sharpen/blur/crop, crop region) are swapped into the running
session and the deck repaints straight away; key-map, wire and splash changes reconnect
the device, because the driver reads those when it opens the device. If it leaves the panel dark: **Reset to defaults**, or start with
`./deckbridge run --no-overrides` to ignore all tuning for one session. Active tuning is
flagged at the top of the diagnostics report.

## Filing a good report

1. Turn on debug logging.
2. Reproduce the problem.
3. Create a diagnostics report.
4. Open an issue, attach it, say what you expected and what happened instead.

If DeckBridge **freezes**, the last line in `deckbridge.log` names the startup step it
hung on — include it even if no report could be written.

## Freezes tied to a particular USB device

If DeckBridge only hangs while some unrelated USB device (a keyboard, a headset, a
wireless dongle) is plugged in, the suspect is HID **enumeration**, not that device's
data. DeckBridge lists the connected HID interfaces to find your deck; on Windows that
listing opens every HID interface on the machine to read its name, and one device that
answers slowly holds up the whole list.

What to look for:

- The `hid enumeration (all devices, took NNNms)` heading in the diagnostics report.
  Single- or low-double-digit ms is healthy; hundreds of ms is the problem.
- `USB enumeration slow (NNNms) — device probe interval now Ns` in the log. DeckBridge
  detects this and probes less often (up to 30 s apart) so the rest of the app keeps
  running, then snaps back to every 3 s once enumeration is quick again.

Please attach the report **with the device connected** — the enumeration table names the
device DeckBridge does not recognize, which is what makes the report actionable.
