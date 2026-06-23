# References: existing projects

DeckBridge wires together prior open-source work — nothing here was reverse-engineered
from scratch. The USB HID framing and the Elgato CORA network protocol both come from the
projects below. This page credits them and points to where each one helped.

The matching source lives in the repo under `reference-elgato/` (CORA / Elgato side) and
`reference-other/` (Mirabox / Ajazz side).

---

## Elgato CORA protocol & Stream Deck

| Project | What it gave us |
|---|---|
| [elgatosf/streamdeck](https://github.com/elgatosf/streamdeck) | Official Elgato plugin SDK — reference for device behaviour and the app side. |
| [Julusian/node-elgato-stream-deck](https://github.com/Julusian/node-elgato-stream-deck) | HID report formats, key-image framing, and per-model geometry. |
| [HakanL/Haukcode.StreamDeck](https://github.com/HakanL/Haukcode.StreamDeck) | C# implementation — clearest reference for the CORA network-dock wire protocol. |
| [bitfocus/companion-surface-elgato-stream-deck](https://github.com/bitfocus/companion-surface-elgato-stream-deck) | Companion's surface driver — handshake and input-report handling. |
| [bitfocus/companion-surface-mirabox-stream-dock](https://github.com/bitfocus/companion-surface-mirabox-stream-dock) | Companion's Mirabox surface — bridges both ecosystems. |

## Mirabox / Ajazz devices

| Project | What it gave us |
|---|---|
| [4ndv/mirajazz](https://github.com/4ndv/mirajazz) | Mirabox/Ajazz protocol library — primary reference for the non-Elgato decks. |
| [4ndv/opendeck-akp153](https://github.com/4ndv/opendeck-akp153) | AKP153 (293-series) driver details. |
| [Uriziel01/Ajazz-AKP153-reverse-engineering](https://github.com/Uriziel01/Ajazz-AKP153-reverse-engineering) | AKP153 USB protocol teardown. |
| [crusardri/MiraboxStreamController](https://github.com/crusardri/MiraboxStreamController) | Mirabox controller — image and input handling. |
| [MiraboxSpace/StreamDock-Device-SDK](https://github.com/MiraboxSpace/StreamDock-Device-SDK) | Vendor SDK — image format and report IDs. |
| [teras/keydeck](https://github.com/teras/keydeck) | Cross-platform deck driver. |
| [rigor789/mirabox-streamdock-node](https://github.com/rigor789/mirabox-streamdock-node) | Node Mirabox driver. |
| [kebot/mirabox-ts](https://github.com/kebot/mirabox-ts) | TypeScript Mirabox driver. |

## Runtime & build

| Project | What it gave us |
|---|---|
| [saghul/txiki.js](https://github.com/saghul/txiki.js) | The JS runtime DeckBridge compiles to — QuickJS-ng + libuv + libffi, no Node. |
| [@julusian/image-rs](https://github.com/Julusian/image-rs) | Reference for the Rust JPEG resize/rotate path (`deckbridge-native`). |

---

DeckBridge: ❤️ Big Thanks to all existing projects