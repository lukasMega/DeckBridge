---
sidebar_position: 2
title: Getting Started
description: Install or build DeckBridge, run it, and pair a USB deck with the Elgato app.
---

# Getting Started

Two ways to get DeckBridge ([what it is](./introduction.md)): **run a packaged
release** (easiest) or **build from source**.

## 1. Get DeckBridge

### Option A — Packaged release (recommended)

Download the build for your OS from the
[project releases](https://github.com/lukasMega/DeckBridge/releases), unzip, and run. The release
is self-contained — the txiki.js runtime and the native libraries (`libhidapi`,
`libdeckbridge_native`) are embedded and auto-extract on first run. **No Node.js, no extra
installs.**

```bash
./deckbridge        # macOS / Linux
deckbridge.exe      # Windows
```

The macOS `.dmg` and Windows installer also bundle a small **system-tray** companion.

### Option B — Build from source

Needs [mise](https://mise.jdx.dev), a Rust toolchain, and **libhidapi**:

- macOS: `brew install hidapi`
- Debian/Ubuntu: `sudo apt install libhidapi-dev`

```bash
cd deckbridge
mise run start      # build everything + run
# or
mise run compile    # produce a standalone ./deckbridge binary
```

The txiki.js runtime is fetched automatically by mise — no C/C++ toolchain needed for
the common path. That's true on macOS and Windows only; on Linux there's no prebuilt
runtime yet, so mise builds it from source, which needs a C/C++ toolchain (cmake, make,
libffi).

## 2. Plug in your deck

Connect a [supported device](./introduction.md#supported-devices). DeckBridge probes on
start and retries every 2 s until one opens. On **macOS**, grant **Input Monitoring** if
prompted — HID reads need it (see [Permissions](./features.md#permissions)).

## 3. Run it

Start DeckBridge. It then:

- opens the USB device,
- advertises an Elgato Network Dock over mDNS (`_elg._tcp`),
- listens on TCP **5343 / 5344** (CORA protocol),
- serves a web UI at **http://localhost:3000**.

In packaged releases (installers and release zips) the tray icon shows status at a glance:

|                   Tray icon                    | State      | Meaning                                              |
|:----------------------------------------------:|------------|------------------------------------------------------|
| ![Gray tray icon](./img/tray-disconnected.png) | **gray**   | no deck                                              |
|  ![Yellow tray icon](./img/tray-usb-only.png)  | **yellow** | deck connected and ready for pairing with Elgato app |
|    ![Green tray icon](./img/tray-full.png)     | **green**  | deck open *and* Elgato app connected                 |

## 4. Pair with the Elgato app

Open the Elgato Stream Deck app (or Companion) on any machine on the **same LAN**. It
discovers DeckBridge like real Elgato hardware.

## Verify your setup

- Open **http://localhost:3000** for the live key grid and log feed.
- Or use the tray's **Check Requirements** → the `/requirements` diagnostics page (what
  it checks: [Requirements](./features.md#requirements)).

## Troubleshooting

- **`port in use` (5343/5344)** — another DeckBridge, a real Network Dock, or the ESP32
  bridge holds the CORA port. Stop it; DeckBridge keeps retrying every few seconds.
- **No device found** — check the cable/port; on macOS grant Input Monitoring. DeckBridge
  retries every 2 s.
- **libhidapi missing (source build only)** — install it as in
  [Build from source](#option-b--build-from-source).
- **Permission denied opening the deck (Linux)** — add a udev rule; see
  [Permissions](./features.md#permissions).
- **Restrict network access** — set `DECKBRIDGE_BIND=127.0.0.1`; see
  [Network ports](./features.md#network-ports).
