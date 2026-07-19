---
sidebar_position: 3
title: Headless Linux (Raspberry Pi / DietPi)
description: Run DeckBridge unattended on a headless Raspberry Pi / DietPi box under systemd.
---

:::caution[Linux builds are upcoming]
This page documents the intended setup for a headless Linux install. **Prebuilt
Linux release binaries do not exist yet** — the GitHub releases currently ship
macOS builds only (see [Getting Started](./getting-started.md)). Until a
`deckbridge-linux-arm64` release asset ships, build from source on the Pi itself
(Option B in Getting Started). This page will be updated with a download link
once that release lands.
:::

Runs DeckBridge unattended on a headless **Raspberry Pi (64-bit OS)** or **DietPi**
board, managed by systemd, with no desktop, tray icon, or browser involved.

## Prerequisites

- A 64-bit ARM board and OS (Raspberry Pi OS 64-bit or DietPi arm64). 32-bit
  armv7 images are not supported.
- `libhidapi-hidraw0` — the runtime HID library DeckBridge loads via FFI:
  ```bash
  sudo apt install libhidapi-hidraw0
  ```
- **mDNS discovery needs `avahi-daemon`.** DeckBridge does not bind mDNS itself
  on Linux — it shells out to `avahi-publish-service` (from `avahi-utils`) to
  advertise `_elg._tcp`, so `avahi-daemon` must be installed and running:
  ```bash
  sudo apt install avahi-daemon avahi-utils
  ```
  Raspberry Pi OS ships with `avahi-daemon` already running; minimal DietPi
  images usually don't and need the package installed. If the Elgato app
  can't discover the Pi, check `systemctl status avahi-daemon` first — a
  *missing/stopped* avahi-daemon is the far more common cause than a port
  conflict.

## 1. Install

Copy the `deckbridge` binary and the `packaging/linux/` files onto the Pi (or
build from source there — see [Getting Started](./getting-started.md#option-b--build-from-source)),
then run the installer as root from `packaging/linux/`:

```bash
cd packaging/linux
sudo ./install.sh /path/to/deckbridge
```

`install.sh` is idempotent (safe to re-run, e.g. after upgrading the binary). It:

- copies the binary to `/opt/deckbridge/deckbridge`,
- creates a system user `deckbridge` in the `plugdev` group (creating the group
  if it doesn't exist),
- creates `/var/lib/deckbridge` (settings + native-lib cache), owned by that user,
- installs the udev rule and systemd unit below, then reloads both.

Then enable and start it:

```bash
sudo systemctl enable --now deckbridge
journalctl -u deckbridge -f
```

## 2. What gets installed

### udev rule — `99-deckbridge.rules`

Grants the `deckbridge` user access to `/dev/hidraw*` for every supported
device's USB VID/PID, generated from `ts/src/devices/registry.ts`. Two grants
per device: `TAG+="uaccess"` for systemd-logind ACLs (most systems), and a
`MODE="0660", GROUP="plugdev"` fallback for minimal non-logind images. Without
this rule, DeckBridge fails to open the deck with `Permission denied`.

### systemd unit — `deckbridge.service`

```ini
ExecStart=/opt/deckbridge/deckbridge run --headless
Restart=on-failure
RestartSec=3
User=deckbridge
SupplementaryGroups=plugdev
Environment=XDG_CACHE_HOME=/var/lib/deckbridge
```

`--headless` skips the tray-sidecar lookup, the auto-open-browser check, and the
Elgato-app poll timer — none of them apply without a desktop.
`XDG_CACHE_HOME=/var/lib/deckbridge` points the settings/native-lib cache at a
directory the `deckbridge` service user actually owns, instead of a real home
directory it doesn't have.

## Firewall / network ports

| Port | Protocol | Purpose |
|---|---|---|
| 3000 | TCP | Web UI — bound to `127.0.0.1` by default. Start with `--bind 0.0.0.0` to expose it on the LAN (see below), or keep the default and use an SSH tunnel: `ssh -L 3000:localhost:3000 pi@<host>`, then open `http://localhost:3000` locally. |
| 5343 | TCP | CORA main server — the Elgato app connects here |
| 5344 | TCP | CORA child server — image/data channel |
| +2 per extra dock | TCP | Each additional connected deck (different model) gets its own CORA pair, e.g. 5345/5346 for a second dock |
| 5353 | UDP | mDNS (`_elg._tcp`), via `avahi-daemon` |

If you run a firewall (`ufw`, `nftables`), allow inbound TCP 5343/5344 (+2 per
extra dock) and UDP 5353 from your LAN. Add TCP 3000 only if you expose the web
UI with `--bind 0.0.0.0`.

### Reaching the web UI from another machine

The web UI is the only configuration surface (brightness, extra keys, device
naming), so on a headless box you'll usually want it reachable over the LAN.
Change the unit's `ExecStart` to:

```ini
ExecStart=/opt/deckbridge/deckbridge run --headless --bind 0.0.0.0
```

then `sudo systemctl daemon-reload && sudo systemctl restart deckbridge` and
open `http://<pi-ip>:3000`. The web UI is unauthenticated — only do this on a
trusted network. Requests are still restricted to `localhost` and the Pi's own
IP addresses in the `Host` header (DNS-rebinding protection), so access via a
DNS name pointing at the Pi is rejected; use the IP directly.

## Troubleshooting

1. **`deckbridge devices`** — run this first. It enumerates HID devices (never
   opens them) and prints a table of model, VID:PID, serial, path, and whether
   it's supported. On Linux, if no devices are found it also prints a hint to
   check the udev rule and group membership:
   ```bash
   /opt/deckbridge/deckbridge devices
   ```
2. **`journalctl -u deckbridge -f`** — tail the service logs. Add
   `--log-level debug` to `ExecStart` in the unit (then `sudo systemctl daemon-reload
   && sudo systemctl restart deckbridge`) for more detail.
3. **Permission denied opening the deck** — the udev rule isn't applied yet, or
   the device was plugged in before the rule was installed. Replug it, or run
   `sudo udevadm control --reload && sudo udevadm trigger`.
4. **Elgato app doesn't discover the Pi** — check `systemctl status avahi-daemon`
   (see Prerequisites above); confirm you're on the same LAN/subnet as the app.
5. **Can't open the web UI from another machine** — by default it's
   localhost-only. Either add `--bind 0.0.0.0` to the service's `ExecStart`
   (see the network section above) or use an SSH tunnel. If the port is open
   but you get `403`, you're likely using a DNS name — browse to the Pi's IP
   address instead.

## See also

- [Getting Started](./getting-started.md) — general install/build steps
- [Features & Use Cases](./features.md#permissions) — permissions and ports on
  every platform
- `packaging/linux/` in the repo — the udev rule, systemd unit, and install script
