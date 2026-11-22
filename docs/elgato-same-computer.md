---
sidebar_position: 7
sidebar_label: Elgato on the same computer
title: Elgato app 7.6.1 on the same computer as DeckBridge
slug: /elgato-same-computer
description: Elgato Stream Deck 7.6.1 refuses a network dock on its own computer. Fix it with the Fix pairing wizard in DeckBridge - use app 7.6.0, a relay on another device, a relay in WSL on Windows, or a relay in Apple container or OrbStack on a Mac.
---

# Elgato app 7.6.1 on the same computer as DeckBridge

## The problem

Stream Deck app 7.6.1 refuses a network dock that runs on its own computer. Every address
fails (`127.0.0.1`, LAN IP, Tailscale IP), so DeckBridge never pairs
([#257](https://github.com/lukasMega/DeckBridge/issues/257)).

These still work: app 7.6.0, or the app on a different computer than DeckBridge.

## The fix

Click **Fix pairing for Stream Deck app 7.6.1** on the pairing screen. The wizard opens by
itself once if it finds app 7.6.1 or newer. To open it again, use **Fix pairing** in the
warning banner, or **Run setup again** in Settings > "Stream Deck app 7.6.1 pairing". It is
not shown on Linux.

The wizard asks about your app version and setup, then shows the fixes that fit, with one
marked **Recommended**. If your app is 7.6.0 or older, or on another computer, you need no fix.

- **Use app 7.6.0.** Install it over your current version (the wizard links it), then turn
  off automatic updates in Preferences > General.
- **Relay on another device.** See [one command](#one-command), or the
  [manual relay](#manual-relay) on a Windows device.
- **Relay in WSL** (Windows only). See [Windows with WSL](#windows-wsl).
- **Relay in Apple container** (Mac only). See [macOS with Apple container](#macos-container).
- **Relay in OrbStack** (Mac only). See [macOS with OrbStack](#macos-orbstack).

A **relay** is a small program between the app and DeckBridge. The app sees it at a different
address, so it agrees to connect. With any relay, add the relay's IP in the Stream Deck app as
a Network Dock by IP. DeckBridge stops announcing itself on the network while a relay is set
up. **Turn off relay** in Settings undoes this.

<details>
<summary>Compare the fixes: memory, disk, setup time, cost</summary>

| Fix | Memory | Disk | Setup | Cost | Needs |
|---|---|---|---|---|---|
| Use Stream Deck app 7.6.0 | none | none | ~5 min | free | Turn off app updates. You miss newer app fixes. |
| Relay on another device | ~15 MB on that device | ~30 MB | ~5 min | free if you own one (Raspberry Pi Zero 2 W ~$15) | 64-bit Linux, macOS or Windows; stays on |
| Relay in WSL on this PC | ~300-600 MB while on | ~1.5-2 GB | ~2 min, or 15 min + restart | free | Windows 10 2004+ or 11 |
| Relay in Apple container on this Mac | up to 256 MB | ~100 MB | ~5 min | free | macOS 26, Apple silicon, admin password once |
| Relay in OrbStack on this Mac | ~150 MB-1 GB | ~0.8 GB | ~5 min | free for personal use; $8/month commercial | macOS |

</details>

## Another device: one command {#one-command}

Paste the wizard's line in a terminal on a Linux or macOS device on the same network (the
wizard has a `curl` / `wget` / **Node.js** switch):

```
curl -fsSL "http://<this computer's IP>:44661/relay.sh?t=<token>" | sh
```

The script asks "Start the relay automatically after a restart? [Y/n]". Answer yes (the
default) and you can close the terminal: on Linux a systemd user service starts the relay at
boot, on a Mac a LaunchAgent starts it at login. Answer no and keep the terminal open; after a
reboot, run the command again. Running the command again replaces the automatic start.
Linux needs glibc 2.38 or newer (Raspberry Pi OS Trixie, Debian 13, Ubuntu 24.04). A Raspberry
Pi needs 64-bit Raspberry Pi OS Trixie.

The wizard shows **Downloading**, **Initializing**, **Connecting**, then **Connected on
<IP>**. Add that IP in the Stream Deck app. After 90 seconds with no news it shows **Relay
offline**. A failed step shows its reason.

<details>
<summary>What the script does, token, uninstall</summary>

DeckBridge serves the script on port 44661 (or a free high port) while this route is selected.
The port must be reachable from your local network. You do not need `--bind`. The script:

- checks the device;
- downloads the release zip for your DeckBridge version from GitHub, checks it against
  `SHA256SUMS.txt` and unpacks it into `~/.deckbridge-relay` (a second run skips the download);
- runs `deckbridge relay --target <this computer's IP> --no-advertise` and reports progress;
- on a yes, saves itself to `~/.deckbridge-relay/relay.sh` and installs the service
  (`~/Library/LaunchAgents/dev.deckbridge.relay.plist` on a Mac,
  `~/.config/systemd/user/deckbridge-relay.service` on Linux, plus `loginctl enable-linger`).
  The service logs to `~/.deckbridge-relay/relay.log` on a Mac and to `journalctl --user -u
  deckbridge-relay` on Linux. After a DeckBridge update, run the command again to update the
  relay.

The token only lets the script fetch itself and report progress. It is saved in
`settings.json`, shown only in the wizard command, and left out of diagnostics and exports.
DeckBridge ignores any address written inside a report.

To remove everything from the device (relay, automatic start and, on a Mac, the container):

```
curl -fsSL "<the same URL>" | sh -s -- --uninstall
```

</details>

### macOS blocks the relay {#relay-node}

On some Macs the relay starts but gets no network. The app never connects, and the relay log
shows `connect failed` or nothing. Pick **Node.js** in the switch (the command ends in
`| sh -s -- --node`). You need Node.js 20 or newer from [nodejs.org](https://nodejs.org). This
relay does not announce itself: add its IP by hand.

### Check the relay in Settings {#relay-settings}

Settings > **Stream Deck app 7.6.1 pairing** shows the relay state. **Offline** means no news
for 90 seconds: the device is off, the terminal is closed or the network is down. After a
restart, copy **Run** and paste it on the device again. On a version warning, run the command
again to update.

<details>
<summary>What each field means</summary>

- **Status**: Running, Installing, Offline, Failed or Not reported yet.
- **Seen**: when the relay last sent news.
- **Relay**: the relay's IP. Add it in the Stream Deck app.
- **Build**: the relay's platform and version.
- **Target**: the address on this computer that the relay connects to.
- **App**: whether the Stream Deck app is paired through the relay.

</details>

## The manual relay: a second machine {#manual-relay}

Run `deckbridge relay` on a second computer, B. B can be a Mac, Windows PC, Linux machine or
Raspberry Pi (`linux-arm64` build). B needs no stream deck. B cannot run a normal DeckBridge
at the same time (same ports 5343 and 5344).

```
Computer A: Elgato 7.6.1 ──TCP──▶ Computer B: deckbridge relay ──TCP──▶ Computer A: DeckBridge
                                  :5343 and :5344                       :5343 and :5344
```

1. On A, start DeckBridge without its network announcement:

   ```bash
   DECKBRIDGE_NO_MDNS=1 deckbridge
   ```

   <details>
   <summary>On Windows</summary>

   PowerShell: `$env:DECKBRIDGE_NO_MDNS = "1"; deckbridge`

   Command Prompt: `set "DECKBRIDGE_NO_MDNS=1" && deckbridge`

   </details>

2. On B, start the relay:

   ```bash
   deckbridge relay --target <A-IP>
   ```

   It keeps trying until DeckBridge runs. It reads the dock identity only at startup, so
   restart it after you change the dock on A.

3. In the Stream Deck app on A, "DeckBridge Relay" appears as a network dock. If not, add the
   relay's IP by hand (the relay prints it at startup).

<details>
<summary>Node.js instead of the program, flags, logging</summary>

On a Mac that [blocks the relay](#relay-node): download `deckbridge-relay-v<version>.mjs` from
the release and run `node deckbridge-relay-v<version>.mjs relay --target <A-IP>` (Node.js 20+).
Same flags. It never announces itself, so add its IP by hand.

| Flag | Meaning |
|---|---|
| `--target <host>` | The computer that runs DeckBridge (required). |
| `--target-port <n>` | DeckBridge's CORA port. Default `5343`. |
| `--listen-host <host>` | Address the relay listens on. Default `0.0.0.0`. |
| `--name <text>` | Name the Stream Deck app shows. Default `DeckBridge Relay`. |
| `--no-advertise` | Do not announce the relay. Add the IP by hand. |
| `--hold-seconds <n>` | How long the relay keeps the app connected while DeckBridge is down (see [Restarting DeckBridge](#restart)). `0` to `3600`, default `60`, `0` turns it off. |
| `--log-level <level>` | `debug`, `info`, `warn`, `error` or `silent`. |

The relay logs to the terminal only. For a bug report: `deckbridge relay --target <A-IP> > relay.log 2>&1`.

</details>

## Windows: pair on the same PC with WSL {#windows-wsl}

DeckBridge can run the relay for you inside WSL2, a Linux system inside Windows. WSL2 has its
own IP, so the app treats it as a second computer.

:::caution
New and not yet tested on real Windows PCs. Commands marked *(unverified)* may not fix the
problem. If something fails, please
[open an issue](https://github.com/lukasMega/DeckBridge/issues/257) and attach the
diagnostics report.
:::

**You need** Windows 10 or 11 with WSL2 and an Ubuntu 24.04 or newer distro, in WSL's default
NAT networking mode ("Mirrored" does not work). To install, run `wsl --install` in an admin
PowerShell, then restart.

1. In the wizard, pick **Relay in WSL on this PC** (or use **Run setup again** in Settings).
2. Wait until all steps are green. The first start downloads the relay.
3. In the Stream Deck app, add a Network Dock by IP with the IP the steps show.

DeckBridge starts the relay again on its next run. **Turn off** (wizard) or **Turn off relay**
(Settings) stops it. The WSL IP can change after a PC restart. DeckBridge then tells you:
remove the old Network Dock and add the new IP.

<details>
<summary>If a step fails</summary>

DeckBridge never runs an admin command for you. It shows a sentence and a command to copy.

| State | What it means | Fix |
|---|---|---|
| WSL missing | `wsl.exe` or a Linux distro is not installed. | In an admin PowerShell: `wsl --install`, then restart the PC. |
| WSL 1 | Your distro runs WSL 1, which shares the Windows IPs. | `wsl --set-version <distro> 2` |
| Mirrored networking | `.wslconfig` has `networkingMode=mirrored`. | Set `networkingMode=NAT` in `%UserProfile%\.wslconfig`, then run `wsl --shutdown`. |
| Old Linux libraries | The distro's glibc is older than 2.38, for example Ubuntu 22.04. | `wsl --install -d Ubuntu-24.04`, then `wsl --set-default Ubuntu-24.04` |
| Download failed | The relay could not be downloaded, or its checksum did not match. | Check your internet and click **Check again**. |
| Blocked | The relay cannot reach DeckBridge. Likely the firewall. | Run the command below. |

Firewall fix, in an admin PowerShell *(unverified; the adapter name may differ between Windows
versions)*:

```powershell
New-NetFirewallRule -DisplayName "DeckBridge WSL relay" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 5343,5344 -InterfaceAlias "vEthernet (WSL*)"
```

</details>

### Stuck at "Add this IP" {#wsl-not-pairing}

The relay runs, but the app does not pair:

1. Check that you added the exact IP DeckBridge shows, as a Network Dock by IP.
2. Remove old Network Docks in the Stream Deck app, then restart the app.
3. Allow the Hyper-V firewall for WSL, in an admin PowerShell *(unverified)*:

   ```powershell
   Set-NetFirewallHyperVVMSetting -Name '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' -DefaultInboundAction Allow
   ```

4. Still stuck? Go to **Settings → Maintenance → Logging & diagnostics → Create report** and
   send it with your issue.

<details>
<summary>What it downloads</summary>

On first start, DeckBridge downloads the Linux release zip of the same version from GitHub
(`linux-x86_64`, or `linux-arm64` on Windows on ARM), checks it against the release's SHA256
checksums and unzips it into its cache folder. The installer does not grow. Relay log lines go
into the DeckBridge log file under `wsl-relay`.

</details>

## macOS: pair on the same Mac with Apple container {#macos-container}

:::caution
New and not yet confirmed to pair with the Stream Deck app. If it fails, please
[open an issue](https://github.com/lukasMega/DeckBridge/issues/257) with the diagnostics report.
:::

[Apple container](https://github.com/apple/container) is Apple's free tool for small Linux
VMs. Each one has its own IP (`192.168.64.x`), so the app sees the relay at a different address.
It needs macOS 26 and Apple silicon.

1. Install the signed `.pkg` from the
   [releases page](https://github.com/apple/container/releases) (asks for your password once),
   then run `container system start` in Terminal. In the wizard, **Check again** finds it.
2. Paste the wizard's command in Terminal. It downloads the Linux relay to
   `~/.deckbridge-relay`, starts the container `deckbridge-relay` (Ubuntu 24.04, 256 MB) and
   reports its IP. The first start pulls the Ubuntu image, which takes a few minutes. Answer
   yes to the automatic start, and the relay comes back at every login.
3. In the Stream Deck app, add the container's IP as a Network Dock by IP. The wizard and the
   Settings pairing row show it. So does `container ls`.

To remove it, run the **Uninstall** command from Settings > "Stream Deck app 7.6.1 pairing".
It stops and deletes the container and removes the LaunchAgent. If the app stays blocked, see
[Local Network](#macos-local-network).

## macOS: pair on the same Mac with OrbStack {#macos-orbstack}

[OrbStack](https://orbstack.dev) runs a small Linux machine on your Mac with its own IP, so
the app sees the relay at a different address. Free for personal use; commercial use needs a
paid licence. You run three commands yourself (the wizard fills in your values):

1. Install OrbStack and open it once.
2. Create the machine (once): `orb create ubuntu:noble deckbridge-relay`.
3. Paste the wizard's **Run** command. It runs the [same install script](#one-command) inside
   the machine. Keep the Terminal window open while you use the deck. After a reboot, run it
   again.
4. In the Stream Deck app, add the machine's IP as a Network Dock by IP. The relay, the wizard
   and the Settings pairing row show it. So does `orb -m deckbridge-relay hostname -I`.

Run the relay from the machine's own home, never from a folder under `/Users`. OrbStack runs
macOS programs found there on the Mac itself, and that copy cannot listen next to DeckBridge
(`EADDRINUSE`). To remove the machine: `orb delete deckbridge-relay`.

### Stream Deck app blocked from the local network {#macos-local-network}

macOS counts the OrbStack machine or Apple container (and any relay on your network) as local network, so the
Stream Deck app needs the Local Network permission. If it is off, or not yet applied, macOS
drops every connection to the relay. The relay logs nothing and the app never pairs. The
wizard and diagnostics show "The Stream Deck app is blocked from the local network". To fix:

1. Quit the Stream Deck app, including its menu bar icon.
2. Open System Settings > Privacy & Security > Local Network. Turn Stream Deck off and on.
3. Start the app again.
4. Still not connected? Restart the Mac. In our tests, restarting only the app was not enough.

<details>
<summary>Check it yourself</summary>

Run this right after the app tried to connect. Any output means macOS blocked it:

```bash
/usr/bin/log show --last 5m --style compact --predicate 'process == "kernel" AND eventMessage CONTAINS "reason: NECP" AND eventMessage CONTAINS "process: Stream Deck"'
```

</details>

## Restarting DeckBridge {#restart}

You can restart DeckBridge while the relay keeps running. The relay keeps the app connected
for up to 60 seconds and reconnects by itself. The deck comes back with no new pairing and the
same dock IP. An app that connects during the gap waits. If DeckBridge is not back in time,
the relay closes the connection. `--hold-seconds <n>` changes the time; `0` turns it off.

The relay itself must keep running. If you chose the automatic start, it starts again after
a restart. If not, start it again by hand.

<details>
<summary>More details and limits</summary>

- During the wait, the relay sends a keepalive every 2 seconds. The app drops a connection
  that is silent for about 4.5 seconds.
- Tested with Stream Deck 7.6.1: a 9.5 second restart brought the deck back with no new
  pairing. Longer gaps are untested. The 60 second default is a guess.
- If you connect a different deck during the restart, the relay follows the new model and
  serial number and logs each change at `warn` level.

</details>

## Notes

- macOS asks for Local Network and incoming-connection permission the first time the relay
  runs. Allow both.
- Relay on a Mac logs `a client on main reset before the relay accepted it` and the app never
  pairs? Likely the macOS firewall. In System Settings > Network > Firewall > Options, allow
  incoming connections for `deckbridge`. Repeat after each new version (macOS sees a new app).
  Linux (tested on a Raspberry Pi) needs no such step.
- On Linux, announcing the relay needs `avahi-publish-service` (package `avahi-utils`).
- `examples/tcp-proxy` is a small Node 24 script that does the same job and prints a one-line
  summary of every CORA message. Use it to debug at message level.
