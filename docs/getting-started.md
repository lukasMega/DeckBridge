---
sidebar_position: 2
title: Getting Started
description: Install or build DeckBridge, run it, and pair a USB deck with the Elgato app.
---

# Getting Started

DeckBridge runs on your computer, speaks USB to your deck, and looks like an Elgato
Network Dock on your LAN. Two ways to get it: **run a packaged release** (easiest) or
**build from source**.

## 1. Get DeckBridge

### Option A — Packaged release (recommended)

Download the build for your OS from the
[project releases](https://github.com/lukasMega/DeckBridge), unzip, and run. The release
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
the common path.

## 2. Plug in your deck

Connect a supported USB device — Mirabox 293V3/Ajazz, Mirabox 293S, Mirabox K1 Pro,
Stream Deck MK.2, or Stream Deck Mini. DeckBridge probes on start and retries every 2 s
until one opens. On **macOS**, grant **Input Monitoring** if prompted — HID reads need it.

## 3. Run it

Start DeckBridge. It then:

- opens the USB device,
- advertises an Elgato Network Dock over mDNS (`_elg._tcp`),
- listens on TCP **5343 / 5344** (CORA protocol),
- serves a web UI at **http://localhost:3000**.

In installer builds the tray icon shows status at a glance:

|                   Tray icon                    | State      | Meaning                                              |
|:----------------------------------------------:|------------|------------------------------------------------------|
| ![Gray tray icon](./img/tray-disconnected.png) | **gray**   | no deck                                              |
|  ![Yellow tray icon](./img/tray-usb-only.png)  | **yellow** | deck connected and ready for pairing with Elgato app |
|    ![Green tray icon](./img/tray-full.png)     | **green**  | deck open *and* Elgato app connected                 |

## 4. Pair with the Elgato app

Open the Elgato Stream Deck app (or Companion) on any machine on the **same LAN**. It
discovers DeckBridge like real Elgato hardware. Your key presses and button images now
travel over WiFi — no physical Network Dock required.

## Verify your setup

- Open **http://localhost:3000** for the live key grid and log feed.
- Or use the tray's **Check Requirements** → the `/requirements` diagnostics page, which
  reports libhidapi, the native library, and port status.

## Troubleshooting

- **`port in use` (5343/5344)** — another DeckBridge, a real Network Dock, or the ESP32
  bridge holds the CORA port. Stop it; DeckBridge keeps retrying every few seconds.
- **No device found** — check the cable/port; on macOS grant Input Monitoring. DeckBridge
  retries every 3 s.
- **libhidapi missing (source build only)** — install it: `brew install hidapi` /
  `sudo apt install libhidapi-dev`.
- **Restrict network access** — the CORA ports bind all interfaces with no auth
  (protocol-inherent — the real dock has none either). Set `DECKBRIDGE_BIND=127.0.0.1` to
  limit it. The web UI is always localhost-only.
