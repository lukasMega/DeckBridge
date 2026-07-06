# DeckBridge

Use a USB Stream Deck with the Elgato Stream Deck app **over your local network** — no
[Elgato Network Dock](https://www.elgato.com/us/en/p/network-dock-stream-deck) (>60 USD)
required.

Plug your deck into any computer, run DeckBridge there, and the Elgato app on any machine
on the same network finds it like real Elgato hardware. One small program (<5 MB), nothing
else to install.

**📖 Documentation:** <https://lukasmega.github.io/DeckBridge/>

## Supported devices

- Mirabox 293V3 / Ajazz
- Mirabox 293S
- Mirabox K1 Pro
- Stream Deck MK.2
- Stream Deck Mini

Hardware-tested on macOS: 293V3, 293S, K1 Pro, and Stream Deck Mini. MK.2 and the
Linux/Windows builds are implemented but not hardware-verified.

## Quick start

1. Download the release for your OS, unzip, and run `deckbridge`.
2. Plug in your deck.
3. Open the Elgato Stream Deck app on any machine on the same network — it discovers
   DeckBridge automatically.

A web page at <http://localhost:3000> shows your deck's keys and a live log.

Full install and troubleshooting steps:
[Getting Started](https://lukasmega.github.io/DeckBridge/getting-started).

## ⚠ Hobby use only

DeckBridge is a free community tool for personal and hobby use. It is not affiliated
with, endorsed by, or supported by Elgato / Corsair, and it does not replace the Elgato
Network Dock. For professional or reliable setups, use officially supported Elgato
hardware.

DeckBridge contains no reverse-engineered code — it reuses existing open-source projects
([credits](https://lukasmega.github.io/DeckBridge/references)).

## For developers

Build from source, architecture, protocols, and testing: [ARCHITECTURE.md](ARCHITECTURE.md).
Technical guides:
[Adding a device](https://lukasmega.github.io/DeckBridge/adding-a-device) ·
[Image flow](https://lukasmega.github.io/DeckBridge/image-flow) ·
[HID via FFI](https://lukasmega.github.io/DeckBridge/hidapi-ffi)
