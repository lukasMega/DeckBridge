---
sidebar_position: 7
sidebar_label: Troubleshooting
title: Troubleshooting & Diagnostics
slug: /troubleshooting
description: Where DeckBridge logs live, how to turn on debug logging, how to produce a diagnostics report, and how to reset device tuning.
---

# Troubleshooting & Diagnostics

Turn on debug logging, reproduce the problem, create a diagnostics report, attach it to your issue.

## Common problems

- **Ports 5343/5344 busy** — stop any other DeckBridge, Network Dock or ESP32 bridge.
- **Web UI not on 3000** — if 3000 is busy, DeckBridge uses a free port in 33011–33099. Use tray → **Open Web UI**, or the `WebUI: http://localhost:<port>` log line. `--webui-port <n>` pins a port; startup fails if it is busy.
- **Elgato app will not pair another dock** — one dock per IP address. See [one dock per IP address](./browser-deck.md#one-dock-per-ip-address).
- **Browser deck problems** — see [Browser deck → Troubleshooting](./browser-deck.md#troubleshooting).
- **No device found** — check the USB cable. macOS: grant Input Monitoring. Linux: install the [udev rule](./features.md#permissions).
- **Deck disconnects and reconnects** — use a good USB cable, 1.5 m at most, and plug it straight into a USB port on the computer, not into an external USB hub.
- **Missing libhidapi** — see the [requirements check](./features.md#requirements).
- **Restrict LAN access** — set `DECKBRIDGE_BIND=127.0.0.1`.
- **Images rotated, mirrored, on the wrong key, cut off or black** — run the [device check](./verify-device.md), or see [Device tuning](#device-tuning).

<details>
<summary>More problems (standby, relay, D200, AKP05E)</summary>

- **First press after the deck dimmed does nothing** — by design, it only wakes the deck. Set *Wake press* to *Wakes and runs the key* in Standby & burn-in care.
- **A clock appeared on my deck** — the Elgato app was away for more than 15 s and *When the Elgato app is away* is set to the clock. Start the app again, or set the option to *Keep showing the last images*.
- **My deck went dark** — *Screen off* (idle or night) or *When the Elgato app is away: Turn the screen off* is on. Press a key or turn a knob. Brightness does not change.
- **Deck disappears from the Stream Deck app after I restart DeckBridge (relay)** — the relay holds the app's connection only for `--hold-seconds` (default 60). Restart DeckBridge within that time. If the relay log shows `hold expired`, raise `--hold-seconds` and restart the relay. Check the relay is still running. See [Restarting DeckBridge](./elgato-same-computer.md#restart).
- **Stream Deck app never connects to a relay on a Mac, relay logs nothing** — macOS blocks the app from the local network (an OrbStack machine counts too). See [Stream Deck app blocked from the local network](./elgato-same-computer.md#macos-local-network).
- **D200 info window stats read 0 or look off** — on non-English Windows the built-in sampler cannot read its counters and shows 0. On macOS, memory counts inactive cache. See [D200 info window](./plugin-widgets.md#built-in-stats-sources), or use a stats plugin.
- **AJAZZ AKP05E panel stuck** — unplug it, wait, reconnect. DeckBridge sends the full init sequence on open (`CRT VER`, then `DIS`, `LIG`, `CLE 0xff`, `STP`) and nothing on close. Do not send other reset commands.

</details>

## Live demo

- **Real device is disabled** — your browser has no WebHID. Use desktop Chrome, Edge or Opera.
- **Could not open the deck** — quit DeckBridge and the vendor app, then connect again.
- **My deck is not listed as supported** — check the [supported devices](./devices.mdx).

## Where the logs live

`deckbridge.log`, in the cache directory:

| OS | Path |
|---|---|
| macOS | `~/Library/Caches/deckbridge/logs/deckbridge.log` |
| Windows | `%LOCALAPPDATA%\deckbridge\logs\deckbridge.log` |
| Linux | `~/.cache/deckbridge/logs/deckbridge.log` (or `$XDG_CACHE_HOME/deckbridge/logs/`) |

Settings → **Logging & diagnostics** shows the path and opens the folder. `--cache-dir <path>` moves it. Logs rotate at 2 MB; three files are kept (~6 MB total).

## Turning on debug logging

The default level is `info`. `debug` adds detail for every image, key and scan.

- **Web UI** — Settings → **Debug logging** (persists, covers the USB worker too)
- **CLI** — `./deckbridge --log-level debug`
- **Environment** — `DECKBRIDGE_LOG_LEVEL=debug ./deckbridge`

Levels: `debug`, `info`, `warn`, `error`, `silent`. The first one set wins: `--log-level`, `$DECKBRIDGE_LOG_LEVEL`, `"logLevel"` in `settings.json` (what the web-UI toggle writes), then the build default.

## Diagnostics report

One text file: version, platform, flags, every connected HID device, registry matches, requirements check, active tuning, the log tail, and `settings.json`.

- **Web UI** — Settings → **Create diagnostics report**, or **Save & reveal** to write it to `<cache-dir>/diagnostics/`.
- **No UI** — `./deckbridge diagnose` (`--out <path>` to choose where). It starts no server and never opens a device, so it works when DeckBridge hangs at startup.

**Read it before you post it.** It contains your `settings.json` as is (extra-key commands, plugin arguments, local paths), because that is often the buggy part. To leave commands out, use `./deckbridge diagnose --redact-commands` or tick **Hide my commands** in the web UI. See also [Privacy](./privacy.md). Push-API tokens appear without their hashes.

## Push API errors

- **401** — token missing or unknown. Create one in Settings → Push API and send `Authorization: Bearer dbp_…`.
- **403** — the request had a browser `Origin` header, or the token lacks the `push` scope.
- **429** — too many requests, or too many failed attempts from one address. Wait `Retry-After` seconds.
- The key shows `…` — nothing was pushed to its channel since DeckBridge started, or the value was deleted.

## Update check

DeckBridge checks GitHub for a newer release at startup and every 24 hours. It never downloads anything; installing is a separate click (see [Upgrading](./upgrading.md)). Turn it off with **Settings → Check for updates** or `"updateCheck": false` in `settings.json`. It sends one plain `GET` with a `User-Agent: DeckBridge/<version>` header (see [Privacy](./privacy.md#the-deckbridge-app)). Without `curl` (minimal Linux), the check is silently off; the report's **update check** section says so.

## Daily usage ping

The [daily usage ping](./privacy.md#the-deckbridge-app) is silent by design: nothing in the UI or the default log, and failed sends are never reported. Turn it off with `"a7s": false` in `settings.json`, `--no-daily-ping`, or `DO_NOT_TRACK=1` (`"updateCheck": false` does not affect it). With [debug logging](#turning-on-debug-logging), an attempt logs `[dailyPing] payload {…}` (exactly what is sent) or `[dailyPing] suppressed (<reason>)`. No line means it is off, or today's (UTC) ping already went out. The first attempt comes 5 minutes after start.

## Restarting the Elgato app

The Elgato app only looks for network docks when it starts, so a new dock stays blank until you restart the app. DeckBridge does this automatically for a deck it has seen paired before. **Manual restart**, any time: **Settings → Elgato app → Restart Elgato app now**, or tray → **Restart Elgato App**.

Settings (web UI **Settings → Elgato app**, or `settings.json`):

- `"elgatoAutoRestart": false` — turn the automatic restart off (default: on). The manual restart always works.
- `"elgatoAutoRestartDelayS": 15` — grace delay in seconds, limited to 3–120 (default 10).

<details>
<summary>How the automatic restart works</summary>

"Paired before" means the Elgato app's **child** CORA connection attached to that dock once. DeckBridge saves the time as `pairedAt` in the device's `settings.json` entry. Decks from older versions get it at their next successful pairing.

Once per DeckBridge start:

1. A dock with `pairedAt` connects over USB, and the Elgato app runs **on this machine** (macOS and Windows only).
2. DeckBridge waits the grace delay (default **10 s**) for the app to attach by itself.
3. If it has not attached, DeckBridge quits the app (deeplink, then kill as fallback), waits a few seconds, and starts it again.

It is skipped, with a one-line log saying why, when: it already ran in this process; the toggle is off; a dock was never paired; the app is not running locally; every paired dock is attached; or the app holds the USB deck itself (the "Elgato conflict" state, see [Web UI states](./features.md#web-ui-states)), because a restart could let it grab the hardware back mid-handoff.

</details>

## Device tuning

Some boards are supported from documents, not hardware we own. **Settings → Device tuning** fixes them at runtime:

- **Check images step by step** — sets orientation, key order, size and JPEG limits for you. See [Device check](./verify-device.md).
- Rotation, flip H/V, image fit, JPEG quality and size.
- **Crop…** (next to Image fit) picks which part of the Elgato app's key image lands on the key. Drag the region over a real key frame, then **Try on device**, **Save** or **Cancel**. Same region under Advanced as X/Y/Width/Height; leave all four blank for the whole image.
- **Key-map learn mode** — records which raw code each physical key sends.
- **Elgato identity** — overrides the dock and panel serial numbers, MAC address, and firmware versions sent to the Elgato app. Blank serial/MAC use the generated or physical identity. Blank firmware uses the model default (or the physical firmware, if that model forwards it).
- **Copy overrides as JSON** — please send working values back, see [Adding a device](./adding-a-device.md).

Tuning is saved per model id under `modelOverrides` in `settings.json`, so it applies to every deck of that model. If it leaves the panel dark, use **Reset to defaults**, or start with `./deckbridge run --no-overrides` to ignore all tuning for one session. The diagnostics report flags active tuning at the top.

Extensions have their own safe mode: `./deckbridge run --no-extensions` (or `DECKBRIDGE_NO_EXTENSIONS=1`) starts no extension for one session. The Extensions list stays visible with its switches disabled.

<details>
<summary>When changes apply</summary>

- Image settings (rotation, flip, fit, quality, size, sharpen/blur/crop, crop region) and key maps (image key order, input mapping) apply live. A key pressed at the moment of a key-map swap can still hit its old index once.
- Wire, splash, extra-key and Elgato identity changes reconnect the device, because they must be set when the CORA session starts.

</details>

### Image fit

Image fit decides what happens when the Elgato app's key image is not the size the key expects. The panel greys out a mode that would not change the output.

- **resize** scales the image to the key. Always works; adds slight blur.
- **pad** keeps the pixels 1:1 and fills the border. Only when the image is smaller than the key.
- **crop** keeps the pixels 1:1 and trims the centre to the key size (a smaller axis is padded). Only when the image is larger than the key.

## Filing a good report

1. Turn on debug logging.
2. Reproduce the problem.
3. Create a diagnostics report.
4. Open an issue, attach it, and say what you expected and what happened.

If DeckBridge **freezes**, the last line in `deckbridge.log` names the startup step it hung on. Include it even if no report could be written.

## Freezes tied to a particular USB device

If DeckBridge hangs only while an unrelated USB device (keyboard, headset, wireless dongle) is plugged in, the cause is probably HID **enumeration**. Attach the report **with that device connected**: the enumeration table names the device DeckBridge does not recognize.

<details>
<summary>Why it happens and what to look for</summary>

On Windows, listing HID interfaces opens every HID interface on the machine to read its name, so one slow device holds up the whole list. Look for:

- The `hid enumeration (all devices, took NNNms)` heading in the report. Low double-digit ms is healthy; hundreds of ms is the problem.
- `USB enumeration slow (NNNms) — device probe interval now Ns` in the log. DeckBridge then probes less often (up to 30 s apart) and returns to every 3 s once enumeration is quick again.

</details>
