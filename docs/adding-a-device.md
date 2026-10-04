# Adding a New Device

Adding support for a new USB stream-deck-style device — from a known brand on an existing
wire protocol to one whose protocol you must reverse-engineer.

**Known protocols usually need configuration changes.**
`DeviceModel` owns runtime device facts.
Registration, evidence, packaging, and tests remain separate.
Complete every applicable checklist entry below.

Validated against source: 2026-10-03.

---

## Architecture overview

```
USB device
  └─ libhidapi (via FFI, worker thread)
       └─ Driver class  ←  implements DeviceDriver (EventEmitter)
            ├─ emits 'key' (worker) → postMessage → WorkerHidDriver (main thread)
            │    → driver-manager → CORA child server → Elgato software
            ├─ receives sendImage(deviceKeyIndex, nativeBytes) → hid_write
            └─ receives setBrightness / clearKey

dock-frames.ts (main thread) — on each CORA image:
  ├─ WorkerHidDriver.renderCoraImage(keyIndex, data, format) → postMessage → worker
  └─ pushes the CORA bytes to the WebUI (base64 over WebSocket)

image-render.ts (worker thread) — on each forwarded image:
  ├─ transforms via deckbridge-native cdylib (FFI: resize/rotate/flip) + LRU cache
  ├─ remaps CORA key index → device wire key index
  └─ driver.sendImage(deviceKeyIndex, nativeBytes)
```

Full pipeline diagram (threads, cache, transform): [Image Flow](./image-flow.md).

Compare selected fields across registered models:
[Device specs](./device-specs.mdx).

**What you'll touch for any new device:**

| Layer | File(s) | What it does |
|---|---|---|
| Device model | `devices/<brand>/<model>.ts` + `devices/registry.ts` | **The single source of truth** — geometry, VID/PID, image spec, wire framing, key map, CORA identity, splash overrides |
| Elgato-compatible strategy | `devices/protocol/<proto>.ts` + `PROTOCOL_STRATEGY` | Framing, parsing, blank images, feature reports |
| Driver class (only if new pattern) | `devices/elgato/driver.ts` or new file + `USB_DRIVERS` entry | HID open/read/write loop |
| Evidence | `devices/device-notes.json` + `devices/PROVENANCE.md` | Tested variants and remaining unknowns |
| Linux permissions | `scripts/packaging/linux/99-deckbridge.rules` | Manually maintained VID/PID allowlist |
| Published device data | `ts/scripts/gen-device-docs.mjs` | Generated pages and homepage JSON |
| Artwork | `ts/scripts/gen-device-svgs.mjs` + static SVGs | Separate illustration inventory |
| Regressions | `ts/test/` + `e2e/helpers/devices.ts` | Protocol evidence and browser expectations |

Everything else (`translator.ts`, `dock-frames.ts`, `splash-sender.ts`,
`driver-manager.ts`) reads `model.keyMap` / `image` / `cora` / `splash` / `protocol`
generically — not edited for a config-only device.

---

## Phase 0 — gather device info before writing any code

Gather all of this before touching TypeScript.

### USB identifiers

```bash
system_profiler SPUSBDataType | grep -A5 "Stream Deck\|Mirabox\|Your Brand"  # macOS
lsusb  # Linux
```

Note the **VID** (Vendor ID) and **PID** (Product ID), both hex.

### HID usage page / usage

Devices with multiple HID interfaces need `usagePage` + `usage` to select the right one
(on macOS `hidapi` defaults to the first interface, often system-claimed).

```bash
# macOS — show all HID devices with usage info
python3 - <<'EOF'
import hid
for d in hid.enumerate():
    print(f"VID={d['vendor_id']:#06x} PID={d['product_id']:#06x} "
          f"UP={d['usage_page']:#06x} U={d['usage']:#06x} path={d['path']}")
EOF
```
(Single-HID-interface devices can omit `usagePage` / `usage`.)

### Packet format

Capture traffic using platform-supported USB tools.
Separate passive captures from active probes.
Existing probes can initialize hardware.
Record exact tool and operating system.

Capture open → send image → press key → set brightness → close, and record: input report
layout (bytes, 0/1-based key index), image packet format (header, payload size, chunking),
brightness command, and any required handshake/heartbeat.

---

## Step 1 — write the `DeviceModel`

Create `ts/src/devices/<brand>/<model>.ts` — the single source of truth:

```typescript
// ts/src/devices/acme/acme-x5.ts
import type { DeviceModel } from '../driver.js';
import { IMAGE_JPEG_QUALITY, ELGATO_MK2_PID } from '../../shared/types.js';

const ACME_VID = 0xabcd;
const ACME_PIDS = [0x0001, 0x0002] as const;
const ACME_KEY_SIZE = 96;

export const ACME_X5_MODEL: DeviceModel = {
  id: 'acme-x5',              // stable kebab slug — used in logs, cache, web UI
  vendor: 'acme',             // see Step 2a if adding a new vendor
  protocol: 'acme-v1',        // see Step 2b if adding a new wire protocol
  name: 'Acme Stream X5',
  usbVendorId: ACME_VID,
  usbProductIds: ACME_PIDS,
  usagePage: 0xff60,          // omit if single HID interface
  usage: 0x61,                // omit if single HID interface
  keyCount: 15,
  columns: 5,
  rows: 3,
  keyWidth: ACME_KEY_SIZE,
  keyHeight: ACME_KEY_SIZE,

  image: {
    format: 'jpeg',           // 'jpeg' or 'bmp'
    width: ACME_KEY_SIZE,
    height: ACME_KEY_SIZE,
    rotate: 0,                // start at 0; measure on hardware (see Phase 4)
    flipH: false,
    flipV: false,
    colorMode: 'rgb',         // ⚠️ not wired for JPEG today — see "Color order" note below
    maxBytes: 0,              // 0 = no cap (JPEG, firmware scales); cap if device needs it
    quality: IMAGE_JPEG_QUALITY,
    transform: 'sidecar',     // 'passthrough' only valid for rotate:0/no-flip/no-cap gen2-style devices
  },

  // Required HID sizes plus protocol-specific behavior (see Step 3).
  wire: { packetSize: 1024, inSize: 512 },

  // CORA (MK.2, 0-based row-major) ↔ device wire ids; empty = identity. See Step 4.
  // keyMap: { coraToWireImage: [...], wireInputToCora: [...], imageOffset, inputOffset }
  keyMap: {},

  // What this device advertises to the Elgato desktop over CORA.
  cora: {
    productId: ELGATO_MK2_PID,        // PID the desktop sees; non-Elgato spoof MK.2
    advertiseAs: 'mk2',                   // omit to use this model's geometry
    usePhysicalIdentity: false,       // true = forward real serial/firmware (Elgato only)
  },

  // splash: { transformOverride: { rotate: 180 } },  // when splash orientation differs from live
};
```

### `image` field reference

| Field | Meaning | How to determine |
|---|---|---|
| `format` | Image format the hardware expects | Capture what the official software sends |
| `width`/`height` | Key image resolution | From official software or protocol docs |
| `rotate` | Extra CW rotation on incoming CORA JPEG | Start at 0; rotate 90 until images appear upright |
| `flipH`/`flipV` | Mirror after rotation | Start false; toggle if image is mirrored |
| `colorMode` | RGB vs BGR byte order | ⚠️ **Not implemented for JPEG** (see "Color order" below). For `bmp` the byte order is implied by the format, not this field. |
| `maxBytes` | JPEG size cap (0 = none) | Match what the official client sends, or 0 for uncapped |
| `quality` | JPEG quality 0–1 | Start at 0.95; reduce if bandwidth is tight |
| `crop` | Optional. Pixels trimmed from every side of the source image before rotate/flip/resize (or pad) — `0`/undefined = none. Ignored when it would leave a non-positive dimension. | Needed if the source has a dead border — e.g. the K1 Pro is fed an 80×80 Mini BMP and uses `crop: 6` to cut the outer edge before its 64×64 resize |
| `cropRect` | Optional. `{ x, y, width, height }` in source pixels, cut out before rotate/flip and the fit — the fit then sees only this region. Clamped to the source; width/height ≥ 8. Cannot be combined with `crop` > 0, and needs `transform: 'sidecar'` (passthrough sends the image unchanged). | Normally set from **Device tuning → Crop…**, not in a registry model — e.g. off-centre art, or a dead border on one side only |
| `resizeFilter` | `'triangle'` (default) \| `'nearest'` \| `'lanczos3'` — the resize filter used for `resizeMode: 'resize'` | `'lanczos3'` for quality up/downscales (Mirabox 293: 72→112 upscale; K1 Pro: 68→64) |
| `resizeMode` | `'resize'` (default — interpolate to `width`×`height`) or `'pad'` (keep source pixels 1:1, centre them top-left-biased in the canvas, fill the border per `padFill`; falls back to `'resize'` if the source is larger than the canvas), or `'crop'` (as `'pad'`, but centre-crops axes where the source is larger instead of resizing — 1:1, no resampling) | Use `'pad'` when the device's native key size is larger than the CORA source and you don't want upscale blur — e.g. the 293S pads 72→85. Use `'crop'` for a slightly smaller key — e.g. Stream Deck + 120×120 art on the AKP05E's 112×112 keys trims 4 px per side |
| `padFill` | Border fill for `resizeMode: 'pad'`/`'crop'`: `'black'` \| `'average'` (mean source colour) \| `'edge'` (default — clamp/replicate the nearest source pixel) | Ignored for `resizeMode: 'resize'` |
| `blur` | Optional. Gaussian blur sigma applied before JPEG/BMP encode (undefined/`0` = none) | Rarely needed; leave unset unless the source needs softening |
| `sharpen` | Optional. Unsharp-mask sigma applied after resize (undefined/`0` = none); recovers crispness lost to upscaling | Keep modest (~0.4–0.8) — higher values add high-frequency detail and grow the JPEG. The 293S leaves this at `0` (no upscale, so moot) |
| `bmpPpm` | BMP output only. Pixels-per-meter written into the BMP header — cosmetic metadata, does not affect pixel data | `2835` for the Mini; irrelevant unless `format: 'bmp'` |
| `transform` | `'passthrough'` (forward CORA JPEG unchanged) or `'sidecar'` (resize/rotate/flip via Rust) | `'passthrough'` only valid when `rotate: 0`, no flips, no `maxBytes` cap, and the device consumes CORA-native resolution (gen2-style). Everything else needs `'sidecar'`. |

### Color order is not implemented (known limitation)

> ⚠️ **`colorMode` is a no-op for JPEG devices.** Nothing reads it —
> `translator.ts:transformImageForDevice` doesn't forward a `color_mode` field, and
> `image_proc_transform` (`rust/deckbridge-native/src/lib.rs`) has no such parameter. For
> `format: 'bmp'` (gen1/Mini) the output is BGR only because `encode_bmp` writes BGR
> unconditionally. **So `colorMode: 'bgr'` will not fix swapped red/blue on a JPEG device.**
>
> **To add a channel swap, build it first:** add a `color_mode`/`swap_rb` param to
> `image_proc_transform` (swap R/B before encode) and forward `spec.colorMode` from
> `transformImageForDevice`. Until then, leave `colorMode: 'rgb'` (descriptive only).

### `cora` field reference — what CORA advertises to the Elgato desktop

| Field | Meaning |
|---|---|
| `productId` | The PID the Elgato desktop sees in CORA capabilities. Elgato devices typically advertise their real PID (`usbProductIds[0]`); non-Elgato devices spoof `ELGATO_MK2_PID` so the desktop recognizes a known model. |
| `advertiseAs` | Registry model id whose geometry is sent in CORA capabilities. Omit to derive geometry from this model. Non-Elgato devices typically use `'mk2'`; Mini-like devices use `'mini'`. Dimensions are never copied. |
| `emulations` | Optional. CORA profiles (`CORA_PROFILES` ids, e.g. `'stream-deck-plus'`) this device can re-pair as from Device tuning, each with the `image` + `keyMap` it needs to paint that grid on its own panel. A user override may only select a profile listed here. |
| `usePhysicalIdentity` | `true` forwards the device's real serial number / firmware version (Elgato devices only — the desktop expects them to match). `false` (Mirabox/third-party) keeps the configured mock identity. |

### `keyMap` field reference — translating between CORA and device key indices

CORA uses zero-based advertised-grid indices.
Grid dimensions follow `advertisedGeometry(model)`.
Examples include Mini, MK.2, and Plus.
Legacy helper names still mention MK.2.
Image addresses and input codes differ.
Measure each direction independently.

- **Image** (`sendImage`): CORA key index → device wire image id — `coraToWireImage`
  (explicit array) or `imageOffset` (constant), else identity.
- **Input** (`parseInput`): device wire key code → CORA (MK.2) index — `wireInputToCora`
  (explicit array, `-1` = unused) or `inputOffset` (constant), else identity.

Precedence is **explicit array > offset > identity**, resolved independently per direction
(e.g. `mirabox-293` uses an explicit `coraToWireImage` array but a simple `inputOffset`).
Start with everything unset (identity) if you don't know the layout — Phase 5 measures it
from hardware.

---

## Step 2a — register the vendor (if new)

`DeviceVendor` in `devices/driver.ts` is a union type:

```typescript
// ts/src/devices/driver.ts
export type DeviceVendor = 'mirabox' | 'elgato' | 'acme';  // add your brand
```

`vendor` is diagnostic only — behavior that once switched on it (CORA product ID,
geometry, identity forwarding) now lives in `model.cora`. No other changes needed.

---

## Step 2b — register the protocol (if new)

`DeviceProtocol` in `devices/driver.ts` is a closed union:

```typescript
// ts/src/devices/driver.ts
export type DeviceProtocol =
  | 'mirabox-cora'
  | 'mirabox-cora-v1'
  | 'ajazz-akp05'
  | 'elgato-gen1'
  | 'elgato-gen2'
  | 'acme-v1';       // add your protocol
```

**Skip if your device reuses an existing protocol** (e.g. same packet format as gen2 with
a different VID/PID — just set `protocol: 'elgato-gen2'`).

---

## Step 3 — implement the driver

Choose one of three paths. The model's `protocol` selects the driver (`USB_DRIVERS` in
`devices/usb-drivers.ts`) and the wire keys users may tune (`TUNABLE_WIRE_KEYS` in
`devices/driver.ts`).

### Path A — reuse `ElgatoHidDriver` (gen1 / gen2 compatible)

Set `protocol: 'elgato-gen1'`/`'elgato-gen2'`.
`ElgatoHidDriver` looks up byte-framing from `PROTOCOL_STRATEGY` by `model.protocol` — no
new driver code. Packet and input report sizes still come from `model.wire`.

### Path B — new HID packet format, same open/read/write pattern

Add a new `protocol` (mapped to `ElgatoHidDriver` in `USB_DRIVERS`, `[]` in
`TUNABLE_WIRE_KEYS`), write the framing functions, and
**add one `PROTOCOL_STRATEGY` entry** in `devices/protocol/index.ts`:

Every strategy implements six required members:

| Member | Required behavior |
|---|---|
| `writeImage` | Frame chunks into caller-owned scratch |
| `parseInput` | Validate length, then decode states |
| `brightnessReport` | Return complete feature-report bytes |
| `resetReport` | Return complete reset-report bytes |
| `blankImage` | Produce valid native black image |
| `infoReports` | Describe serial and firmware reports |

Reference: `devices/protocol/index.ts` defines `ProtocolStrategy`.
Use `elgato-gen1.ts` or `elgato-gen2.ts` examples.
Framing helpers live in `protocol/framing.ts`.
Unsupported identity reads require driver changes.
Never invent report addresses for compatibility.

`ElgatoHidDriver` assumes feature-report brightness/reset support.
It also assumes snapshot-style key states.
Reuse requires matching those assumptions.
Otherwise choose Path C below.

### Path C — completely different driver (new protocol class)

If the device has a fundamentally different communication pattern (different handshake,
heartbeat, multi-step init, bulk transfer instead of interrupt, etc.) write a standalone
driver class, add a `protocol` for it, and register it in `USB_DRIVERS` (Step 5). Reference: `MiraboxDriver` (`ts/src/devices/mirabox/driver.ts`), the most feature-complete
custom driver — it reads wire framing from `model.wire` instead of hardcoding it. Extend
`HidDeviceBase` (`ts/src/devices/hid-device-base.ts`), the shared base every real driver
extends: it owns the per-worker lib singleton, the path-only open, the device handle, the
polling read loop, and the SIGBUS-safe teardown described in the rules below.

Implement worker-side `UsbDriver`, defined in `usb-drivers.ts`.
It extends `DeviceDriver` with `sendImage`.
Main-thread `DockDriver` has different responsibilities.
Use existing complete drivers as references.

| Reference | Reusable pattern |
|---|---|
| `devices/elgato/driver.ts` | Feature reports and state snapshots |
| `devices/mirabox/driver.ts` | CRT framing and conditional batching |
| `devices/ajazz/akp05-driver.ts` | Initialization, keepalive, dials, touch |

New bulk transports need separate architecture work.
`HidDeviceBase` only provides HID transport.

**Key design rules for any driver:**
- Include exactly one report-ID byte.
  Follow existing family framing conventions.
- `hid_read_timeout` with ≤5ms is safe on the single-threaded worker event loop.
- Always emit `'error'` then `'disconnect'` on read failure so `driver-manager` can reconnect.
- After a failed open, call `hid_exit()` but never `dlclose()` (macOS IOKit bug — see
  `_releaseLibAfterFailedOpen` in `devices/hid-device-base.ts`).
- Acquire libraries through `HidDeviceBase._openPath()`.
  Preserve its existing failure-cleanup behavior.
  Normal cleanup closes devices before unloading.
- Open by path only. Never call `hid_open(VID, PID)`: on macOS it opens the first IOKit interface and a denied open SIGBUSes.
- If the device needs a heartbeat, use `setInterval` and cancel it in `_cleanup`.
- Expose only genuinely supported wire settings.
  AKP05 framing fixes its output size.
  Its runtime tuning exposes only `inSize`.

---

## Step 4 — register in `devices/registry.ts`

```typescript
// ts/src/devices/registry.ts
import { ACME_X5_MODEL } from './acme/acme-x5.js';

export const DEVICE_MODELS: DeviceModel[] = [
  MK2_MODEL,
  MINI_MODEL,
  MIRABOX_293_MODEL,
  MIRABOX_293S_MODEL,
  MIRABOX_K1PRO_MODEL,
  ACME_X5_MODEL,   // ← add here
];
```

**Order determines primary-device priority.**
Opening always uses `hid_open_path`.
Discovery filters VID/PID and optional usage.
Avoid overlapping discovery predicates.
`findModel(vid, pid)` cannot distinguish usages.
`DEFAULT_MODEL` remains `MK2_MODEL`.

---

## Step 4b — document it

The two device pages are generated from `DEVICE_MODELS`, so a new model needs one
hand-written companion entry and one command:

1. Add an entry keyed by your model id to `ts/src/devices/device-notes.json` — test
   status, a one-line summary, quirks worth warning about, and the reference projects the
   values came from. Nothing mechanical: IDs, geometry, image/wire spec and key maps all
   come out of the registry.
2. Run `mise run docs-devices`, and commit the regenerated
   [Supported devices](./devices.mdx), [Device specs](./device-specs.mdx) and
   `docs-site/src/data/devices.generated.json`.
3. Record detailed evidence in `devices/PROVENANCE.md`.
4. Add Linux VID/PID permission rules.
5. Check homepage artwork coverage separately.
6. Extend relevant independent regression expectations.

New protocols also need documentation-family registration.
Update `FAMILY_OF_PROTOCOL` and `FAMILIES`.
Both live inside `gen-device-docs.mjs`.

Skipping this fails `ci-checks` on the stale-docs gate — and the generator refuses to run
at all until the notes entry exists, which is what keeps a new device from landing
undocumented.

---

## Step 5 — register in `USB_DRIVERS`

`USB_DRIVERS` (`devices/usb-drivers.ts`) maps each `DeviceProtocol` to a driver factory;
the type makes a missing entry a compile error. Every new protocol needs registration.
Path B maps to `ElgatoHidDriver`.
Path C maps to its custom driver.

```typescript
// ts/src/devices/usb-drivers.ts
import { AcmeDriver } from './acme/acme-driver.js';

export const USB_DRIVERS: Record<DeviceProtocol, (model: DeviceModel) => UsbDriver> = {
  // …
  'acme-v1': (model) => new AcmeDriver(model),
};
```

Also list the `wire` fields your driver reads in `TUNABLE_WIRE_KEYS`
(`devices/driver.ts`); the rest are rejected as overrides and left out of the
Device tuning form.

---

## Phase 4 — measure image orientation on hardware

Run a regular build with a real device connected. Push a known asymmetric image
(e.g. a right-pointing arrow) to key 0 from the web UI or Elgato software, then adjust
`image.rotate` / `image.flipH` / `image.flipV` until it appears upright and un-mirrored:

| What you see | Fix |
|---|---|
| Image upside-down | `rotate: 180` |
| Image rotated 90° CW | `rotate: 270` |
| Image rotated 90° CCW | `rotate: 90` |
| Image mirrored left-right | `flipH: true` |
| Image mirrored top-bottom | `flipV: true` |
| Colors swapped (red/blue) | ⚠️ not auto-handled — see "Color order is not implemented" |

Rotations apply CW before flips. If splash images need a different orientation than live
frames (some hardware does), set `splash.transformOverride` rather than changing `image`.

:::tip[Calibrate on hardware, then upstream]

You do **not** need a rebuild per guess, and neither does a reporter who owns hardware
you don't. Image-only changes repaint immediately.
Key-map, wire, and splash changes reconnect.
CORA profile changes also require re-pairing.

When the values are right, hit **Copy overrides as JSON** and paste them into the
model's `DeviceModel` here — the registry is the ground truth, and runtime tuning is
scaffolding on the way to it. See
[Device tuning](./troubleshooting.md#device-tuning).

Only the `wire` fields a protocol's driver reads are tunable (`TUNABLE_WIRE_KEYS` in
`devices/driver.ts`); an override naming any other is rejected with `wire.<key>: not
tunable on <name> — fixed by the <protocol> protocol`. Elgato gen1/gen2 tune none:
a wrong `packetSize` makes the driver chunk short, which the firmware discards
**silently** — a black panel with no error. AKP05 tunes only `inSize`. Mirabox-family
boards tune all of them (`inSize` capped at 4096; `batchImageTransfers` on
`mirabox-cora-v1` only). Setting them in the `DeviceModel` literal below is still
correct and required; the lock applies to runtime *overrides* only.

:::

---

## Phase 5 — measure key index mappings on hardware

If you started with an empty `keyMap` (identity), verify it now:

1. Label every advertised key using Elgato.
2. Press corresponding physical keys individually.
3. Compare observed inputs with image positions.
4. Fill in `keyMap.coraToWireImage` / `wireInputToCora` (or `imageOffset` / `inputOffset`
   for a constant shift) from your observations.

Map keys within advertised geometry bounds.
Use `-1` for excluded input codes.
Display-only slots need no input events.

:::tip[Let learn mode derive it]

Reading indices out of the comm panel by hand is slow and easy to get wrong — and a
wrong map is precisely what makes a device *feel* broken (images on one key, presses
from another). **Settings → Device tuning → Key-map learn mode** walks the grid position
by position, records the raw wire code each physical key reports, and derives
`wireInputToCora` from that. Its **Copy for a registry PR** button emits exactly the
array to paste into the `DeviceModel` above.

Note the two directions are independent: an image map (`coraToWireImage`) and an input
map (`wireInputToCora`/`inputOffset`) that disagree is a real and easy-to-miss bug —
images land on one key while presses come from another. If you set one explicitly,
check the other matches.

:::

---

## Checklist

```
[ ] VID, PID(s), usage page, usage gathered
[ ] DeviceModel file created (devices/<brand>/<model>.ts) — geometry, image, keyMap, cora, splash
[ ] DeviceVendor updated if new brand
[ ] DeviceProtocol updated if new wire format
[ ] Driver implemented (Path A / B / C); PROTOCOL_STRATEGY entry added (Path B)
[ ] Model registered in DEVICE_MODELS (registry.ts)
[ ] device-notes.json entry added + mise run docs-devices re-run (generated device docs)
[ ] PROVENANCE.md records exact tested PID, firmware, platform, and observations
[ ] Linux udev rules include every new VID/PID
[ ] Homepage SVG exists; illustration inventory reviewed
[ ] Relevant model/protocol tests and browser matrix updated
[ ] USB_DRIVERS + TUNABLE_WIRE_KEYS entries added (new protocol)
[ ] Documentation-family mapping added (new protocol)
[ ] mise run beforeCommit passes (format + lint + types + test + compile)
[ ] Image orientation verified on hardware (image.rotate/flipH/flipV, splash.transformOverride)
[ ] Key mappings verified on hardware (keyMap.coraToWireImage / wireInputToCora / offsets)
[ ] Image and input key maps agree in direction (a flip in one needs the matching flip in the other)
[ ] Runtime tuning used for calibration has been baked back into the DeviceModel
[ ] Elgato software / Companion connects and receives key events
```

---

## Common pitfalls

**hid_open succeeds but reads are all zeros / wrong data** → wrong HID interface. Set
`usagePage`/`usage` and confirm `deckbridge devices` lists the correct path.

**Wrong colors (red/blue swapped)** → `colorMode` does **not** fix this; see
[Color order is not implemented](#color-order-is-not-implemented-known-limitation).

**Key presses not registered** → check your `parseInput` report-ID guard
(`data[0] !== 0x01`) against a real key press captured with hidapitester.

**Multiple devices detected as the same model** → make `usbProductIds` a precise list;
overlapping PIDs need separate model entries with specific PIDs.

**Images land on the wrong key relative to touch** → the image and input directions are
resolved separately, so a row-flipped `coraToWireImage` paired with an identity
`inputOffset` puts the picture on one key and the press on another. Derive both on
hardware (learn mode covers the input side) rather than assuming one implies the other.

**`hid_write` returns -1:** check framing conventions.
Mirabox prepends its configured report ID.
Elgato strategies already include report IDs.
AKP05 framing also includes that byte.
Never prepend report IDs twice.

**macOS: crash or SIGBUS on reconnect** → see the `hid_exit()` / `_workerHidLib` rules
under [Key design rules](#step-3--implement-the-driver).
