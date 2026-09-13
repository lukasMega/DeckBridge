# Device provenance

Where each `DeviceModel`'s field values came from, and how far they were verified.
Moved out of the source headers so the model files stay readable; this is the
authoritative record — update it when a device is tested on real hardware.

Not published to the docs site. `docs/devices.mdx` and `docs/device-specs.mdx` are
generated from `DEVICE_MODELS` by `mise run docs-devices` and carry the _values_,
not their pedigree.

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
`mirabox-protocol.ts`, so no protocol code changes were needed.

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

`mise run d6-capture` (`src/d6-capture.ts`) read the HID report descriptor off a
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

For rev. 1 this is an assumption, not a finding — see open question O3 in
`.claude/plans/2026-09-10_fifine-d6-support.md`. Mirajazz hardcodes the shared
`355499441494` for v1 devices, and rev. 1 _is_ a v1 board on the write path, but
it masks that serial rather than reading it, so that isn't proof the firmware
reports it. If two rev. 1 units ever collide on one settings key,
`sharedSerial: true` on `FIFINE_D6_MODEL` is the fix (see `deviceKeyFor` in
`device-identity.ts`).

If keys light up in the wrong place on real hardware, `keyMap` (verified on 293V3
and D6 rev. 2 hardware) is the first thing to re-derive.

---

## Ajazz AKP153E / AKP153R rev. 2 (`ajazz/akp153-rev2.ts`)

The same board as the Mirabox 293V3 behind a different VID/PID
(`0x0300:0x3010` / `0x3011` instead of `0x6603:0x1005…`).

**NOT hardware-tested.** Everything is copied from `MIRABOX_293_MODEL` because the
reference implementations describe the two as identical: protocol v3 (1024-byte CRT
packets, press+release), 512-byte HID reads, usagePage `0xffa0`/usage 1, 3×6
physical grid, JPEG keys, and the same button-remap table — opendeck-akp153
`src/mappings.rs` `protocol_version()`; keydeck
`driver/devices/Ajazz-AKP153E-0x3010.json` is byte-identical to
`Mirabox-HSV293SV3-0x1005.json` apart from VID/PID and human name.

`keyMap` in particular was verified on 293V3 hardware only — if keys light up in the
wrong place on a real AKP153 rev. 2, that table is the first thing to re-derive.

Rev. 1 (`0x0300:0x1010` / `0x1020`) is a v1/512-byte device and is deliberately NOT
covered here; it needs the 293S-style model instead (see below).

---

## The 7 v1 rebadges of the 293S board (`rebadge/akp153-v1-clones.ts`)

`protocol_version 1`, 512-byte packets, 3×6 physical grid (15 keys + a 3-key right
column), JPEG 85×85, rotate90 + pad-to-85 edge-clamp, mirror Both, keydown-only
(no release event), identical 18-entry button remap.

Confirmed by **both** keydeck (device JSON byte-identical to `Mirabox-HSV293S.json`
apart from VID/PID and name) and opendeck-akp153 (`Kind::protocol_version()` → 1,
and `get_image_format_for_key()` derives the image spec from `protocol_version`
alone — "same version" really is "same params").

**NOT hardware-tested.** Every field (including the derived `extraKeys` guess and
the hardware-verified `keyMap`/`image` tuning) is inherited verbatim from
`MIRABOX_293S_MODEL` by construction, so it cannot drift out of sync — see
`mirabox-293s.ts` for the tuning rationale and its own hardware caveats.

### Adjacent PIDs, different protocols — do not merge

| PID             | Revision       | Protocol | Model file                    |
| --------------- | -------------- | -------- | ----------------------------- |
| `0x0300:0x1010` | AKP153E rev. 1 | v1       | `rebadge/akp153-v1-clones.ts` |
| `0x0300:0x3010` | AKP153E rev. 2 | v3       | `ajazz/akp153-rev2.ts`        |
| `0x0300:0x1020` | rev. 1         | v1       | `rebadge/akp153-v1-clones.ts` |
| `0x0300:0x3011` | rev. 2         | v3       | `ajazz/akp153-rev2.ts`        |

Same VID, adjacent PIDs, completely different protocol.
