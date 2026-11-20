---
sidebar_position: 7
sidebar_label: Elgato on the same computer
title: Elgato app 7.6.1 on the same computer as DeckBridge
slug: /elgato-same-computer
description: Elgato Stream Deck 7.6.1 refuses a network dock on its own computer. Fix it with the Fix pairing wizard in DeckBridge - use app 7.6.0, a relay on another device, a relay in WSL on Windows, or a relay in OrbStack on a Mac.
---

# Elgato app 7.6.1 on the same computer as DeckBridge

## The problem

Stream Deck app 7.6.1 resets the connection to a network dock whose IP address belongs to
its own computer. `127.0.0.1`, the LAN IP and the Tailscale IP all fail, so DeckBridge never
pairs ([#257](https://github.com/lukasMega/DeckBridge/issues/257)). App 7.6.0 works, and so
does Elgato on a different computer than DeckBridge.

## Fix it with the wizard

On the pairing screen, click **Fix pairing for Stream Deck app 7.6.1**. If DeckBridge finds
app 7.6.1 or newer on this computer, the wizard also opens once by itself. Later, open it
from **Fix pairing** in the warning banner, or from **Run setup again** in Settings >
"Stream Deck app 7.6.1 pairing". The wizard is not shown on Linux.

The wizard asks for your app version (prefilled; "Not sure" counts as 7.6.1 or newer), where
the app runs, and whether you have another device on the network. If you answer "7.6.0 or
older" or "On another computer", no fix is needed: the app pairs with DeckBridge directly.
Otherwise it lists the fixes below, marks one **Recommended**, and shows the steps for the
one you pick. The downgrade is always listed, the other-device relay only if you have one,
and the WSL relay only on Windows.

<details>
<summary>Compare the fixes: memory, disk, setup time, cost</summary>

| Fix | Memory | Disk | Setup | Cost | Needs |
|---|---|---|---|---|---|
| Use Stream Deck app 7.6.0 | none | none | ~5 min | free | Turn off app updates. You miss newer app fixes. |
| Relay on another device | ~15 MB on that device | ~30 MB | ~5 min | free if you own one (Raspberry Pi Zero 2 W ~$15) | 64-bit Linux, macOS or Windows; stays on |
| Relay in WSL on this PC | ~300-600 MB while on | ~1.5-2 GB | ~2 min, or 15 min + restart | free | Windows 10 2004+ or 11 |
| Relay in OrbStack on this Mac | ~150 MB-1 GB | ~0.8 GB | ~5 min | free for personal use; $8/month commercial | macOS |

</details>

A relay in Apple's `container` tool (macOS 26) is coming later.

- **Use Stream Deck app 7.6.0.** No relay. The wizard links the 7.6.0 download (Windows) or
  the Elgato 7.6 release notes (macOS). Install it over your current version, then turn off
  automatic updates in Preferences > General.
- **Relay on another device.** See [one command](#one-command); on a Windows device use
  [the manual relay](#manual-relay). A Raspberry Pi needs 64-bit Raspberry Pi OS Trixie.
- **Relay in WSL on this PC.** See [Windows with WSL](#windows-wsl).
- **Relay in OrbStack on this Mac.** See [macOS with OrbStack](#macos-orbstack).

With any relay, add the relay's IP in the Stream Deck app as a Network Dock by IP. While a
relay is set up, DeckBridge stops advertising itself on the network, so the app finds the
dock only at the relay's IP. **Turn off relay** in Settings undoes this.

## Another device: one command {#one-command}

The wizard shows one line (with a `curl` / `wget` switch) to paste in a terminal on a Linux
or macOS device on the same network:

```
curl -fsSL "http://<this computer's IP>:44661/relay.sh?t=<token>" | sh
```

<details>
<summary>What the script does</summary>

While this route is selected, DeckBridge serves the script on port 44661, or on a free high
port if 44661 is taken. The port must be reachable from the LAN; you do not need `--bind`.
The script:

- checks the device: Linux needs glibc 2.38 or newer (Raspberry Pi OS Trixie, Debian 13,
  Ubuntu 24.04);
- downloads the release zip for your DeckBridge version from GitHub, checks it against
  `SHA256SUMS.txt` and unpacks it into `~/.deckbridge-relay` (a second run skips the
  download);
- runs `deckbridge relay --target <this computer's IP> --no-advertise` in the terminal and
  reports its progress to DeckBridge.

</details>

Keep the terminal open while you use the deck. The relay has no autostart yet: after a
reboot, run the command again.

The wizard shows **Downloading**, **Initializing**, **Connecting**, then **Connected on
<IP>**: add that IP in the Stream Deck app. With no report for 90 seconds it shows **Relay
offline**; a failed step shows its reason. It warns if the relay runs a different DeckBridge
version than this computer.

<details>
<summary>Token and uninstall</summary>

The token only lets the script fetch itself and report progress. It is stored in
`settings.json`, shown only in the wizard command, and left out of diagnostics and exports.
DeckBridge uses the address the report comes from and ignores any address inside it. To
remove everything from the device:

```
curl -fsSL "<the same URL>" | sh -s -- --uninstall
```

</details>

### Check the relay in Settings {#relay-settings}

Settings > **Stream Deck app 7.6.1 pairing** shows:

- **Status**: Running, Installing, Offline, Failed or Not reported yet.
- **Seen**: when the relay last reported.
- **Relay**: the relay's IP, to add in the Stream Deck app.
- **Build**: the relay's platform and version.
- **Target**: the address the relay connects to on this computer.
- **App**: whether the Stream Deck app is paired through the relay.

**Offline** means no heartbeat for 90 seconds: the device is off, the terminal was closed or
the network is down. After the device restarts, copy **Run** and paste it on the device
again. **Uninstall** copies the removal command. On a version warning, run the command again
to update the relay.

## The manual relay: a second machine {#manual-relay}

`deckbridge relay` runs on a second computer, B. Elgato on computer A connects to the relay,
sees a foreign IP and pairs. The relay passes every byte on to DeckBridge on A.

```
Computer A: Elgato 7.6.1 ──TCP──▶ Computer B: deckbridge relay ──TCP──▶ Computer A: DeckBridge
                                  :5343 and :5344                       :5343 and :5344
```

B can be a Mac, a Windows PC, a Linux machine or a Raspberry Pi (use the `linux-arm64`
build). B needs no stream deck, and can't run a normal DeckBridge at the same time: both use
ports 5343 and 5344.

### Steps

1. On A, start DeckBridge without its network advert, so Elgato doesn't find the dock at
   A's own IP:

   ```bash
   DECKBRIDGE_NO_MDNS=1 deckbridge
   ```

   <details>
   <summary>On Windows</summary>

   In PowerShell:

   ```powershell
   $env:DECKBRIDGE_NO_MDNS = "1"; deckbridge
   ```

   In Command Prompt:

   ```bat
   set "DECKBRIDGE_NO_MDNS=1" && deckbridge
   ```

   </details>

2. On B, start the relay and point it at A:

   ```bash
   deckbridge relay --target <A-IP>
   ```

   The relay asks DeckBridge for the dock's serial number and model, then advertises itself.
   It retries until DeckBridge is up. It reads the dock identity only at startup: restart it
   after you change the dock identity on A.

3. In Elgato on A, "DeckBridge Relay" appears as a network dock. If it doesn't, add the
   relay's IP by hand; the relay prints its IP addresses at startup.

<details>
<summary>Flags and logging</summary>

| Flag | Meaning |
|---|---|
| `--target <host>` | The computer that runs DeckBridge (required). |
| `--target-port <n>` | DeckBridge's CORA port. Default `5343`. |
| `--listen-host <host>` | Address the relay listens on. Default `0.0.0.0`. |
| `--name <text>` | Name Elgato shows. Default `DeckBridge Relay`. |
| `--no-advertise` | Don't advertise on the network; add the IP in Elgato by hand. |
| `--hold-seconds <n>` | How long the relay keeps the app's connection while DeckBridge is down (see [Restarting DeckBridge](#restart)). `0` to `3600`, default `60`, `0` turns it off. |
| `--log-level <level>` | `debug`, `info`, `warn`, `error` or `silent`. |

The relay logs to the terminal only. For a bug report, redirect it to a file:
`deckbridge relay --target <A-IP> > relay.log 2>&1`.

</details>

## Windows: pair on the same PC with WSL {#windows-wsl}

Only one Windows PC? DeckBridge can run the relay for you inside WSL2, the Linux layer of
Windows. WSL2 has its own IP address, so the Stream Deck app treats it as a second computer.

```
Windows: Stream Deck app ──▶ WSL2 relay (own IP, 172.x) ──▶ Windows: DeckBridge
```

:::caution
This feature is new and not yet tested on real Windows PCs. Commands marked *(unverified)*
are not confirmed to fix the problem. If something fails, please
[open an issue](https://github.com/lukasMega/DeckBridge/issues/257) and attach the
diagnostics report.
:::

### What you need

- Windows 10 or 11 with WSL2 and an Ubuntu 24.04 or newer distro. To install it, run
  `wsl --install` in PowerShell as administrator, then restart the PC.
- WSL in its default NAT networking mode. "Mirrored" mode does not work.

### Steps

1. In the wizard, pick **Relay in WSL on this PC**. You can also start it from **Run setup
   again** in Settings.
2. Wait for the steps to turn green. The first start downloads the relay.
3. In the Stream Deck app, add a Network Dock by IP with the IP the steps show (use its Copy
   button).

DeckBridge remembers the choice and starts the relay again on its next run. **Turn off** (in
the wizard) or **Turn off relay** (in Settings) stops it. The WSL IP can change after a PC
restart. DeckBridge then tells you: remove the old Network Dock in the Stream Deck app and add
the new IP.

<details>
<summary>If a step fails</summary>

DeckBridge runs no admin command for you. It shows one sentence and a command to copy. The
pairing row in Settings shows the same, plus the distro and the WSL IP.

| State | What it means | Fix |
|---|---|---|
| WSL missing | `wsl.exe` or a Linux distro is not installed. | In an admin PowerShell: `wsl --install`, then restart the PC. |
| WSL 1 | Your distro runs WSL 1, which shares the Windows IPs. | `wsl --set-version <distro> 2` |
| Mirrored networking | `.wslconfig` has `networkingMode=mirrored`. | Set `networkingMode=NAT` in `%UserProfile%\.wslconfig`, then run `wsl --shutdown`. |
| Old Linux libraries | The distro's glibc is older than 2.38, for example Ubuntu 22.04. | `wsl --install -d Ubuntu-24.04`, then `wsl --set-default Ubuntu-24.04` |
| Download failed | The relay could not be downloaded or its checksum did not match. | Check your internet connection and click **Check again**. |
| Blocked | The relay cannot reach DeckBridge on Windows. Most likely the firewall. | See below. |

</details>

<details>
<summary>Firewall</summary>

Windows may block traffic from the WSL network to DeckBridge. The relay then waits and
DeckBridge shows "Blocked". To allow it, run this in an admin PowerShell *(unverified, and
the adapter name may differ between Windows versions)*:

```powershell
New-NetFirewallRule -DisplayName "DeckBridge WSL relay" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 5343,5344 -InterfaceAlias "vEthernet (WSL*)"
```

</details>

### Stuck at "Add this IP" {#wsl-not-pairing}

The relay runs, but the Stream Deck app does not pair:

1. Check that you added the exact IP DeckBridge shows, as a Network Dock by IP.
2. Remove old Network Docks in the Stream Deck app, then restart the app.
3. The Hyper-V firewall for WSL may block inbound connections to WSL. In an admin
   PowerShell, try *(unverified)*:

   ```powershell
   Set-NetFirewallHyperVVMSetting -Name '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' -DefaultInboundAction Allow
   ```

4. Still stuck? Create a report in **Settings → Maintenance → Logging & diagnostics →
   Create report** and send it with your issue.

<details>
<summary>What it downloads</summary>

On the first start, DeckBridge downloads the Linux release zip of the same version from
GitHub (`linux-x86_64`, or `linux-arm64` on Windows on ARM), checks it against the release's
SHA256 checksums and unzips it into DeckBridge's cache folder. The installer itself does not
grow. The relay's log lines go into DeckBridge's log file under `wsl-relay`.

</details>

## macOS: pair on the same Mac with OrbStack {#macos-orbstack}

[OrbStack](https://orbstack.dev) runs a small Linux machine on your Mac with its own IP
address, so the Stream Deck app sees the relay at a different address. For now you run three
commands yourself; the wizard shows them with your values filled in. OrbStack is free for
personal use; commercial use needs a paid licence.

1. Install OrbStack and open it once.
2. In Terminal, create the machine (once): `orb create ubuntu:noble deckbridge-relay`.
3. Paste the wizard's **Run** command. It runs the [same install script](#one-command)
   inside the machine, with this Mac's IP as the target. Keep the Terminal window open while
   you use the deck, and run this step again after a reboot.
4. Add the machine's IP in the Stream Deck app as a Network Dock by IP. The relay prints it,
   the wizard and the Settings pairing row show it once the relay runs, and
   `orb -m deckbridge-relay hostname -I` shows it too.

Run the relay in the machine's own home, never from a folder under `/Users`: OrbStack runs
macOS binaries it finds there on the Mac itself, and that copy can't listen next to
DeckBridge (`EADDRINUSE`).

The pairing row in Settings has the run command and a remove command
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

You can stop or restart DeckBridge while the relay keeps running. The relay holds the Stream
Deck app's connection open for up to 60 seconds and reconnects to DeckBridge by itself. The
deck then returns in the app: no new pairing, same dock IP. `--hold-seconds <n>` changes the
time; `0` turns the hold off, so the app's connection closes as soon as DeckBridge stops.

An app that connects during the gap also waits instead of being refused, and is connected
when DeckBridge is back. If DeckBridge isn't back within the hold time, the relay closes the
connection.

The relay itself must keep running. It doesn't start at login yet: if you stop it or restart
its computer, start it again.

If you connect a different deck while DeckBridge restarts, the relay follows the new model
and serial number and logs each change at `warn` level.

## Notes

- macOS asks for Local Network and incoming-connection permission the first time the relay
  runs. Allow both.
- If the relay on a Mac logs `a client on main reset before the relay accepted it` and
  Elgato never pairs, the macOS firewall is the likely cause. In System Settings > Network >
  Firewall > Options, allow incoming connections for `deckbridge`. Do this again after each
  new binary version: macOS treats it as a new app. On Linux (tested on a Raspberry Pi) the
  relay needs no such step.
- Advertising on Linux needs `avahi-publish-service` (package `avahi-utils`).

## Alternative

`examples/tcp-proxy` in the repository is a small Node 24 script that does the same job and
also prints a one-line summary of every CORA frame. Use it for frame-level diagnostics.
