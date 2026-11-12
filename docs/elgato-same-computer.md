---
sidebar_position: 7
sidebar_label: Elgato on the same computer
title: Elgato app 7.6.1 on the same computer as DeckBridge
slug: /elgato-same-computer
description: Elgato Stream Deck 7.6.1 refuses a network dock on its own computer. Pair anyway with deckbridge relay on a second machine, or on Windows with the built-in WSL relay.
---

# Elgato app 7.6.1 on the same computer as DeckBridge

## The problem

Elgato Stream Deck app 7.6.1 resets the connection to a network dock whose IP address
belongs to the same computer. `127.0.0.1`, the computer's LAN IP and its Tailscale IP all
fail, so DeckBridge never pairs ([#257](https://github.com/lukasMega/DeckBridge/issues/257)).
Version 7.6.0 is not affected, and neither is a setup where Elgato runs on another computer
than DeckBridge.

## The fix: a relay on a second machine

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

1. Open DeckBridge in the browser. On the "Connect your control app" screen, find the card
   "Using Stream Deck app 7.6.1?" and click **Pair through WSL**. You can also turn it on in
   Settings.
2. Wait for the steps in the card to turn green. The first start downloads the relay.
3. In the Stream Deck app, add a Network Dock by IP address. Use the IP the card shows
   (use its Copy button).

DeckBridge remembers the switch and starts the relay again the next time it runs. The WSL IP
can change after you restart the PC. If it does, DeckBridge says so. Remove the old Network
Dock in the Stream Deck app and add the new IP.

While the switch is on, DeckBridge stops advertising itself on the network. The Stream Deck app
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
