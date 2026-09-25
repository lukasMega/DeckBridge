# References: existing projects

DeckBridge wires together prior open-source work — nothing reverse-engineered. The USB
HID framing and Elgato CORA protocol come from the projects below, credited here.

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
| [ambiso/opendeck-akp05](https://github.com/ambiso/opendeck-akp05) | AKP05/AKP05E (and Mirabox N4) plugin — per-connect init, 10 s `CRT CONNECT` keepalive, encoder/key input codes. |
| [zeccola/ajazz-akp05](https://github.com/zeccola/ajazz-akp05) | AKP05E Python SDK — hardware-confirmed notes that the `DIS`/`LIG`/`CLE`/`STP` init unlocks key reporting, and that the keepalive tick needs the `DIS` + `LIG` wake pair. |
| [Uriziel01/Ajazz-AKP153-reverse-engineering](https://github.com/Uriziel01/Ajazz-AKP153-reverse-engineering) | AKP153 USB protocol teardown. |
| [crusardri/MiraboxStreamController](https://github.com/crusardri/MiraboxStreamController) | Mirabox controller — image and input handling. |
| [MiraboxSpace/StreamDock-Device-SDK](https://github.com/MiraboxSpace/StreamDock-Device-SDK) | Vendor SDK — image format and report IDs. |
| [teras/keydeck](https://github.com/teras/keydeck) | Cross-platform deck driver. |
| [rigor789/mirabox-streamdock-node](https://github.com/rigor789/mirabox-streamdock-node) | Node Mirabox driver. |
| [kebot/mirabox-ts](https://github.com/kebot/mirabox-ts) | TypeScript Mirabox driver. |

## Fifine devices

| Project | What it gave us |
|---|---|
| [shugotekitten/opendeck-ampgd6](https://github.com/shugotekitten/opendeck-ampgd6) | D6 driver — key remap, JPEG geometry, protocol versions, and 1024-byte packets for PID `0x0060`. |
| [Phoenix557/FifineOpenSource](https://github.com/Phoenix557/FifineOpenSource) | Independent confirmation of the same D6 constants. |
| [Lyagva/companion-surface-mirabox-stream-dock](https://github.com/Lyagva/companion-surface-mirabox-stream-dock) | Companion fork that added the D6; PR #49 is the hardware-verified `0x0007` model we cloned. |
| [jasonkoon/sd-connect](https://github.com/jasonkoon/sd-connect) | Live-probed `0x0060` notes — key remap on write, raw 1-based indexes on input. |
| [TripleU613/Ampligame_D6_Pro_Linux](https://github.com/TripleU613/Ampligame_D6_Pro_Linux) | libusb notes on CRT opcodes, `STP` commit, and 180° rotation (treat as a different firmware reading). |

## Runtime & build

| Project                                                              | What it gave us                                                               |
|----------------------------------------------------------------------|-------------------------------------------------------------------------------|
| [saghul/txiki.js](https://github.com/saghul/txiki.js)                | The JS runtime DeckBridge compiles to — QuickJS-ng + libuv + libffi, no Node. |
| [lukasMega/txiki.js-with-slim-builds](https://github.com/lukasMega/txiki.js-with-slim-builds) | Slim `tjs` builds DeckBridge vendors (`slim-ffi` assets, pinned as `$TXIKI_VERSION`). |
| [@julusian/node-image-rs](https://github.com/Julusian/node-image-rs) | Reference for the Rust JPEG resize/rotate path (`deckbridge-native`).         |

---

DeckBridge: ❤️ Big Thanks to all existing projects