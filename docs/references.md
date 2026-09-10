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

## Ulanzi devices

The Ulanzi Stream Controller D200 is a *page*-protocol device (a ZIP archive of PNGs plus
a JSON manifest, not per-key image writes), so its support was written from these sources
rather than from any existing DeckBridge driver.

**Licence note.** DeckBridge is MIT, so only the MIT-licensed projects below were read as
implementation references. `glmagalhaes/rs-ulanzi-d200` (and its OpenActionMirrors mirror)
is **AGPL-3.0**: it is listed for *facts only* — opcodes, sizes and hardware observations,
which are not copyrightable — and its code was **not** used as an implementation template.

| Project | What it gave us |
|---|---|
| [redphx/strmdck](https://github.com/redphx/strmdck) | The root upstream. VID:PID `0x2207:0x0019`, 13 buttons on a 3×5 grid, 196×196 icons, the opcode table (`SET_BUTTONS` 0x0001, `SET_SMALL_WINDOW_DATA` 0x0006, `SET_BRIGHTNESS` 0x000a, `SET_LABEL_STYLE` 0x000b, `PARTIALLY_UPDATE_BUTTONS` 0x000d, `IN_BUTTON` 0x0101, `IN_DEVICE_INFO` 0x0303) and the `7c7c | cmd u16 | len u32-LE | 1016 B` packet layout. |
| [bitfocus/companion-surface-ulanzi-stream-controller](https://github.com/bitfocus/companion-surface-ulanzi-stream-controller) | Bitfocus's official surface: the lock/unlock opcodes (0x000f/0x0010), the small-window mode enum (including the digital-clock modes 200–203) and the Linux "direct connect fails, use a USB-2 hub" finding. Its issues #13 and #16 are the missing-icon and silent-revert reports behind our flush rate limit. |
| [jcalado/companion-surface-d200](https://github.com/jcalado/companion-surface-d200) | The most complete writeup: interface 0 endpoints and 1024-byte interrupt reports, the report-id byte node-hid prepends, the chunk-boundary-byte rule, the manifest fields the EasyUI firmware needs (`ViewParam[0].Font`, the `3_2` entry with `SmallViewMode`), the `0x0303` identity JSON, the 75 ms flush debounce and first-full-then-partial strategy, and — from disassembly — that brightness is `strtol()`'d ASCII. Its issue #8 is the ~17-minute sustained-write stall. |
| [marcelobrake/ulanzi-linux](https://github.com/marcelobrake/ulanzi-linux) | Independent Python implementation of the same wire format: manufacturer `Zkswe`, product `ulanzi`, a per-unit serial, the ~5 s firmware watchdog reset by any outbound write, and the `manifest.json` + `Images/<name>.png` archive layout. |
| [aleyvag/ulanzi-d200h-linux](https://github.com/aleyvag/ulanzi-d200h-linux) | The rigorous one, and the only source for the *other* firmware generation (Qt `UlanziDeckKey` on RK3308). Capture-verified: the unnumbered Consumer-page (`0x0c`/`0x01`) report descriptor on interface 0, the **handshake ordering rule** we implement (clock → drain the reply → first ZIP, else the firmware ACKs and renders nothing), `0x010b` = ZIP ACK and `0x0103` = ~1 Hz heartbeat, the 196×196 icon requirement, the ~196 KB page cap, that empty manifest slots break later page changes, and the per-key input byte layout. |
| [doitian/ulanzi-studio-niri](https://github.com/doitian/ulanzi-studio-niri) | USB-sniffed D200X notes: the input-streaming unlock opcode and the encoder wire ids. DeckBridge deliberately does **not** send that opcode — see the non-goals in the plan. |
| [realhidden/node-unlanzi-d200](https://github.com/realhidden/node-unlanzi-d200) | The counter-evidence on partial updates: reports ghost/white buttons from the 0x000d opcode and uses full pages only. Why `page.partialUpdates` is a one-line flag. |
| [puritysb/AgentDeck](https://github.com/puritysb/AgentDeck) | That a D200H reports `DeviceType:"D200"` and is protocol-compatible, and that the device only enters HID mode a few seconds after plug-in. |
| [racerxdl/ulanzi-d200-linux](https://github.com/racerxdl/ulanzi-d200-linux) | Corroboration of the same constants; its PR #11 is the finding that a padding entry only fixes the chunk-boundary problem when it is placed *first* in the archive. |
| [mapero/esphome-ulanzi-d200](https://github.com/mapero/esphome-ulanzi-d200), [zentala/ulanzi-deck-d200-plugin-example](https://github.com/zentala/ulanzi-deck-d200-plugin-example), [iBobbyTS/UlanziDeckSwift](https://github.com/iBobbyTS/UlanziDeckSwift) | Hardware corroboration: the SoC family, the 5×3 grid with a double-wide bottom-right slot, and the D200 / D200H / D200X product line. |

## Runtime & build

| Project                                                              | What it gave us                                                               |
|----------------------------------------------------------------------|-------------------------------------------------------------------------------|
| [saghul/txiki.js](https://github.com/saghul/txiki.js)                | The JS runtime DeckBridge compiles to — QuickJS-ng + libuv + libffi, no Node. |
| [@julusian/node-image-rs](https://github.com/Julusian/node-image-rs) | Reference for the Rust JPEG resize/rotate path (`deckbridge-native`).         |

---

DeckBridge: ❤️ Big Thanks to all existing projects