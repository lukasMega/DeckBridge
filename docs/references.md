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
| [Uriziel01/Ajazz-AKP153-reverse-engineering](https://github.com/Uriziel01/Ajazz-AKP153-reverse-engineering) | AKP153 USB protocol teardown. |
| [crusardri/MiraboxStreamController](https://github.com/crusardri/MiraboxStreamController) | Mirabox controller — image and input handling. |
| [MiraboxSpace/StreamDock-Device-SDK](https://github.com/MiraboxSpace/StreamDock-Device-SDK) | Vendor SDK — image format and report IDs. |
| [teras/keydeck](https://github.com/teras/keydeck) | Cross-platform deck driver. |
| [rigor789/mirabox-streamdock-node](https://github.com/rigor789/mirabox-streamdock-node) | Node Mirabox driver. |
| [kebot/mirabox-ts](https://github.com/kebot/mirabox-ts) | TypeScript Mirabox driver. |

## Fifine devices

| Project | What it gave us |
|---|---|
| [shugotekitten/opendeck-ampgd6](https://github.com/shugotekitten/opendeck-ampgd6) | AmpliGame D6 driver — the `IMAGE_MAP` key remap (identical to the 293V3), JPEG geometry, and the split between the write and reader protocol versions. Its PRs #4, #5, #6 and #7 are four independent reports that PID `0x0060` needs 1024-byte packets; #6 and #7 also put that revision's panel at 112×112 and its protocol at v3 (press+release). PR #7 explains *why* a wrong packet size is invisible — the board reports `MaxOutputReportSize = 1024` and silently discards short writes while `write()` still returns success, which is what `wire.packetSizeCandidates` now probes for. |
| [Phoenix557/FifineOpenSource](https://github.com/Phoenix557/FifineOpenSource) | Independent confirmation of the same D6 constants (VID/PID, HID usage, image map, protocol versions) from a separate Tauri/Rust implementation. |
| [Lyagva/companion-surface-mirabox-stream-dock](https://github.com/Lyagva/companion-surface-mirabox-stream-dock) | Fork of Companion's Mirabox surface that added the D6. Its PR #49 (upstream) is the hardware-verified `0x0007` entry we cloned the model from. PR #1 is a *different* fix for the `0x0060` black screen: it keeps 512-byte control packets and instead enlarges the image chunks, serializes the writes and paces them 2 ms apart — the pacing `wire.chunkDelayMs` exposes. |
| [jasonkoon/sd-connect](https://github.com/jasonkoon/sd-connect) | Live-probed `0x0060` notes. Confirmed the key remap empirically (painted every key with its own index and read back the grid) and that button input is *not* remapped — the device reports raw 1-based indexes in raster order, the read/write asymmetry our `inputOffset: 1` encodes. Its 95 px icon size is the low end of the unresolved panel-resolution split (see O1). |
| [TripleU613/Ampligame_D6_Pro_Linux](https://github.com/TripleU613/Ampligame_D6_Pro_Linux) | libusb reverse-engineering notes on `0x0060` from Fifine's `SDLibrary1.dll`: the CRT opcode set, the per-image `STP` commit, and the 180° image rotation. Treat with care — it is the only source that reads `0x0060` as a pre-release "HID DEMO" firmware rather than a later revision. |

## Runtime & build

| Project                                                              | What it gave us                                                               |
|----------------------------------------------------------------------|-------------------------------------------------------------------------------|
| [saghul/txiki.js](https://github.com/saghul/txiki.js)                | The JS runtime DeckBridge compiles to — QuickJS-ng + libuv + libffi, no Node. |
| [@julusian/node-image-rs](https://github.com/Julusian/node-image-rs) | Reference for the Rust JPEG resize/rotate path (`deckbridge-native`).         |

---

DeckBridge: ❤️ Big Thanks to all existing projects