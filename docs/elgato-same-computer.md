---
sidebar_position: 7
sidebar_label: Elgato on the same computer
title: Elgato app 7.6.1 on the same computer as DeckBridge
slug: /elgato-same-computer
description: Elgato Stream Deck 7.6.1 refuses a network dock on its own computer. Run deckbridge relay on a second machine to pair anyway.
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
