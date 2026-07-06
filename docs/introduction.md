---
sidebar_position: 1
sidebar_label: Introduction
title: DeckBridge
slug: /introduction
description: What DeckBridge is — use a USB Stream Deck with the Elgato app over your local network.
---

**DeckBridge** lets you use a USB Stream Deck with the Elgato Stream Deck app over your
local network. It runs on your computer and appears to the app as a network device, so your
keys and button images work over WiFi — no
[Elgato Network Dock](https://www.elgato.com/us/en/p/network-dock-stream-deck) required.

It's a free, community-built tool for personal and hobby use, shipped as a **standalone
binary** (<5MB, no Node.js runtime needed).

> New here? Head to **[Getting Started](/getting-started)** to install and connect a deck.

## How it works

DeckBridge speaks USB HID to the plugged-in deck and emulates an Elgato Network Dock on
the LAN (TCP/CORA, advertised over mDNS). The Elgato app discovers it like real hardware —
key presses travel up, button images travel down, each image resized/rotated to match the
device before the USB write.

## Supported devices

- **Mirabox 293V3/Ajazz**
- **Mirabox 293S**
- **Mirabox K1 Pro**
- **Stream Deck MK.2**
- **Stream Deck Mini**

Hardware-tested on macOS: 293V3, 293S, K1 Pro, and Stream Deck Mini; MK.2 and the
Linux/Windows builds are implemented but not hardware-verified.

<div style="border-left:4px solid #e6a700;background:rgba(230,167,0,0.12);padding:12px 16px;border-radius:6px;margin:20px 0">
<strong>⚠ Disclaimer</strong><br/>
DeckBridge is not affiliated with, endorsed by, or supported by Elgato / Corsair. &ldquo;Stream Deck&rdquo; and &ldquo;Elgato&rdquo; are trademarks of their respective owners. DeckBridge is intended for <strong>hobby and personal use only — not for professional use</strong> — and it <strong>does not replace the Elgato Network Dock</strong>. For professional or reliable setups, use officially supported Elgato hardware.
</div>

<div style="border-left:4px solid #25c2a0;background:rgba(37,194,160,0.1);padding:12px 16px;border-radius:6px;margin:20px 0">
<strong>ℹ Nothing reverse-engineered</strong><br/>
DeckBridge contains <strong>no reverse-engineered code</strong>. The USB HID and Elgato CORA protocol handling is <strong>reused from existing open-source projects</strong> — DeckBridge only wires that prior work together. Full credits: <a href="/references">References</a>.
</div>
