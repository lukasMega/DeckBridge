# Device provenance

Where each `DeviceModel`'s field values came from, and how far they were verified.
Moved out of the source headers so the model files stay readable; this is the
authoritative record — update it when a device is tested on real hardware.

Not published to the docs site. `docs/devices.mdx` and `docs/device-specs.mdx` are
generated from `DEVICE_MODELS` by `mise run devices-generate` and carry the _values_,
not their pedigree.

---

## Elgato Stream Deck MK.2 (`elgato/mk2.ts`)

PID `0x0080` was hardware-tested on macOS on 2026-09-15. The test confirmed
native 72×72 JPEG passthrough with `image.rotate: 0`; DeckBridge also detected
the connected unit as a supported Stream Deck MK.2. PIDs `0x006d` and `0x00a5`
remain source-derived and were not present during this test.

The physical identity path forwards the unit's real serial and firmware to the
Elgato app. Splash images remain separate: their upright sources require the
180° transform already configured in `splash.transformOverride`.

---

## Fifine AmpliGame D6 (`fifine/fifine-d6.ts`)

The Mirabox 293V3 board behind VID `0x3142`.

**Rev. 2 (`0x0060`) is hardware-tested on macOS**: enumeration via the `0xffa0`/1
usage path, all 15 keys rendered, and press+release events mapped correctly
(wire `0x0f` → mk2 14, `0x0b` → mk2 10). **Rev. 1 (`0x0007`) is untested.**

Everything else is copied from `MIRABOX_293_MODEL`, because six independent
implementations describe the D6 as a 293V3 clone: the same CRT command set,
512-byte HID reads, usagePage `0xffa0`/usage 1, 3×5 grid of 15 JPEG keys, no
encoders, and the same button-remap table — companion-surface-mirabox-stream-dock
PR #49; opendeck-ampgd6 `IMAGE_MAP`; FifineOpenSource `IMAGE_MAP`;
jasonkoon/sd-connect `IMAGE_KEY_MAP` (byte-identical to our `coraToWireImage`, and
sd-connect verified it on hardware by painting each key with its own index). The
wire format was audited command-by-command against companion's `streamdock.ts`:
BAT/LIG/CLE/STP/DIS/CONNECT and the input report layout all match
`devices/mirabox/protocol.ts`, so no protocol code changes were needed.

### "Protocol version" is not uniform

Upstream runs the D6 rev. 1 at mirajazz **v1 for writes** (512-byte packets) but
forces the **event reader to v3** (press+release) — see FifineOpenSource's explicit
`PROTOCOL_VERSION = 1` + `READER_PROTOCOL_VERSION = 3`, and opendeck-ampgd6's
`reader_mut.protocol_version = 3`. We express that net behaviour as
`packetSize: 512` + `synthesizeKeyUp: false`. The device is NOT uniformly "v3",
which is also why `mirabox-cora-v1` is the wrong protocol tag for it (that one
implies keydown-only and a shared serial too).

### Two PIDs, two packet sizes

This is two models rather than one model with two PIDs:

- rev. 1 (`0x0007`) — 512-byte CRT packets
- rev. 2 (`0x0060`) — 1024-byte packets

Fifine's own Windows software labels the rev. 2 unit "D6 Pro" (opendeck-ampgd6
PR #4), but PR #5's author reports the box and label just say "D6", and Fifine
separately sells a retail D6PRO SKU — so treat "rev. 2", not "D6 Pro", as this
model's identity.

512-byte writes render **black** on rev. 2. Four independent `0x0060` owners hit it
and all fixed it by moving to 1024 (opendeck-ampgd6 PR #4, #5, #6, #7). PR #7 has the
mechanism: the board reports `MaxOutputReportSize = 1024`, so every 513-byte write —
brightness, clear, image chunks, the STP commit — is discarded by the firmware while
`write()` still returns success. The device enumerates and reports button presses
correctly and the screen simply stays black. That is what `packetSizeCandidates`
probes for. Lyagva's fork PR #1 is a _different_ fix for the same symptom: it keeps
`packetSize: 512`, enlarges the image chunks, serializes the writes and paces them
2 ms apart (see `DeviceWireSpec.chunkDelayMs`). Do not "unify" the two revisions.

### Panel size: 112×112, and it cannot be probed

The least settled value on this device — the reference projects split four ways: 95
(jasonkoon/sd-connect, live-probed on a `0x0060`), 100 (companion PR #49, on a
`0x0007`), 105 (opendeck-ampgd6 main + FifineOpenSource), 112 (opendeck-ampgd6 PR #6
and PR #7, both on `0x0060`).

We take 112: it is the hardware-verified 293V3 size, and the only value two
independent owners derived _from_ the hardware rather than inherited — PR #6 by
tracing Fifine's own Windows software, PR #7 by painting candidate resolutions onto
separate keys ("At 105 the artwork leaves a visible gap and each row smears against
the fixed framebuffer stride"). 112 also holds up on a real rev. 2 unit on macOS:
keys render full-bleed.

Unlike `packetSize`, this CANNOT be probed — the device never reports its panel size
and never complains. A wrong value shows as letterboxing, a gap, or a soft image.
Re-measure on hardware before changing it.

### `maxBytes: 10240` is headroom, not a ceiling

Inherited from the 293V3 and deliberately left alone even though a rev. 2 unit proved
the firmware takes far more: the `mise run d6-capture -- s3` ladder pushed
7.9 / 10.8 / 14.0 / 22.7 / 22.9 KB onto five keys and every one rendered intact (white
frame closed on all four edges, right tally count, even noise fill).

Raising it buys nothing in practice — the desktop's own 112×112 keys arrive through
the sidecar at 1.9–4.8 KB (q 0.9), less than half the cap, so it almost never binds —
while each extra KB is one more 1024-byte HID write per key on the worker thread. Only
revisit if a genuinely detailed key is seen getting quality-crushed by the cap.

### The rev. 2 board's own self-description is checked in

`mise run d6-capture` (`src/dev/d6-capture.ts`) read the HID report descriptor off a
real `0x0060` unit on macOS. The 54 bytes live in
`test/fixtures/fifine-d6-rev2.report-descriptor.json` and are asserted by
`test/hid-report-descriptor.test.ts`: one unnumbered vendor collection (usagePage
`0xffa0`, usage 1), an **Output report of 1024 bytes** and an **Input report of
512 bytes**. So both `wire.packetSize: 1024` and `wire.inSize: 512` are the
device's own numbers, not inherited constants. This is also the fixture the B4′
packet-size probe is regression-tested against, so the synthetic descriptors in
that test file are no longer the only thing keeping it honest.

### `sharedSerial` is deliberately omitted (→ false) for both

Two independent `0x0060` units report per-unit serials that share the `81D0DA78`
prefix and differ in the tail: the companion issue #32 USB dump
(`USB\VID_3142&PID_0060\81D0DA784037`) and the captured unit above. Neither is
mirajazz's shared `355499441494`.

Rev. 1 serial uniqueness remains unverified.
Historical supporting plan is absent here. Mirajazz hardcodes the shared
`355499441494` for v1 devices, and rev. 1 _is_ a v1 board on the write path, but
it masks that serial rather than reading it, so that isn't proof the firmware
reports it. If two rev. 1 units ever collide on one settings key,
`sharedSerial: true` on `FIFINE_D6_MODEL` is the fix (see `deviceKeyFor` in
`device-identity.ts`).

If keys light up in the wrong place on real hardware, `keyMap` (verified on 293V3
and D6 rev. 2 hardware) is the first thing to re-derive.

---

## upHere 293V3 (`uphere/uphere-293v3.ts`)

**Not hardware-tested.** VID/PID `0x1200:0x2012` come from the owner in
[androme13/JIB issue #2](https://github.com/androme13/JIB/issues/2) and from JIB v1.2.0.0's
native catalog (`StreamDockNative.dll`), which lists it as `upHere 293V3` and drives it with
the Mirabox SDK's `StreamDock293V3` class: the same board as `mirabox-293`, 112 px keys.

The owner's swapped top/bottom rows were a bug in JIB's default order for that family, not
a deck quirk: JIB's fix renders the bottom row first, putting the top-left image on wire id
11, exactly like `mirabox-293`'s hardware-verified `[11..15, 6..10, 1..5]`. Image, wire,
keyMap and splash are therefore copied from `MIRABOX_293_MODEL`. The usage page
(`0xffa0`/1) is assumed from the template and unverified.

---

## Mirabox 293, first generation (`mirabox/mirabox-293-gen1.ts`)

**Not hardware-tested.** The original 5×3 Stream Dock 293 is VID `0x5500`, PID `0x1001`
(`StreamDock293` / `StreamDock293V2` in the Mirabox SDK). It was listed here as "v1,
unsupported", but that was a guess: the evidence below says v3-style CRT commands with
press and release events. The issue #292 reporter has not yet confirmed their VID:PID.

Sources, by what each one gave:

- **MiraboxSpace/StreamDock-Device-SDK** (vendor): `ProductIDs.py` has `USB_VID_293 = 0x5500`
  and `USB_PID_STREAMDOCK_293 = 0x1001`; `StreamDock293.py` has 100×100 JPEG keys, 180°
  rotation and the key table; the C++ `StreamDock293V2` calls `setReportSize(513, 513)`
  (report id + 512 bytes). The transport library is closed source.
- **rigor789/mirabox-streamdock-node** (MIT): the only project built for this board. Sends
  `STP` after every image; init is the firmware GET_REPORT, `DIS`, `CLE 0xFF`, `LIG`, with
  no heartbeat. Its example restores the key icon on state `0`, so key release is reported.
- **applearon/libtransport-decomp**: reimplements the closed transport and was tested on a
  real `5500:1001`. Its `LIG`/`BAT`/`CLE`/`STP` layouts equal `buildLig`/`buildBat`/
  `buildCle`; the input key is at byte 9 and the state at byte 10. Licence not checked.
- **kebot/mirabox-ts** (no licence stated): TypeScript port of the SDK; same IDs and the
  same key table as rigor789.
- **fstechlabs/taurilanzi** (AGPL-3.0, facts only): "293 `5500:1001`, 15 keys, 100×100,
  180°, 512"; never send `LOG` (boot image, writes ROM). DeckBridge never does.
- **4ndv/opendeck-akp153** (GPL-3.0, facts only): its gen1 requests (#34, #26) were closed
  unimplemented. The #34 `lsusb` shows `iSerial 0` and bcdDevice 3.00, so the deck has no
  USB serial.

Field basis:

- **`protocol: 'mirabox-cora'`**, not `mirabox-cora-v1`: press and release are reported, an
  `STP` follows each image and there is no sixth column, so the v1 (293S board) description
  would be wrong. Precedent is `FIFINE_D6_MODEL`.
- **`wire.packetSize` 512**, with `packetSizeCandidates: [512, 1024]` so the report
  descriptor arbitrates at open (as on the D6). 512 comes from the SDK's report size and
  kebot; rigor789's 5 + 512 framing is its own libusb quirk. `inSize` 512 is from the SDK.
- **Geometry and `image`**: 15 keys, 5×3, 100×100 JPEG (SDK, rigor789, taurilanzi). The
  rotation stays V3's `rotate: 0`: the SDK says 180° for gen1 and V3 alike, and the
  hardware-verified V3 model uses `0` with that same convention.
- **`keyMap`** is V3's (`coraToWireImage [11..15, 6..10, 1..5]`, `inputOffset: 1`):
  identical tables in the SDK for `StreamDock293` and `StreamDock293V3`, rigor789 and kebot.
  `cora` and `splash` are also V3's.
- **`sendStpAfterImage` true** (rigor789), **`synthesizeKeyUp` false** (SDK dispatch and
  rigor789 state `0x00` = release), **`sharedSerial` true** (no USB serial; without it two
  decks would share one device key).

Unverified, and tunable in Device tuning: `image.maxBytes` 10240, `wire.heartbeatMs` 8000
(family default; a gen1 board may not expect the keepalive), usage page `0xffa0`/usage 1
(inherited from V3), and `synthesizeKeyUp` on real hardware. Do not merge with
`0x6602:0x1001` (N4) or `0x0b00:0x1001` (MSD-TWO): same PID, other VIDs and protocols.

---

## Ajazz AKP153E / AKP153R rev. 2 (`ajazz/akp153-rev2.ts`)

The same board as the Mirabox 293V3 behind a different VID/PID
(`0x0300:0x3010` / `0x3011` instead of `0x6603:0x1005…`).

Shared protocol fields come from `MIRABOX_293_MODEL`: protocol v3 (1024-byte CRT
packets, press+release), 512-byte HID reads, usagePage `0xffa0`/usage 1, 3×6
physical grid, and JPEG keys. AKP153R remains untested and keeps those defaults.

AKP153E was hardware-tested on Windows in issue #67. Its input/image mapping, 90°
rotation, and 95×95 image size are now device-specific. The reporter found inherited
112×112 images clipped; 95×95 rendered complete and centered. That result agrees with
both opendeck-akp153 `src/mappings.rs` and keydeck
`driver/devices/Ajazz-AKP153E-0x3010.json`, which independently specify 95×95.

Rev. 1 (`0x0300:0x1010` / `0x1020`) is a v1/512-byte device and is deliberately NOT
covered here; it needs the 293S-style model instead (see below).

---

## The 7 v1 rebadges of the 293S board (`rebadge/akp153-v1-clones.ts`)

`protocol_version 1`, 512-byte packets, 3×6 physical grid (15 keys + a 3-key right
column), JPEG 85×85, and keydown-only input.
Current model rotates 90 degrees.
Both flip flags are false.
Padding uses edge-clamped 85×85 output.

Confirmed by **both** keydeck (device JSON byte-identical to `Mirabox-HSV293S.json`
apart from VID/PID and name) and opendeck-akp153 (`Kind::protocol_version()` → 1,
and `get_image_format_for_key()` derives the image spec from `protocol_version`
alone — "same version" really is "same params").

**Hardware remains untested.**
Image and mapping defaults inherit `MIRABOX_293S_MODEL`.
Identity fields vary per rebadge.
`batchImageTransfers` explicitly defaults to false.
293S itself defaults batching to true.
Inherited values do not establish hardware equivalence.

### Adjacent PIDs, different protocols — do not merge

| PID             | Revision       | Protocol | Model file                    |
| --------------- | -------------- | -------- | ----------------------------- |
| `0x0300:0x1010` | AKP153E rev. 1 | v1       | `rebadge/akp153-v1-clones.ts` |
| `0x0300:0x3010` | AKP153E rev. 2 | v3       | `ajazz/akp153-rev2.ts`        |
| `0x0300:0x1020` | rev. 1         | v1       | `rebadge/akp153-v1-clones.ts` |
| `0x0300:0x3011` | rev. 2         | v3       | `ajazz/akp153-rev2.ts`        |

Same VID, adjacent PIDs, completely different protocol.

---

## AKP05 family (`ajazz/akp05e.ts`, `ajazz/akp05.ts`, `rebadge/akp05-clones.ts`)

`ajazz-akp05e` (PID `0x3004`) was hardware-tested on macOS on 2026-09-21; the retail
AKP05 (`0x3006`) is a plain spread of it. `rebadge/akp05-clones.ts` adds 12 more
spreads that change only id, name, vendor and VID/PID. **None is hardware-tested.**

All IDs come from `ambiso/opendeck-akp05` `src/mappings.rs`. The N4/N4E ids are also in
keydeck and in Mirabox's own `StreamDock-Device-SDK` (one `StreamDockN4` class: 112×112
keys rotated 180°, 176×112 second screen at image ids 1-4). Input codes agree across
opendeck-akp05, the Mirabox SDK and VT-Ragnaros. opendeck-akp05 queries usage page
`0xffa0` / usage 1 for every row without verifying it per model.

| Model id            | VID:PID         | Notes                                                         |
| ------------------- | --------------- | ------------------------------------------------------------- |
| `redragon-ss552`    | `0x0200:0x3001` | Strip geometry disputed (below); Linux needs hidraw, unproven |
| `mirabox-n4`        | `0x6602:0x1001` | The N3 is `0x6602:0x1002`, a different board                  |
| `mirabox-n4e`       | `0x6603:0x1007` |                                                               |
| `mirabox-n4-pro`    | `0x5548:0x1008` | Pro SDK class: PNG keys, RGB LEDs, vibration (`QUCMD`)        |
| `mirabox-n4-pro-e`  | `0x5548:0x1021` | Vibration confirmed by capture in opendeck-akp05              |
| `vsdinside-n4`      | `0x5548:0x1004` | Not a Pro in opendeck-akp05 (no vibration)                    |
| `vsdinside-n4-pro`  | `0x5548:0x1023` |                                                               |
| `mars-msd-pro`      | `0x0b00:0x1003` | Windows-only report; white MSDPROW PID unknown                |
| `soomfon-cn003`     | `0x1500:0x3002` |                                                               |
| `streonor-s10-pro`  | `0x1500:0x3007` | Filed under the Soomfon VID in opendeck-akp05                 |
| `ajazz-akp05e-pro`  | `0x0300:0x3013` |                                                               |
| `ajazz-akp05cn-pro` | `0x0300:0x3014` |                                                               |

### Open items, nothing measured

- **SS552 strip.** VT-Ragnaros paints four contiguous 176×124 panels (each flushed with
  STP); opendeck-akp05 and the N4 SDK use 176×112; DeckBridge inherits the AKP05E
  800×112 single surface with slot windows at x = 0 / 204 / 406 / 610. Only hardware
  settles it, and `widgetDisplays` / `touchStripDisplay` are not user-tunable.
- **Uploads.** DeckBridge commits with ULEND; VT-Ragnaros sends STP and says strips only
  show after it. If a deck needs STP, `Akp05Driver` must honour `wire.sendStpAfterImage`.
- **N4 Pro family.** Inherits the AKP05E JPEG path as opendeck-akp05 does. Mirabox's SDK
  lists a separate class with PNG keys; keys rendering wrong is the first suspect.
- **Not implemented:** LED strip commands (`LBLIG`, `SETLB`), vibration (`QUCMD`) and the
  `HAN` sleep command. DeckBridge has no CORA concept for them.

### Adjacent PIDs, different protocols — do not merge

| PID             | Device                   | Protocol      | Model file                    |
| --------------- | ------------------------ | ------------- | ----------------------------- |
| `0x0b00:0x1000` | Mars MSD-ONE             | v1            | `rebadge/akp153-v1-clones.ts` |
| `0x0b00:0x1001` | Mars MSD-TWO (keydeck)   | v2            | unsupported                   |
| `0x0b00:0x1003` | Mars MSD-PRO             | AKP05         | `rebadge/akp05-clones.ts`     |
| `0x5500:0x1001` | Mirabox 293 (original)   | v3 CRT, 512 B | `mirabox/mirabox-293-gen1.ts` |
| `0x6602:0x1001` | Mirabox N4 (not the 293) | AKP05         | `rebadge/akp05-clones.ts`     |
