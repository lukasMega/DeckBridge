---
sidebar_position: 7
sidebar_label: Elgato on the same computer
title: Elgato app 7.6.1 on the same computer as DeckBridge
slug: /elgato-same-computer
description: Elgato Stream Deck 7.6.1 refuses a network dock on its own computer. Fix it with the Fix pairing wizard in DeckBridge - use app 7.6.0, a relay on another device, a relay in WSL on Windows, or a relay in OrbStack on a Mac.
---

# Elgato app 7.6.1 on the same computer as DeckBridge

## The problem

Elgato Stream Deck app 7.6.1 resets the connection to a network dock whose IP address
belongs to the same computer. `127.0.0.1`, the computer's LAN IP and its Tailscale IP all
fail, so DeckBridge never pairs ([#257](https://github.com/lukasMega/DeckBridge/issues/257)).
Version 7.6.0 is not affected, and neither is a setup where Elgato runs on another computer
than DeckBridge.

## Fix it with the wizard

DeckBridge guides you through the fix. On the pairing screen, click **Fix pairing for
Stream Deck app 7.6.1**. If DeckBridge finds a Stream Deck app 7.6.1 or newer on this
computer, the wizard also opens once on its own. Later you can open it from the **Fix
pairing** link in the warning banner, or from **Run setup again** in Settings, in the
"Stream Deck app 7.6.1 pairing" section.

The wizard asks which Stream Deck app version you use (it prefills what it found; "Not
sure" counts as 7.6.1 or newer), where the app runs, and whether you have another device on
the network. Then it offers the fixes below, marks one as **Recommended**, and shows the
setup steps for the one you pick. The downgrade is always listed. The relay on another
device appears when you have one, and Windows adds the WSL relay. The wizard is not shown
when DeckBridge runs on Linux.

| Fix | Memory | Disk | Setup | Cost | Needs |
|---|---|---|---|---|---|
| Use Stream Deck app 7.6.0 | none | none | ~5 min | free | Turn off app updates. You miss newer app fixes. |
| Relay on another device | ~15 MB on that device | ~30 MB | ~5 min | free if you own one (Raspberry Pi Zero 2 W ~$15) | 64-bit Linux, macOS or Windows; stays on |
| Relay in WSL on this PC | ~300-600 MB while on | ~1.5-2 GB | ~2 min, or 15 min + restart | free | Windows 10 2004+ or 11 |
| Relay in OrbStack on this Mac | ~150 MB-1 GB | ~0.8 GB | ~5 min | free for personal use; $8/month commercial | macOS |

A relay in Apple's `container` tool (macOS 26) is coming later.

- **Use Stream Deck app 7.6.0.** No relay. The wizard links the 7.6.0 download (Windows) or
  the Elgato 7.6 release notes (macOS). Install it over your current version, then turn off
  automatic updates in Preferences > General.
- **Relay on another device.** The wizard shows one command to paste on the other device.
  See [Another device: one command](#one-command). On a Windows PC, use
  [the manual relay](#manual-relay) instead. A Raspberry Pi needs 64-bit Raspberry Pi OS
  Trixie.
- **Relay in WSL on this PC.** See [Windows: pair on the same PC with WSL](#windows-wsl).
- **Relay in OrbStack on this Mac.** See [macOS: pair on the same Mac with OrbStack](#macos-orbstack).

For a relay, add the relay's IP address in the Stream Deck app as a Network Dock by IP.
While a relay is set up, DeckBridge stops advertising itself on the network, so the app
finds the dock only at the relay's address. **Turn off relay** in Settings undoes this.

Answer "7.6.0 or older" or "On another computer" and the wizard says no fix is needed: the
app can pair with DeckBridge directly.

## Another device: one command {#one-command}

Pick **Relay on another device** in the wizard. It shows one line, with a `curl` / `wget`
switch, to paste in a terminal on a Linux or macOS device on the same network:

```
curl -fsSL "http://<this computer's IP>:44661/relay.sh?t=<token>" | sh
```

DeckBridge serves the script on port 44661 (or a free high port if 44661 is taken) while the
route is selected. That port must be reachable from the LAN; you do not need `--bind`. The
script:

- checks the device (Linux needs glibc 2.38 or newer: Raspberry Pi OS Trixie, Debian 13,
  Ubuntu 24.04);
- downloads the release zip that matches your DeckBridge version from GitHub, checks it
  against `SHA256SUMS.txt` and unpacks it into `~/.deckbridge-relay`;
- runs `deckbridge relay --target <this computer's IP> --no-advertise` in the terminal. Keep
  the terminal open while you use the deck. The relay does not start again after a reboot:
  run the command again.

The wizard shows the progress: **Downloading**, **Initializing**, **Connecting**, then
**Connected on <IP>**. Use that IP in the Stream Deck app as a Network Dock by IP. If the
relay goes quiet for 90 seconds the wizard shows **Relay offline**; a failed step shows its
reason. If the relay runs another DeckBridge version than this computer, the wizard warns.

The token in the URL only lets the script fetch itself and report progress. It is kept in
`settings.json`, shown only in the wizard command, and left out of diagnostics and exports.
The script reports from the device's own address; DeckBridge ignores any address in the
report. To remove everything from the device:

```
curl -fsSL "<the same URL>" | sh -s -- --uninstall
```

### Check the relay in Settings {#relay-settings}

Open Settings and expand **Stream Deck app 7.6.1 pairing**. It lists:

- **Status**: Running, Installing, Offline, Failed or Not reported yet.
- **Seen**: how long ago the relay last reported.
- **Relay**: the relay's IP, to add in the Stream Deck app.
- **Build**: the relay's platform and version.
- **Target**: the address the relay connects to on this computer.
- **App**: whether the Stream Deck app is paired through the relay.

**Offline** means no heartbeat for 90 seconds: the device is off, the terminal was closed or
the network is down. After the device restarts, copy **Run** there and paste it on the
device again (the relay has no autostart yet). **Uninstall** copies the removal command. A
version warning means the relay runs another DeckBridge version: run the command again to
update it.

## The manual relay: a second machine {#manual-relay}

`deckbridge relay` runs on a second computer (B). Elgato on computer A connects to the
relay, sees a foreign IP and pairs. The relay passes every byte on to DeckBridge on A.

```
Computer A: Elgato 7.6.1 ──TCP──▶ Computer B: deckbridge relay ──TCP──▶ Computer A: DeckBridge
                                  :5343 and :5344                       :5343 and :5344
```

B can be a Mac, a Windows PC, a Linux machine, or a Raspberry Pi (use the `linux-arm64`
build). B needs no stream deck.

## Steps

1. On A, start DeckBridge without its own network advert, so Elgato doesn't see the dock
   at A's own IP:

   ```bash
   DECKBRIDGE_NO_MDNS=1 deckbridge
   ```

   On Windows, in PowerShell:

   ```powershell
   $env:DECKBRIDGE_NO_MDNS = "1"; deckbridge
   ```

   In Command Prompt:

   ```bat
   set "DECKBRIDGE_NO_MDNS=1" && deckbridge
   ```

2. On B, start the relay and point it at A:

   ```bash
   deckbridge relay --target <A-IP>
   ```

   The relay asks DeckBridge for the dock's serial number and model, then advertises
   itself. It keeps retrying until DeckBridge is up.

3. In Elgato on A, "DeckBridge Relay" appears as a network dock. If it doesn't, add the
   relay's IP by hand. The relay prints its IP addresses at startup.

## Flags

| Flag | Meaning |
|---|---|
| `--target <host>` | The computer that runs DeckBridge (required). |
| `--target-port <n>` | DeckBridge's CORA port. Default `5343`. |
| `--listen-host <host>` | Address the relay listens on. Default `0.0.0.0`. |
| `--name <text>` | Name Elgato shows. Default `DeckBridge Relay`. |
| `--no-advertise` | Don't advertise on the network; add the IP in Elgato by hand. |
| `--hold-seconds <n>` | Seconds the relay keeps the Stream Deck app's connection while DeckBridge is down. `0` to `3600`. Default `60`. `0` turns it off. |
| `--log-level <level>` | `debug`, `info`, `warn`, `error` or `silent`. |

The relay writes to the terminal only. Redirect the output to a file when you send a
bug report: `deckbridge relay --target <A-IP> > relay.log 2>&1`.

## Windows: pair on the same PC with WSL {#windows-wsl}

You only have one Windows PC? DeckBridge can start the relay for you inside WSL2, the
Linux layer that Windows provides. WSL2 gets its own network address, so the Stream Deck app
treats it like a second computer.

```
Windows: Stream Deck app ──▶ WSL2 relay (own IP, 172.x) ──▶ Windows: DeckBridge
```

This feature is new and has not been tested on real Windows PCs yet. Some details below are
unverified. If something fails, please [open an issue](https://github.com/lukasMega/DeckBridge/issues/257)
and attach the diagnostics report.

### What you need

- Windows 10 or 11 with WSL2 and an Ubuntu 24.04 or newer distro. Open PowerShell as
  administrator and run `wsl --install`, then restart the PC.
- WSL in its default NAT networking mode. The "mirrored" mode does not work.

### Steps

1. Open DeckBridge in the browser, click **Fix pairing for Stream Deck app 7.6.1** and
   answer the questions until you reach **Choose a fix**. Pick **Relay in WSL on this PC**.
   You can also start it from **Run setup again** in Settings.
2. Wait for the steps to turn green. The first start downloads the relay.
3. In the Stream Deck app, add a Network Dock by IP address. Use the IP the steps show
   (use its Copy button).

DeckBridge remembers the choice and starts the relay again the next time it runs.
**Turn off** (in the wizard) or **Turn off relay** (in Settings) stops it. The WSL IP
can change after you restart the PC. If it does, DeckBridge says so. Remove the old Network
Dock in the Stream Deck app and add the new IP.

While the relay is on, DeckBridge stops advertising itself on the network. The Stream Deck app
then finds the dock only at the WSL IP.

### If a step fails

DeckBridge runs no admin command for you. It shows one sentence and a command to copy.

| State | What it means | Fix |
|---|---|---|
| WSL missing | `wsl.exe` or a Linux distro is not installed. | In an admin PowerShell: `wsl --install`, then restart the PC. |
| WSL 1 | Your distro runs WSL 1, which shares the Windows IPs. | `wsl --set-version <distro> 2` |
| Mirrored networking | `.wslconfig` has `networkingMode=mirrored`. | Set `networkingMode=NAT` in `%UserProfile%\.wslconfig`, then run `wsl --shutdown`. |
| Old Linux libraries | The distro's glibc is older than 2.38, for example Ubuntu 22.04. | `wsl --install -d Ubuntu-24.04`, then `wsl --set-default Ubuntu-24.04` |
| Download failed | The relay could not be downloaded or its checksum did not match. | Check your internet connection and click **Check again**. |
| Blocked | The relay cannot reach DeckBridge on Windows. Most likely the firewall. | See below. |

The pairing row in Settings shows the same: the distro, the WSL IP and the current problem.

### Firewall

Windows may block traffic from the WSL network to DeckBridge. The relay then waits and
DeckBridge shows "Blocked". To allow it, run this in an admin PowerShell:

```powershell
New-NetFirewallRule -DisplayName "DeckBridge WSL relay" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 5343,5344 -InterfaceAlias "vEthernet (WSL*)"
```

This rule is unverified: we have not confirmed on a real PC that it fixes the block, or
that the adapter name matches on every Windows version.

### Stuck at "Add this IP" {#wsl-not-pairing}

The relay is running but the Stream Deck app does not pair:

1. Check that you added the exact IP DeckBridge shows, as a Network Dock by IP address.
2. Remove old Network Docks in the Stream Deck app, then restart the app.
3. Windows' Hyper-V firewall for WSL may block inbound connections to WSL. In an admin
   PowerShell, try:

   ```powershell
   Set-NetFirewallHyperVVMSetting -Name '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' -DefaultInboundAction Allow
   ```

   This command is unverified: we have not confirmed on a real PC that it fixes the block.
4. Still stuck? Create a diagnostics report in **Settings → Maintenance → Logging &
   diagnostics → Create report** and send it with your issue.

### What it downloads

On the first start, DeckBridge downloads the Linux release zip of the same version from GitHub
(`linux-x86_64`, or `linux-arm64` on Windows on ARM). It checks the file against the
release's SHA256 checksums, then unzips it into DeckBridge's cache folder. The installer
itself does not grow. The relay's log lines go into DeckBridge's log file under `wsl-relay`.

## macOS: pair on the same Mac with OrbStack {#macos-orbstack}

[OrbStack](https://orbstack.dev) runs a small Linux machine on your Mac with its own IP
address, so the Stream Deck app sees the relay at a different address than its own. For now
you run three commands yourself; the wizard shows them with your values filled in.

1. Install OrbStack and open it once.
2. In Terminal, create the machine (once): `orb create ubuntu:noble deckbridge-relay`.
3. Start the relay in it. The wizard's **Run** command is one short `curl` of an install
   script (with a token in the URL) that DeckBridge serves on port 44661 (or a free high port if 44661 is taken) while
   this route is selected. It is the same script as for
   [another device](#one-command): it downloads the Linux release zip that matches your
   DeckBridge version into `~/.deckbridge-relay` inside the machine, checks it against
   `SHA256SUMS.txt`, runs `deckbridge relay --target <this Mac's IP> --no-advertise`, and
   reports its progress, so the Settings pairing row shows whether it runs. Running it again
   skips the download. Keep the Terminal window open while you use the deck.
4. The relay prints its IP addresses, and the wizard and the Settings pairing row show the
   machine's IP once the relay runs. `orb -m deckbridge-relay hostname -I` also shows it.
   Add it in the Stream Deck app as a Network Dock by IP.

Run the relay inside the machine's own home, never from a folder under `/Users`: OrbStack
runs macOS binaries it finds there on the Mac itself, and that copy can't listen next to
DeckBridge (`EADDRINUSE`). The relay does not start again after a reboot yet: run step 3
again. OrbStack is free for personal use; commercial use needs a paid licence.

The pairing row in Settings has the OrbStack run command and a remove command
(`orb delete deckbridge-relay`).

### Stream Deck app blocked from the local network {#macos-local-network}

macOS treats the OrbStack machine as part of the local network, because its subnet is
directly attached to the Mac (`bridge100`). The Stream Deck app therefore needs the Local
Network permission. When that permission is off, or turned on but not yet applied, macOS drops every
connection the app makes to the relay. The relay logs nothing, and the app never pairs. A
relay on another device on your network has the same problem.

The wizard and the diagnostics report show "The Stream Deck app is blocked from the local
network" when this happens. To check it yourself, run this in Terminal right after the app
tried to connect:

```bash
/usr/bin/log show --last 5m --style compact --predicate 'process == "kernel" AND eventMessage CONTAINS "reason: NECP" AND eventMessage CONTAINS "process: Stream Deck"'
```

Any output means macOS blocked the app. To fix it:

1. Quit the Stream Deck app, including its menu bar icon.
2. Open System Settings > Privacy & Security > Local Network. Turn Stream Deck off and on.
3. Start the app again.
4. If it still does not connect, restart the Mac.

## Restarting DeckBridge {#restart}

You can stop or restart DeckBridge while the relay keeps running. The relay keeps the
Stream Deck app's connection open for up to 60 seconds. It reconnects to DeckBridge by
itself. When DeckBridge is back, the deck returns in the app. You do not pair again, and
the dock keeps its IP address.

Use `--hold-seconds <n>` to change this time. The value `0` turns the hold off. The app's
connection then closes as soon as DeckBridge stops.

A Stream Deck app that connects during the gap also waits. The relay does not refuse it.
It connects the app to DeckBridge when DeckBridge is back. If DeckBridge does not come back
within the hold time, the relay closes the connection.

The relay itself must keep running. It does not start by itself at login yet. If you stop
the relay, or restart the computer it runs on, start it again.

If the deck model or serial number changes, the relay follows the change. This happens
when you connect a different deck while DeckBridge restarts. The relay logs each change at
`warn` level.

## Notes

- B can't run a normal DeckBridge at the same time. Both use ports 5343 and 5344.
- The relay reads the dock identity once at startup. Restart it after you change the dock
  identity on A.
- macOS asks for Local Network and incoming-connection permission the first time the relay
  runs. Allow both.
- If the relay on a Mac logs `a client on main reset before the relay accepted it` and
  Elgato never pairs, the macOS firewall is the likely cause. Open System Settings >
  Network > Firewall > Options and set `deckbridge` to allow incoming connections. Do this
  again after you replace the binary with a new version: macOS treats it as a new app.
  The same relay on Linux (tested on a Raspberry Pi) needs no such step.
- Advertising on Linux needs `avahi-publish-service` (package `avahi-utils`).

## Alternative

`examples/tcp-proxy` in the repository is a small Node 24 script that does the same job
and also prints a one-line summary of every CORA frame. Use it when you need frame-level
diagnostics.
