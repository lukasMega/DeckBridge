---
sidebar_position: 5
sidebar_label: Browser deck
title: Browser deck — a phone or tablet as a Stream Deck
slug: /browser-deck
description: Use any phone or tablet browser as one more network dock for the Elgato Stream Deck software, with its own profile and live key images.
---

# Browser deck

Turn an old phone or tablet into a Stream Deck. DeckBridge shows the page as **one more
network dock** to the Elgato app: it gets its own profile, the keys show the images the
Elgato app sends, and a tap (or a long press) on the glass reaches the app exactly like a
press on a USB deck. No USB deck is needed.

**Off by default.** Nothing listens until you turn it on.

## What you need

- iOS / iPadOS **12.2 or newer** (Safari), Android **7 or newer** with Chrome **80 or
  newer**, or any current desktop browser. iOS 12.1 and older is not supported.
- The phone and the computer running DeckBridge on the same network.
- The layout is a Stream Deck MK.2: 15 keys, 5 × 3. No side keys, dials or touch strip.

## Set it up

1. Open the DeckBridge web UI → **Settings → Browser deck** and turn on
   *Use a phone or tablet as a deck*. A new dock card appears ("Browser deck").
2. Press **Pair a device**. A QR code, a 6-digit code and the page address appear for five
   minutes.
3. On the phone, scan the QR code (iOS Camera, most Android cameras) or open the address
   and type the 6-digit code. The keys appear.
4. In the **Elgato app**, add the dock: *Add Network Device…* with the IP address and the
   port shown on the dock card (the browser deck uses ports **5349 / 5350**, its page uses
   **44660**).

The QR code needs a small library. DeckBridge asks before fetching it from a CDN; if you
decline, or you are offline, the 6-digit code and the address always work.

### One dock per IP address

The Elgato app pairs **one network dock per IP address** of the computer. Your first deck
normally uses `127.0.0.1`, a second one the computer's LAN address. The browser deck needs
a third address, for example `127.0.0.2`. The **Need another address?** link in the panel
opens a short guide: it shows the command for your system and a **Test** button that checks
the result.

| System | What to do |
|---|---|
| macOS | `sudo ifconfig lo0 alias 127.0.0.2 up` (undo: `sudo ifconfig lo0 -alias 127.0.0.2`). Does not survive a reboot. |
| Linux | Usually nothing: all of `127.0.0.0/8` is already on the loopback interface. If the test fails: `sudo ip addr add 127.0.0.2/8 dev lo`. |
| Windows | Usually nothing. If the test fails, use the computer's LAN address or a VPN adapter address instead. |

DeckBridge never runs `sudo` for you. Linux and Windows are not verified on every
configuration yet; the **Test** button is the source of truth.

## Using the deck

- **Tap** fires a key; **press and hold** works for long-press actions. Several fingers on
  several keys work.
- Sliding a finger off a key does not press another key; the first key releases on lift.
- Brightness changes (from the web UI slider) dim the page.
- A dot shows the connection: green = live, amber = reconnecting.
- Lock the phone or switch apps and every held key is released within about four seconds.
  A press that was delayed by a bad network is dropped, never replayed late.

### Keep the screen on, full screen

Browsers only offer a screen wake lock on secure pages, and the deck page is plain HTTP on
your LAN. Set **Auto-Lock / Screen timeout to Never** on a dedicated device. On iOS, *Share →
Add to Home Screen* opens the page full screen from an icon, and it stays paired. On
Android, *Add to Home screen* makes a shortcut to the page.

## Several pages at once

Up to four pages can show the same deck at once (mirrored). Any of them can press; a key
held on one stays down until every holder lets go. Up to eight devices can be paired.

## Security

- The page is **plain HTTP** on your LAN, like the CORA ports. Anyone who can sniff your
  network could read images and the pairing token.
- A paired device holds a token that can **only** show this deck and press its keys. It
  cannot call the web UI or the [Push API](./push-api.md), and a Push API token cannot open
  the deck.
- A key can run whatever you bound to it in the Elgato app, so **a stolen token is the same
  as physical access to the deck**. The panel lists paired devices with *last seen* and
  *connected now*; **Revoke** drops a device at once, **Revoke all** removes every one.
- The deck listener serves the page, the pairing call and one WebSocket, nothing else. The
  admin web UI stays on `127.0.0.1` unless you pass `--bind`.
- `--bind 127.0.0.1` makes the deck listener loopback-only too: phones cannot reach it.
  Tokens are never exported, imported or put in a diagnostics report.

Pairing codes are single-use and expire after five minutes; five wrong guesses cancel the
pending pairing.

## Settings and ports

| Item | Value |
|---|---|
| Setting | `settings.json` → `"virtualDeck": { "enabled": false, "profile": "mk2" }` |
| Page and WebSocket | `44660` (override with `DECKBRIDGE_DECK_PORT`; no fallback port, because paired devices bookmark the URL) |
| CORA pair (the dock the Elgato app pairs) | `5349` / `5350` (shift with `DECKBRIDGE_CORA_PORT`) |

Enabling the browser deck from a settings file you import is ignored on purpose: it opens a
LAN listener, so it is only ever turned on from the web UI.

## Troubleshooting

- **The phone cannot open the address** — allow inbound TCP on 44660 in your firewall; check
  that DeckBridge is not started with `--bind 127.0.0.1`; use the IP address, not a host name.
- **The address stopped working** — the computer's IP changed (DHCP). Open the panel for the
  new address, or give the computer a fixed address in your router.
- **"Code expired"** — create a new one in the panel; a code works once.
- **The Elgato app refuses the dock** — it already has a dock on that IP address; use the
  address guide above for another one.
- **"port 44660 is already in use"** — another program owns it; set `DECKBRIDGE_DECK_PORT`.
- **Keys feel late on Wi-Fi** — open the page with `?debug=1` for round-trip times. 5 GHz
  Wi-Fi keeps them under about 150 ms.
