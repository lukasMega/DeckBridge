# Adding a New Device

Adding support for a new USB stream-deck-style device — from a known brand on an existing
wire protocol to one whose protocol you must reverse-engineer.

**Short version: fill in one `DeviceModel` config file.** Geometry, image transform, wire
framing, key-index mapping, CORA advertisement, and splash overrides are all fields on
that one object, read generically by `devices/registry.ts` and the pipeline. You touch
other files only when the device needs *new code* (a new protocol's byte framing, or a
fundamentally different driver).

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

image-pipeline.ts (main thread) — on each CORA image:
  ├─ pushes the CORA bytes to the WebUI (base64 over WebSocket), immediately
  └─ WorkerHidDriver.renderCoraImage(keyIndex, data, format) → postMessage → worker

image-render.ts (worker thread) — on each forwarded image:
  ├─ transforms via deckbridge-native cdylib (FFI: resize/rotate/flip) + LRU cache
  ├─ remaps CORA key index → device wire key index
  └─ driver.sendImage(deviceKeyIndex, nativeBytes)
```

Full pipeline diagram (threads, cache, transform): [Image Flow](./image-flow.md).

**What you'll touch for any new device:**

| Layer | File(s) | What it does |
|---|---|---|
| Device model | `devices/<brand>/<model>.ts` + `devices/registry.ts` | **The single source of truth** — geometry, VID/PID, image spec, wire framing, key map, CORA identity, splash overrides |
| Wire protocol (only if new) | `devices/protocol/<proto>.ts` + `PROTOCOL_STRATEGY` table | Packet framing for image send + key input parsing |
| Driver class (only if new pattern) | `devices/hid-driver-base.ts` or new file + `driverKind` | HID open/read/write loop |

Everything else (`translator.ts`, `image-pipeline.ts`, `splash-sender.ts`,
`driver-manager.ts`) reads `model.keyMap` / `image` / `cora` / `splash` / `driverKind`
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

Sniff traffic between the device and its official software — **macOS**:
[Wireshark](https://www.wireshark.org/)+USBPcap or
[hidapitester](https://github.com/todbot/hidapitester); **Linux**: `usbmon`+Wireshark;
**Windows VM**: USBPcap/Wireshark (often easiest for proprietary drivers).

Capture open → send image → press key → set brightness → close, and record: input report
layout (bytes, 0/1-based key index), image packet format (header, payload size, chunking),
brightness command, and any required handshake/heartbeat.

---

## Step 1 — write the `DeviceModel`

Create `ts/src/devices/<brand>/<model>.ts` — the single source of truth:

```typescript
// ts/src/devices/acme/acme-x5.ts
import type { DeviceModel } from '../driver.js';
import { IMAGE_JPEG_QUALITY, ELGATO_MK2_PID } from '../../types.js';
import { MK2_CHILD_GEOMETRY } from '../../capabilities.js';

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

  // wire: {…}  // Mirabox-only byte-level framing; omit for elgato-hid (see Step 3).

  // CORA (MK.2, 0-based row-major) ↔ device wire ids; empty = identity. See Step 4.
  // keyMap: { coraToWireImage: [...], wireInputToCora: [...], imageOffset, inputOffset }
  keyMap: {},

  // What this device advertises to the Elgato desktop over CORA.
  cora: {
    productId: ELGATO_MK2_PID,        // PID the desktop sees; non-Elgato spoof MK.2
    advertiseGeometry: MK2_CHILD_GEOMETRY, // omit to derive from this model
    usePhysicalIdentity: false,       // true = forward real serial/firmware (Elgato only)
  },

  // splash: { transformOverride: { rotate: 180 } },  // when splash orientation differs from live

  driverKind: 'elgato-hid',   // 'elgato-hid' | 'mirabox' | 'custom' — see Step 4
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
| `resizeFilter` | `'triangle'` (default) \| `'nearest'` \| `'lanczos3'` — the resize filter used for `resizeMode: 'resize'` | `'lanczos3'` for quality up/downscales (Mirabox 293: 72→112 upscale; K1 Pro: 68→64) |
| `resizeMode` | `'resize'` (default — interpolate to `width`×`height`) or `'pad'` (keep source pixels 1:1, centre them top-left-biased in the canvas, fill the border per `padFill`; falls back to `'resize'` if the source is larger than the canvas) | Use `'pad'` when the device's native key size is larger than the CORA source and you don't want upscale blur — e.g. the 293S pads 72→85 |
| `padFill` | Border fill for `resizeMode: 'pad'`: `'black'` \| `'average'` (mean source colour) \| `'edge'` (default — clamp/replicate the nearest source pixel) | Ignored when `resizeMode` isn't `'pad'` |
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
| `advertiseGeometry` | Geometry sent in CORA capabilities. Omit to derive it from this model's own `rows`/`columns`/`keyCount`/`keyWidth`/`keyHeight`. Non-Elgato devices typically set this to `MK2_CHILD_GEOMETRY` so they present as a 15-key MK.2 regardless of physical layout. |
| `usePhysicalIdentity` | `true` forwards the device's real serial number / firmware version (Elgato devices only — the desktop expects them to match). `false` (Mirabox/third-party) keeps the configured mock identity. |

### `keyMap` field reference — translating between CORA and device key indices

CORA (and this app's internal logic) always uses **MK.2 indices**: 0-based, row-major,
top-left to bottom-right. Your device's wire protocol may number keys differently (1-based,
column-major, non-contiguous, etc). Two independent translations may be needed — fill in
only the ones your device requires:

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
  | 'elgato-gen1'
  | 'elgato-gen2'
  | 'acme-v1';       // add your protocol
```

**Skip if your device reuses an existing protocol** (e.g. same packet format as gen2 with
a different VID/PID — just set `protocol: 'elgato-gen2'`).

---

## Step 3 — implement the driver

Choose one of three paths, matching the model's `driverKind` to the implementation.

### Path A — reuse `ElgatoHidDriver` (gen1 / gen2 compatible)

Set `driverKind: 'elgato-hid'` and `protocol: 'elgato-gen1'`/`'elgato-gen2'`.
`ElgatoHidDriver` looks up byte-framing from `PROTOCOL_STRATEGY` by `model.protocol` — no
new driver code.

### Path B — new HID packet format, same open/read/write pattern

Set `driverKind: 'elgato-hid'` with a new `protocol`, write the framing functions, and
**add one `PROTOCOL_STRATEGY` entry** in `devices/protocol/index.ts`:

```typescript
// ts/src/devices/protocol/acme-v1.ts
const PACKET_SIZE = 1024;
const HEADER_SIZE = 10;  // whatever your captures showed
const PAYLOAD_SIZE = PACKET_SIZE - HEADER_SIZE;

/** Encode a JPEG for key `keyIndex` into output report buffers. */
export function acmePackImage(keyIndex: number, jpegBytes: Uint8Array): Uint8Array[] {
  const packets: Uint8Array[] = [];
  for (let offset = 0, part = 0; offset < jpegBytes.length || part === 0; offset += PAYLOAD_SIZE, part++) {
    const chunk = jpegBytes.subarray(offset, offset + PAYLOAD_SIZE);
    const isLast = offset + PAYLOAD_SIZE >= jpegBytes.length;
    const pkt = new Uint8Array(PACKET_SIZE);
    pkt[0] = 0x02; pkt[1] = keyIndex; pkt[2] = isLast ? 1 : 0; pkt[3] = part & 0xff; // header
    pkt.set(chunk, HEADER_SIZE);
    packets.push(pkt);
    if (isLast) break;
  }
  return packets;
}

/** Parse an input report into key states. Return null if not a button report. */
export function acmeParseInput(data: Uint8Array, keyCount: number):
  Array<{ keyIndex: number; pressed: boolean }> | null {
  if (data[0] !== 0x01) return null;  // report ID guard
  return Array.from({ length: keyCount }, (_, i) => ({ keyIndex: i, pressed: data[1 + i] !== 0 }));
}

export function acmeBrightnessReport(pct: number): Uint8Array {
  const buf = new Uint8Array(32);
  buf[0] = 0x03; buf[1] = Math.max(0, Math.min(100, pct));
  return buf;
}

export function acmeResetReport(): Uint8Array {
  const buf = new Uint8Array(32); buf[0] = 0x04; return buf;
}
```

```typescript
// ts/src/devices/protocol/index.ts — add one entry, touch zero call-sites in hid-driver-base.ts
import { acmePackImage, acmeParseInput, acmeBrightnessReport, acmeResetReport } from './acme-v1.js';

export const PROTOCOL_STRATEGY: Partial<Record<DeviceProtocol, ProtocolStrategy>> = {
  // ...existing entries...
  'acme-v1': {
    packImage: acmePackImage,
    parseInput: acmeParseInput,
    brightnessReport: acmeBrightnessReport,
    resetReport: acmeResetReport,
  },
};
```

`ElgatoHidDriver` resolves the strategy once in its constructor
(`PROTOCOL_STRATEGY[model.protocol]!`) and calls `this.strategy.*` — no per-call branching.

### Path C — completely different driver (new protocol class)

If the device has a fundamentally different communication pattern (different handshake,
heartbeat, multi-step init, bulk transfer instead of interrupt, etc.) write a standalone
driver class, set `driverKind: 'custom'`, and add it to the factory in `hid-worker.ts`
(Step 5). Reference: `MiraboxDriver` (`ts/src/mirabox.ts`), the most feature-complete
custom driver — it reads wire framing from `model.wire` instead of hardcoding it. Prefer
**extending `HidDeviceBase`** (`ts/src/devices/hid-connection.ts`), the shared base both
real drivers extend: it already owns the lib singleton, device handle, polling read loop,
and teardown. The sample below is standalone purely to show the minimum `DeviceDriver`
surface — for a real Path C driver, extend `HidDeviceBase` instead.

Minimum `DeviceDriver` surface (see `devices/driver.ts`). The sample below is standalone
for clarity, but a real Path C driver should **extend `HidDeviceBase`** — it already owns
the lib singleton, device handle, poll loop, and SIGBUS-safe teardown described in the
rules below.

```typescript
// ts/src/devices/acme/acme-driver.ts
import { EventEmitter } from 'node:events';
import { loadHidapi, findHidPath, isNullPtr } from '../../ffi/hidapi.js';
import type { DeviceModel } from '../driver.js';

let _workerHidLib: ReturnType<typeof loadHidapi> | null = null; // per-worker singleton

export class AcmeDriver extends EventEmitter {
  private device: unknown = null;
  private hidLib: ReturnType<typeof loadHidapi> | null = null;
  private readTimer: ReturnType<typeof setInterval> | null = null;
  constructor(readonly model: DeviceModel) { super(); }

  async open(): Promise<void> {
    if (!_workerHidLib) _workerHidLib = loadHidapi();
    this.hidLib = _workerHidLib;
    const hid = this.hidLib.symbols;

    // Path-based open first (macOS-safe), then hid_open(VID, PID) per PID.
    let dev: unknown = null;
    if (this.model.usagePage !== undefined) {
      const path = findHidPath(this.model.usbVendorId, this.model.usagePage, this.model.usage!);
      if (path) dev = hid.hid_open_path(path);
    }
    if (!dev || isNullPtr(dev))
      for (const pid of this.model.usbProductIds) {
        dev = hid.hid_open(this.model.usbVendorId, pid, null);
        if (!isNullPtr(dev)) break;
      }
    if (!dev || isNullPtr(dev)) {
      try { hid.hid_exit(); } catch {}     // release after FAILED open — never dlclose() (macOS SIGBUS)
      this.hidLib = _workerHidLib = null;
      throw new Error(`${this.model.name}: device not found`);
    }

    this.device = dev;
    this._sendInit();                       // handshake / brightness / clear / heartbeat
    // 5ms poll — hid_read_timeout blocks ≤5ms; emit 'error'+'disconnect' on failure.
    const buf = new Uint8Array(512);
    this.readTimer = setInterval(() => {
      if (!this.device) return;
      const n = hid.hid_read_timeout(this.device, buf, 512, 5) as number;
      if (n < 0) { const e = String(hid.hid_error(this.device)); this._cleanup(); this.emit('error', new Error(e)); this.emit('disconnect'); return; }
      if (n > 0) this._parseInput(buf.subarray(0, n));
    }, 5);
  }

  async close(): Promise<void> { this._cleanup(); }

  sendImage(keyIndex: number, bytes: Uint8Array): void {   // `bytes` already native-format
    for (const pkt of acmePackImage(keyIndex, bytes)) this._write(pkt);
  }
  clearKey(_k: number): void { /* device clear cmd or a real black JPEG — never an all-zero buffer */ }
  setBrightness(level: number): void {
    if (this.device) this.hidLib!.symbols.hid_send_feature_report(this.device, acmeBrightnessReport(level), 32);
  }

  private _sendInit(): void { /* protocol-specific handshake */ }
  private _write(buf: Uint8Array): void {                  // hid_write needs report-ID byte at index 0
    const arr = new Uint8Array(buf.length + 1); arr.set(buf, 1);
    if (this.device) this.hidLib!.symbols.hid_write(this.device, arr, arr.length);
  }
  private _parseInput(data: Uint8Array): void {
    for (const { keyIndex, pressed } of acmeParseInput(data, this.model.keyCount) ?? [])
      this.emit('key', { keyIndex, state: pressed ? 'down' : 'up' });
  }
  private _cleanup(): void {
    if (this.readTimer) { clearInterval(this.readTimer); this.readTimer = null; }
    if (this.device) { this.hidLib!.symbols.hid_close(this.device); this.device = null; }
    if (this.hidLib) { this.hidLib.symbols.hid_exit(); this.hidLib.close(); this.hidLib = _workerHidLib = null; }
  }
}
```

**Key design rules for any driver:**
- `hid_write` requires `report-ID byte + payload`. Prepend `0x00` if the device uses report ID 0.
- `hid_read_timeout` with ≤5ms is safe on the single-threaded worker event loop.
- Always emit `'error'` then `'disconnect'` on read failure so `driver-manager` can reconnect.
- After a failed open, call `hid_exit()` but never `dlclose()` (macOS IOKit bug — see
  `_releaseLibAfterFailedOpen` in `devices/hid-connection.ts`).
- Load `hidapi` through a module-level `_workerHidLib` singleton (as the sample and both real drivers do) so a GC or premature `dlclose()` can't unload it mid-callback. Only clear it in `_cleanup()` after a successful open was closed.
- If the device needs a heartbeat, use `setInterval` and cancel it in `_cleanup`.
- Read byte-level framing constants (packet size, heartbeat interval, quirks) from
  `model.wire` rather than hardcoding them — that's what lets `MiraboxDriver` serve
  both `mirabox-cora` and `mirabox-cora-v1` from one class.

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

**Order matters**: `probeAndOpen()` tries models in order and stops at the first
successful `hid_open` — put specific/Elgato devices before catch-alls that share a VID/PID
range. `DEFAULT_MODEL` (the no-device fallback) stays `MK2_MODEL` unless you need otherwise.

---

## Step 5 — wire up `hid-worker.ts` (Path C only)

`createDriver()` switches on `model.driverKind`. Path A/B (`'elgato-hid'`) need **no
changes here**; for Path C add a case:

```typescript
// ts/src/hid-worker.ts
import { AcmeDriver } from './devices/acme/acme-driver.js';

type AnyRealDriver = ElgatoHidDriver | MiraboxDriver | AcmeDriver;

function createDriver(model: DeviceModel): AnyRealDriver {
  switch (model.driverKind) {
    case 'elgato-hid':
      return new ElgatoHidDriver(model);
    case 'mirabox':
      return new MiraboxDriver(model);
    case 'custom':
      return new AcmeDriver(model);   // ← your driverKind: 'custom' branch
  }
}
```

Then set `driverKind: 'custom'` on your model.

---

## Phase 4 — measure image orientation on hardware

Run with `DECKBRIDGE_MOCK=0` and a real device connected. Push a known asymmetric image
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

---

## Phase 5 — measure key index mappings on hardware

If you started with an empty `keyMap` (identity), verify it now:

1. Push a labelled image to all 15 keys from the web UI mock, then switch to real.
2. Press each physical key and check the index logged in the web UI comm panel.
3. Fill in `keyMap.coraToWireImage` / `wireInputToCora` (or `imageOffset` / `inputOffset`
   for a constant shift) from your observations.

For an N-key device with N > 15, pick which keys map to "keys 0–14" and set `-1` for
unused physical keys in `wireInputToCora`.

---

## Checklist

```
[ ] VID, PID(s), usage page, usage gathered
[ ] DeviceModel file created (devices/<brand>/<model>.ts) — geometry, image, keyMap, cora, splash
[ ] DeviceVendor updated if new brand
[ ] DeviceProtocol updated if new wire format
[ ] Driver implemented (Path A / B / C); PROTOCOL_STRATEGY entry added (Path B)
[ ] Model registered in DEVICE_MODELS (registry.ts)
[ ] hid-worker.ts createDriver() updated (Path C only)
[ ] mise run beforeCommit passes (format + lint + types + test + compile)
[ ] Image orientation verified on hardware (image.rotate/flipH/flipV, splash.transformOverride)
[ ] Key mappings verified on hardware (keyMap.coraToWireImage / wireInputToCora / offsets)
[ ] Elgato software / Companion connects and receives key events
```

---

## Common pitfalls

**hid_open succeeds but reads are all zeros / wrong data** → wrong HID interface. Set
`usagePage`/`usage` and confirm `findHidPath` resolves the correct path.

**Wrong colors (red/blue swapped)** → `colorMode` does **not** fix this; see
[Color order is not implemented](#color-order-is-not-implemented-known-limitation).

**Key presses not registered** → check your `parseInput` report-ID guard
(`data[0] !== 0x01`) against a real key press captured with hidapitester.

**Multiple devices detected as the same model** → make `usbProductIds` a precise list;
overlapping PIDs need separate model entries with specific PIDs.

**hid_write always returns -1** → the report must be `pktSize + 1` bytes with report ID
`0x00` at index 0; check `_write()` prepends it.

**macOS: crash or SIGBUS on reconnect** → see the `hid_exit()` / `_workerHidLib` rules
under [Key design rules](#step-3--implement-the-driver).
