# Adding a New Protocol

For a deck whose wire protocol DeckBridge does not speak yet. If the deck is a rebadge of
a supported board, [Adding a device](./adding-a-device.md) is all you need; this page
covers what comes before its step 3: the protocol, the driver and a hand-written
`DeviceModel`.

Validated against source: 2026-10-06.

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

**What you author for a new protocol:**

| File(s) | What |
|---|---|
| `devices/<brand>/<model>.ts` | The `DeviceModel` — **the single source of truth** for geometry, VID/PID, image spec, wire framing, key map, CORA identity, splash overrides |
| `devices/protocol-metadata.ts` | One `PROTOCOLS` entry |
| `devices/usb-drivers.ts` | One `USB_DRIVERS` entry |
| `devices/protocol/<proto>.ts` + `PROTOCOL_STRATEGY` | Path B only |
| a driver class | Path C only |
| `ts/test/` | Protocol tests; expectations are hand-written, never derived from the code they check |

Registration, notes and generated files then follow
[Adding a device](./adding-a-device.md#3-register). `translator.ts`, `dock-frames.ts`,
`splash-sender.ts` and `driver-manager.ts` read the model generically and are not edited.

---

## Phase 0 — gather device info before writing any code

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

Capture traffic using platform-supported USB tools. Separate passive captures from active
probes: existing probes can initialize hardware. Record the exact tool and operating
system.

Capture open → send image → press key → set brightness → close, and record: input report
layout (bytes, 0/1-based key index), image packet format (header, payload size, chunking),
brightness command, and any required handshake/heartbeat.

---

## Step 1 — write the `DeviceModel`

```typescript
// ts/src/devices/acme/acme-x5.ts
import type { DeviceModel } from '../driver.js';
import { IMAGE_JPEG_QUALITY, ELGATO_MK2_PID } from '../../shared/types.js';

const ACME_VID = 0xabcd;
const ACME_PIDS = [0x0001, 0x0002] as const;
const ACME_KEY_SIZE = 96;

export const ACME_X5_MODEL: DeviceModel = {
  id: 'acme-x5',              // stable kebab slug — used in logs, cache, web UI
  vendor: 'acme',             // kebab-case slug, diagnostic only; nothing to register
  protocol: 'acme-v1',        // see Step 2
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
    rotate: 0,                // start at 0; calibrate on hardware
    flipH: false,
    flipV: false,
    colorMode: 'rgb',         // ⚠️ not wired for JPEG today — see "Color order" below
    maxBytes: 0,              // 0 = no cap (JPEG, firmware scales); cap if device needs it
    quality: IMAGE_JPEG_QUALITY,
    transform: 'sidecar',     // 'passthrough' only valid for rotate:0/no-flip/no-cap gen2-style devices
  },

  // Required HID sizes plus protocol-specific behavior (see Step 3).
  wire: { packetSize: 1024, inSize: 512 },

  // CORA (MK.2, 0-based row-major) ↔ device wire ids; empty = identity.
  // keyMap: { coraToWireImage: [...], wireInputToCora: [...], imageOffset, inputOffset }
  keyMap: {},

  // What this device advertises to the Elgato desktop over CORA.
  cora: {
    productId: ELGATO_MK2_PID,        // PID the desktop sees; non-Elgato spoof MK.2
    advertiseAs: 'mk2',               // omit to use this model's geometry
    usePhysicalIdentity: false,       // true = forward real serial/firmware (Elgato only)
  },

  // splash: { transformOverride: { rotate: 180 } },  // when splash orientation differs from live
};
```

The catalog validator (`devices/validate-model.ts`) runs in `devices-generate`,
`devices-check` and `mise run test`; each error names the model id.

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

Rotations apply CW before flips. If splash images need a different orientation than live
frames (some hardware does), set `splash.transformOverride` rather than changing `image`.

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

CORA uses zero-based indices on the advertised grid (`advertisedGeometry(model)`: Mini,
MK.2, Plus, …; legacy helper names still say MK.2). Image addresses and input codes
differ, so measure each direction independently:

- **Image** (`sendImage`): CORA key index → device wire image id — `coraToWireImage`
  (explicit array) or `imageOffset` (constant), else identity.
- **Input** (`parseInput`): device wire key code → CORA index — `wireInputToCora`
  (explicit array, `-1` = unused) or `inputOffset` (constant), else identity.

Precedence is **explicit array > offset > identity**, resolved independently per direction
(e.g. `mirabox-293` uses an explicit `coraToWireImage` array but a simple `inputOffset`).
Start with everything unset (identity); key-map learn mode measures the input side on
hardware. A row-flipped image map paired with an identity input map puts the picture on
one key and the press on another, so check both.

---

## Step 2 — register the protocol

Protocol facts live in one table, `PROTOCOLS` in `devices/protocol-metadata.ts`;
`DeviceProtocol` is its key type:

```typescript
// ts/src/devices/protocol-metadata.ts
  'acme-v1': { tunableWireKeys: ['packetSize', 'inSize'], family: 'mirabox-v3', strategy: false },
```

- `tunableWireKeys`: the `wire` fields the driver reads, the only ones a user may tune at
  runtime. Any other override is rejected and left out of the Device tuning form. Setting
  them in the `DeviceModel` literal is unaffected.
- `family`: groups the protocol in the generated docs. A new family also needs an entry
  in `FAMILIES` inside `gen-device-docs.mjs`.
- `strategy`: true when `ElgatoHidDriver` frames it through a `PROTOCOL_STRATEGY` entry
  (Path B).

**Skip if your device reuses an existing protocol** (e.g. same packet format as gen2 with
a different VID/PID — just set `protocol: 'elgato-gen2'`).

---

## Step 3 — implement the driver

Choose one of three paths.

### Path A — reuse `ElgatoHidDriver` (gen1 / gen2 compatible)

Set `protocol: 'elgato-gen1'`/`'elgato-gen2'`. `ElgatoHidDriver` looks up byte-framing
from `PROTOCOL_STRATEGY` by `model.protocol` — no new driver code. Packet and input
report sizes still come from `model.wire`.

### Path B — new HID packet format, same open/read/write pattern

Add a new `protocol` (`tunableWireKeys: []`, `strategy: true`), write the framing
functions, and **add one `PROTOCOL_STRATEGY` entry** in `devices/protocol/index.ts`.
Every strategy implements six required members:

| Member | Required behavior |
|---|---|
| `writeImage` | Frame chunks into caller-owned scratch |
| `parseInput` | Validate length, then decode states |
| `brightnessReport` | Return complete feature-report bytes |
| `resetReport` | Return complete reset-report bytes |
| `blankImage` | Produce valid native black image |
| `infoReports` | Describe serial and firmware reports |

Use `elgato-gen1.ts` or `elgato-gen2.ts` as examples; framing helpers live in
`protocol/framing.ts`. Never invent report addresses for compatibility: unsupported
identity reads require driver changes. `ElgatoHidDriver` assumes feature-report
brightness/reset and snapshot-style key states; if the device differs, choose Path C.

### Path C — completely different driver (new protocol class)

For a fundamentally different communication pattern (handshake, heartbeat, multi-step
init), write a driver class that extends `HidDeviceBase`
(`ts/src/devices/hid-device-base.ts`): it owns the per-worker lib singleton, the
path-only open, the device handle, the polling read loop, and the SIGBUS-safe teardown.
Implement the worker-side `UsbDriver` interface from `usb-drivers.ts`.

| Reference | Reusable pattern |
|---|---|
| `devices/elgato/driver.ts` | Feature reports and state snapshots |
| `devices/mirabox/driver.ts` | CRT framing read from `model.wire`, conditional batching |
| `devices/ajazz/akp05-driver.ts` | Initialization, keepalive, dials, touch |

`HidDeviceBase` only provides HID transport; a bulk-transfer device needs separate
architecture work.

**Key design rules for any driver:**
- Include exactly one report-ID byte. Mirabox prepends its configured report ID; Elgato
  strategies and AKP05 framing already include it. Never prepend it twice.
- `hid_read_timeout` with ≤5ms is safe on the single-threaded worker event loop.
- Always emit `'error'` then `'disconnect'` on read failure so `driver-manager` can reconnect.
- After a failed open, call `hid_exit()` but never `dlclose()` (macOS IOKit bug — see
  `_releaseLibAfterFailedOpen` in `devices/hid-device-base.ts`).
- Acquire libraries through `HidDeviceBase._openPath()` and keep its failure cleanup.
- Open by path only. Never call `hid_open(VID, PID)`: on macOS it opens the first IOKit
  interface and a denied open SIGBUSes.
- If the device needs a heartbeat, use `setInterval` and cancel it in `_cleanup`.
- Expose only genuinely supported wire settings in `tunableWireKeys` (AKP05 framing fixes
  its output size, so it exposes only `inSize`).

---

## Step 4 — register in `USB_DRIVERS`

`USB_DRIVERS` (`devices/usb-drivers.ts`) maps each protocol to a driver factory; a
missing entry is a type error. Path B maps to `ElgatoHidDriver`, Path C to its own class.

```typescript
// ts/src/devices/usb-drivers.ts
import { AcmeDriver } from './acme/acme-driver.js';

export const USB_DRIVERS: Record<DeviceProtocol, (model: DeviceModel) => UsbDriver> = {
  // …
  'acme-v1': (model) => new AcmeDriver(model),
};
```

`ts/test/packet-replay.test.ts` replays recorded traffic through the real driver;
`mise run device-capture -- --model <id>` writes a fixture skeleton for a connected deck.

---

## Then

Continue with [Adding a device](./adding-a-device.md#3-register) from step 3: register,
notes, generate, calibrate, check.

## Driver pitfalls

**hid_open succeeds but reads are all zeros / wrong data** → wrong HID interface. Set
`usagePage`/`usage` and confirm `deckbridge devices` lists the correct path.

**Key presses not registered** → check your `parseInput` report-ID guard
(`data[0] !== 0x01`) against a real key press captured with hidapitester.

**`hid_write` returns -1** → check the report-ID rule above.

**macOS: crash or SIGBUS on reconnect** → see the `hid_exit()` / `_workerHidLib` rules
under [Key design rules](#path-c--completely-different-driver-new-protocol-class).
