---
sidebar_position: 3
title: Headless Linux (Raspberry Pi / DietPi)
description: Run DeckBridge unattended on a headless Raspberry Pi / DietPi box under systemd.
---

:::caution[Linux builds are new and lightly tested]
Prebuilt `deckbridge-<version>-linux-x86_64.zip` and `-linux-arm64.zip` files ship since v0.9.0 (see [releases](https://github.com/lukasMega/DeckBridge/releases)). Far fewer people use them than the macOS builds. They need **glibc 2.38+** (Raspberry Pi OS trixie / Ubuntu 24.04+). On an older image, build from source on the Pi (Option B in [Getting Started](./getting-started.mdx)).
:::

Run DeckBridge unattended on a headless **Raspberry Pi (64-bit OS)** or **DietPi** board under systemd. No desktop, tray icon or browser needed.

## Prerequisites

- A 64-bit ARM board and OS (Raspberry Pi OS 64-bit or DietPi arm64). 32-bit armv7 is not supported.
- `sudo apt install libhidapi-hidraw0` — the HID library DeckBridge loads at runtime.
- `sudo apt install avahi-daemon avahi-utils` — **needed for discovery.** DeckBridge calls `avahi-publish-service` to advertise `_elg._tcp`, so `avahi-daemon` must be installed and running. Raspberry Pi OS already runs it; minimal DietPi usually does not. If the Elgato app cannot find the Pi, run `systemctl status avahi-daemon` first.

## 1. Install

Copy the `deckbridge` binary and the `../scripts/packaging/linux/` files onto the Pi (or build from source there — see [Getting Started](./getting-started.mdx#option-b--build-from-source)). Then run the installer as root from `../scripts/packaging/linux/`:

```bash
cd packaging/linux
sudo ./install.sh /path/to/deckbridge
```

`install.sh` is safe to re-run (for example, after an upgrade). It:

- copies the binary to `/opt/deckbridge/deckbridge`,
- creates system user `deckbridge` in group `plugdev` (and the group, if missing),
- creates `/var/lib/deckbridge` (settings + native-lib cache), owned by that user,
- installs the udev rule and systemd unit below, then reloads both.

Then enable and start it:

```bash
sudo systemctl enable --now deckbridge
journalctl -u deckbridge -f
```

## 2. What gets installed

### udev rule — `99-deckbridge.rules`

It gives access to every VID/PID in the device registry (AKP05/AKP05E included). Without it, DeckBridge cannot open the deck and shows `Permission denied`.

<details>
<summary>How the rule is made</summary>

`ts/scripts/gen-udev-rules.mjs` generates the file (`mise run devices-generate`), so new models get an entry automatically. Each device gets two grants: `TAG+="uaccess"` (systemd-logind ACLs, most systems) and a fallback `MODE="0660", GROUP="plugdev"` for minimal images without logind.

</details>

### systemd unit — `deckbridge.service`

```ini
ExecStart=/opt/deckbridge/deckbridge run --headless
Restart=on-failure
RestartSec=3
User=deckbridge
SupplementaryGroups=plugdev
Environment=XDG_CACHE_HOME=/var/lib/deckbridge
```

`--headless` skips the tray-sidecar lookup, the auto-open-browser check and the Elgato-app poll timer. `XDG_CACHE_HOME` puts the settings and native-lib cache in a folder the `deckbridge` user owns (it has no real home directory).

## Firewall / network ports

| Port | Protocol | Purpose |
|---|---|---|
| 3000 | TCP | Web UI. Bound to `127.0.0.1` by default. See below to reach it from the LAN. |
| 5343 | TCP | CORA main server — the Elgato app connects here |
| 5344 | TCP | CORA child server — image/data channel |
| 5345/5346 | TCP | Second deck's CORA pair — only when `"multiDeck": true` is set in settings.json (off by default) |
| 5353 | UDP | mDNS (`_elg._tcp`), via `avahi-daemon` |

With a firewall (`ufw`, `nftables`), allow inbound TCP 5343/5344 (plus 5345/5346 for multiple decks) and UDP 5353 from your LAN. Add TCP 3000 only if you use `--bind 0.0.0.0`.

### Reaching the web UI from another machine

The web UI is the only place to change settings. To reach it over the LAN, change the unit's `ExecStart` to:

```ini
ExecStart=/opt/deckbridge/deckbridge run --headless --bind 0.0.0.0
```

Then run `sudo systemctl daemon-reload && sudo systemctl restart deckbridge` and open `http://<pi-ip>:3000`. The web UI has no login, so use a trusted network only. Use the IP address, not a DNS name: DeckBridge accepts only `localhost` and the Pi's own IPs in the `Host` header (DNS-rebinding protection), so a DNS name gives `403`.

<details>
<summary>Other ways to reach the web UI</summary>

- **SSH tunnel** (keeps the localhost-only default): `ssh -L 3000:localhost:3000 pi@<host>`, then open `http://localhost:3000`.
- **Port busy:** if 3000 is busy, DeckBridge uses a free port in 33011–33099. On a server, pass `--webui-port 3000` to pin it, so firewall and tunnel rules stay valid. Startup then fails if the port is busy.

</details>

## Troubleshooting

1. **`/opt/deckbridge/deckbridge devices`** — run this first. It lists HID devices (never opens them): model, VID:PID, serial, path, and whether it is supported. On Linux, if it finds none, it hints to check the udev rule and group membership.
2. **`journalctl -u deckbridge -f`** — follow the logs. For more detail, add `--log-level debug` to `ExecStart`, then `sudo systemctl daemon-reload && sudo systemctl restart deckbridge`.
3. **Permission denied opening the deck** — the udev rule is not active yet, or the device was plugged in before the rule. Replug it, or run `sudo udevadm control --reload && sudo udevadm trigger`.
4. **Elgato app does not find the Pi** — check `systemctl status avahi-daemon` and that you are on the same LAN/subnet as the app.
5. **Cannot open the web UI from another machine** — it listens on localhost by default. Add `--bind 0.0.0.0` (see above) or use an SSH tunnel. A `403` means you used a DNS name. Use the IP.

## See also

- [Getting Started](./getting-started.mdx) — general install/build steps
- [Features & Use Cases](./features.md#permissions) — permissions and ports on every platform
- `../scripts/packaging/linux/` in the repo — the udev rule, systemd unit, and install script
