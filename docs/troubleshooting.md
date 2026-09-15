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
- **No device found** — check the USB cable; on macOS grant Input Monitoring; on Linux
  install the [udev rule](./features.md#permissions).
- **Missing libhidapi** — see the [requirements check](./features.md#requirements).
- **Restrict LAN access** — set `DECKBRIDGE_BIND=127.0.0.1`.
- **Images rotated, mirrored, or on the wrong key** — see [Device tuning](#device-tuning).

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

## Device tuning

Some boards are supported from documentation, not hardware we own. **Settings → Device
tuning** fixes them at runtime:

- Rotation, flip H/V, image fit, JPEG quality and size.
- **Key-map learn mode** records which raw code each physical key sends.
- **Copy overrides as JSON** — please send working values back, see
  [Adding a device](./adding-a-device.md).

Tuning is stored per model id under `modelOverrides` in `settings.json` and reconnects
the device on change. If it leaves the panel dark: **Reset to defaults**, or start with
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
