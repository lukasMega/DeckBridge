# Adding a New Device

Everything needed to add support for a new USB stream-deck-style device — from a known
brand on an existing wire protocol to a device whose protocol you must reverse-engineer.

**The short version: fill in one `DeviceModel` config file.** Geometry, image transform,
wire framing, key-index mapping, CORA advertisement, and splash overrides are all just
fields on that one object — `devices/registry.ts` and the rest of the pipeline read them
generically. You only touch other files when the device needs *new code* (a new protocol's
byte framing, or a fundamentally different driver).

---

## Architecture overview

```
USB device
  └─ libhidapi (via FFI, worker thread)
       └─ Driver class  ←  implements DeviceDriver (EventEmitter)
            ├─ emits 'key'        → driver-manager → CORA child server → Elgato software
            ├─ receives sendImage → translate key index → hid_write
            └─ receives setBrightness / clearKey
                        │
            image-pipeline.ts (main thread)
              ├─ routes CORA JPEG → deckbridge-native cdylib (in-process FFI: resize / rotate / flip)
              └─ calls driver.sendImage(deviceKeyIndex, nativeBytes)
```

Full image-pipeline diagram (threads, cache, transform): see
[Image Flow](./image-flow.md).

**What you'll touch for any new device:**

| Layer | File(s) | What it does |
|---|---|---|
| Device model | `devices/<brand>/<model>.ts` + `devices/registry.ts` | **The single source of truth** — geometry, VID/PID, image spec, wire framing, key map, CORA identity, splash overrides |
| Wire protocol (only if new) | `devices/protocol/<proto>.ts` + `PROTOCOL_STRATEGY` table | Packet framing for image send + key input parsing |
| Driver class (only if new pattern) | `devices/hid-driver-base.ts` or new file + `driverKind` | HID open/read/write loop |

Everything else — `translator.ts`, `image-pipeline.ts`, `splash-sender.ts`,
`driver-manager.ts` — reads `model.keyMap`, `model.image`, `model.cora`, `model.splash`,
and `model.driverKind` generically. You do not edit them for a config-only device.

---

## Phase 0 — gather device info before writing any code

You need the following before touching TypeScript:

### USB identifiers

```bash
# macOS
system_profiler SPUSBDataType | grep -A5 "Stream Deck\|Mirabox\|Your Brand"

# Linux
lsusb
```

Note: **VID** (Vendor ID) and **PID** (Product ID), both hex.

### HID usage page / usage

Devices with multiple HID interfaces need `usagePage` + `usage` to select the right one.
On macOS, `hidapi` defaults to the first interface, which is often system-claimed.

```bash
# macOS — show all HID devices with usage info
python3 - <<'EOF'
import hid
for d in hid.enumerate():
    print(f"VID={d['vendor_id']:#06x} PID={d['product_id']:#06x} "
          f"UP={d['usage_page']:#06x} U={d['usage']:#06x} path={d['path']}")
EOF
```

If the device has only one HID interface, `usagePage` / `usage` are optional in the model.

### Packet format

Use a HID sniffer to capture traffic between the device and its official software:

- **macOS**: [Wireshark](https://www.wireshark.org/) with USBPcap, or
  [hidapitester](https://github.com/todbot/hidapitester) for manual probing
- **Linux**: `usbmon` + Wireshark
- **Windows VM**: USBPcap / Wireshark on a VM is often easiest for proprietary drivers

Capture: open → send an image → press a key → set brightness → close.

Record:
- Button input report layout (which bytes, 0/1-based key index)
- Image packet format (header bytes, payload size, chunking scheme)
- Brightness command format
- Any handshake or heartbeat the device requires

---

## Step 1 — write the `DeviceModel`

Create `ts/src/devices/<brand>/<model>.ts` — the single source of truth described
above.

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

  // Mirabox-only: byte-level wire framing. Omit entirely for elgato-hid devices —
  // their framing lives in PROTOCOL_STRATEGY (see Step 3).
  // wire: { packetSize: 1024, inSize: 512, heartbeatMs: 8000,
  //         synthesizeKeyUp: false, sendStpAfterImage: true,
  //         chunkPadByte: false },  // true only for firmware that drops the
  //                                 // last byte of every full image chunk (K1 Pro)

  // CORA key index (MK.2, 0-based row-major) ↔ device wire ids.
  // Precedence per direction: explicit array > offset > identity.
  // Leave both empty for an identity mapping (e.g. Elgato devices, which already
  // use MK.2-native indices). See Step 4 for how to fill these in from hardware.
  keyMap: {
    // coraToWireImage: [ /* mk2 index → device wire image id */ ],
    // wireInputToCora: [ /* device wire code → mk2 index, -1 = unused */ ],
    // imageOffset: 0,
    // inputOffset: 0,
  },

  // What this device advertises to the Elgato desktop over CORA.
  cora: {
    productId: ELGATO_MK2_PID,        // PID the desktop sees; non-Elgato devices spoof MK.2
    advertiseGeometry: MK2_CHILD_GEOMETRY, // omit to derive geometry from this model
    usePhysicalIdentity: false,       // true = forward the device's real serial/firmware (Elgato only)
  },

  // Optional: splash-screen orientation differs from live CORA images on some hardware.
  // splash: { transformOverride: { rotate: 180 } },

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
| `transform` | `'passthrough'` (forward CORA JPEG unchanged) or `'sidecar'` (resize/rotate/flip via Rust) | `'passthrough'` only valid when `rotate: 0`, no flips, no `maxBytes` cap, and the device consumes CORA-native resolution (gen2-style). Everything else needs `'sidecar'`. |

### Color order is not implemented (known limitation)

> ⚠️ **`colorMode` is currently a no-op for JPEG devices.** Nothing in the pipeline
> reads it: `translator.ts:transformImageForDevice` does not forward a `color_mode`
> field, and `image_proc_transform` (`rust/deckbridge-native/src/lib.rs`, the in-process FFI
> cdylib) has no such parameter. For `format: 'bmp'` (gen1/Mini) the output is BGR because
> `encode_bmp` writes BGR unconditionally — not because of this field. **So toggling
> `colorMode: 'bgr'` will not fix swapped red/blue on a JPEG device.**
>
> **Fix task — if a JPEG device needs a channel swap, build it first:**
> 1. Add a `color_mode` (or `swap_rb`) parameter to `image_proc_transform` in
>    `rust/deckbridge-native/src/lib.rs` and swap the R/B channels before encoding.
> 2. Forward `color_mode: spec.colorMode` from `transformImageForDevice` in
>    `ts/src/translator.ts`.
>
> Until that exists, leave `colorMode: 'rgb'` and treat the field as descriptive only.

### `cora` field reference — what CORA advertises to the Elgato desktop

| Field | Meaning |
|---|---|
| `productId` | The PID the Elgato desktop sees in CORA capabilities. Elgato devices typically advertise their real PID (`usbProductIds[0]`); non-Elgato devices spoof `ELGATO_MK2_PID` so the desktop recognizes a known model. |
| `advertiseGeometry` | Geometry sent in CORA capabilities. Omit to derive it from this model's own `rows`/`columns`/`keyCount`/`keyWidth`/`keyHeight`. Non-Elgato devices typically set this to `MK2_CHILD_GEOMETRY` so they present as a 15-key MK.2 regardless of physical layout. |
| `usePhysicalIdentity` | `true` forwards the device's real serial number / firmware version (Elgato devices only — the desktop expects them to match). `false` (Mirabox/third-party) keeps the configured mock identity. |

### `keyMap` field reference — translating between CORA and device key indices

The CORA protocol (and this app's internal logic) always uses **MK.2 indices**:
0-based, row-major, top-left to bottom-right. Your device's physical wire protocol may
number keys differently (1-based, column-major, non-contiguous, etc).

Two independent translations may be needed — fill in only the ones your device requires:

- **Image** (`sendImage`): CORA key index → device wire image id.
  Set `coraToWireImage` (explicit lookup array) or `imageOffset` (constant offset),
  or leave both unset for an identity mapping.
- **Input** (`parseInput`): device wire key code → CORA (MK.2) key index.
  Set `wireInputToCora` (explicit lookup array, `-1` = unused/ignored key) or
  `inputOffset` (constant offset), or leave both unset for identity.

Precedence is **explicit array > offset > identity**, resolved independently per
direction — e.g. `mirabox-293` uses an explicit `coraToWireImage` array for images
but a simple `inputOffset` for input, because the two wire encodings differ.

Start with everything unset (identity mapping) if you don't know the layout yet —
see Phase 5 for how to measure and fill these in from hardware.

---

## Step 2a — register the vendor (if new)

`DeviceVendor` in `devices/driver.ts` is a union type:

```typescript
// ts/src/devices/driver.ts
export type DeviceVendor = 'mirabox' | 'elgato' | 'acme';  // add your brand
```

`vendor` is informational/diagnostic only — behavior that used to switch on it (CORA
product ID, advertised geometry, physical-identity forwarding) lives in `model.cora`.
No other code changes needed for a new vendor.

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

**Skip this step if your device reuses an existing protocol** (e.g., it speaks the same
HID packet format as gen2 with different VID/PID — just point `protocol` at `'elgato-gen2'`).

---

## Step 3 — implement the driver

Choose one of three paths, matching `driverKind` on the model to the implementation:

### Path A — reuse `ElgatoHidDriver` (gen1 / gen2 compatible)

Set `driverKind: 'elgato-hid'` and `protocol: 'elgato-gen1'` or `'elgato-gen2'`.
`ElgatoHidDriver` looks up its byte-framing functions from `PROTOCOL_STRATEGY` keyed
on `model.protocol` — no new driver code needed.

### Path B — new HID packet format, same open/read/write pattern

Set `driverKind: 'elgato-hid'` with a new `protocol` value, write the framing functions,
and **add one entry to the `PROTOCOL_STRATEGY` table** in `devices/protocol/index.ts`:

```typescript
// ts/src/devices/protocol/acme-v1.ts
const PACKET_SIZE = 1024;
const HEADER_SIZE = 10;  // whatever your captures showed
const PAYLOAD_SIZE = PACKET_SIZE - HEADER_SIZE;

/** Encode a JPEG for key `keyIndex` into output report buffers. */
export function acmePackImage(keyIndex: number, jpegBytes: Uint8Array): Uint8Array[] {
  const packets: Uint8Array[] = [];
  let offset = 0;
  let part = 0;
  while (offset < jpegBytes.length || part === 0) {
    const chunk = jpegBytes.subarray(offset, offset + PAYLOAD_SIZE);
    const isLast = offset + PAYLOAD_SIZE >= jpegBytes.length;

    const pkt = new Uint8Array(PACKET_SIZE);
    // --- fill your header here ---
    pkt[0] = 0x02;
    pkt[1] = keyIndex;
    pkt[2] = isLast ? 1 : 0;
    pkt[3] = part & 0xff;
    pkt.set(chunk, HEADER_SIZE);

    packets.push(pkt);
    offset += PAYLOAD_SIZE;
    part++;
    if (isLast) break;
  }
  return packets;
}

/** Parse an input report into key states. Return null if not a button report. */
export function acmeParseInput(
  data: Uint8Array,
  keyCount: number,
): Array<{ keyIndex: number; pressed: boolean }> | null {
  if (data[0] !== 0x01) return null;  // report ID guard
  const result = [];
  for (let i = 0; i < keyCount; i++) {
    result.push({ keyIndex: i, pressed: data[1 + i] !== 0 });
  }
  return result;
}

export function acmeBrightnessReport(pct: number): Uint8Array {
  const buf = new Uint8Array(32);
  buf[0] = 0x03;
  buf[1] = Math.max(0, Math.min(100, pct));
  return buf;
}

export function acmeResetReport(): Uint8Array {
  const buf = new Uint8Array(32);
  buf[0] = 0x04;
  return buf;
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

`ElgatoHidDriver` resolves its strategy once in the constructor
(`PROTOCOL_STRATEGY[model.protocol]!`) and calls `this.strategy.packImage(...)`,
`this.strategy.parseInput(...)`, etc. — no per-call branching to update.

### Path C — completely different driver (new protocol class)

If the device has a fundamentally different communication pattern (different handshake,
heartbeat, multi-step init, bulk transfer instead of interrupt, etc.) write a standalone
driver class, set `driverKind: 'custom'`, and add it to the factory in `hid-worker.ts`
(Step 5). Use `MiraboxDriver` as the reference — it is the most feature-complete example
of a custom driver, and reads its wire framing from `model.wire` rather than hardcoding it.

Minimum interface (must match `DeviceDriver` in `devices/driver.ts`):

```typescript
// ts/src/devices/acme/acme-driver.ts
import { EventEmitter } from 'node:events';
import { loadHidapi, findHidPath, isNullPtr } from '../../ffi/hidapi.js';
import type { DeviceModel } from '../driver.js';

// Module-level singleton — loaded once per worker thread, reused across reconnects.
// hid_init() registers IOKit callbacks that reference library code; letting the lib
// get dlclose()'d (via GC or a premature lib.close()) while they're live causes
// SIGBUS on the next dlopen(). Both real drivers do this — see the top of mirabox.ts.
let _workerHidLib: ReturnType<typeof loadHidapi> | null = null;

export class AcmeDriver extends EventEmitter {
  readonly model: DeviceModel;
  private device: unknown = null;
  private hidLib: ReturnType<typeof loadHidapi> | null = null;
  private readTimer: ReturnType<typeof setInterval> | null = null;

  constructor(model: DeviceModel) {
    super();
    this.model = model;
  }

  async open(): Promise<void> {
    if (!_workerHidLib) _workerHidLib = loadHidapi();
    this.hidLib = _workerHidLib;
    const hid = this.hidLib.symbols;

    // Prefer path-based open for macOS (avoids system-claimed interfaces).
    let dev: unknown = null;
    if (this.model.usagePage !== undefined) {
      const path = findHidPath(this.model.usbVendorId, this.model.usagePage!, this.model.usage!);
      if (path) dev = hid.hid_open_path(path);
    }
    if (!dev || isNullPtr(dev)) {
      for (const pid of this.model.usbProductIds) {
        dev = hid.hid_open(this.model.usbVendorId, pid, null);
        if (!isNullPtr(dev)) break;
      }
    }
    if (!dev || isNullPtr(dev)) {
      // Detach but do NOT hid_exit()/close the lib here: on macOS that crashes
      // after a failed open. Leave _workerHidLib loaded for the next attempt.
      this.hidLib = null;
      throw new Error(`${this.model.name}: device not found`);
    }

    this.device = dev;

    // Device-specific init sequence — send whatever your protocol requires.
    this._sendInit();

    // Polling read loop. 5ms timeout is safe: hid_read_timeout blocks ≤5ms.
    // Size IN_SIZE to your device's input report (both real drivers use 512).
    const IN_SIZE = 512;
    const readBuf = new Uint8Array(IN_SIZE);
    this.readTimer = setInterval(() => {
      if (!this.device || !this.hidLib) return;
      const n = hid.hid_read_timeout(this.device, readBuf, IN_SIZE, 5) as number;
      if (n < 0) {
        const msg = String(hid.hid_error(this.device) ?? 'unknown HID error');
        this._cleanup();
        this.emit('error', new Error(msg));
        this.emit('disconnect');
        return;
      }
      if (n > 0) this._parseInput(readBuf.subarray(0, n));
    }, 5);
  }

  async close(): Promise<void> {
    this._cleanup();
  }

  sendImage(keyIndex: number, bytes: Uint8Array): void {
    if (!this.device || !this.hidLib) return;
    // Build packets from `bytes` (already transformed to native format by image-pipeline).
    const packets = acmePackImage(keyIndex, bytes);
    for (const pkt of packets) this._write(pkt);
  }

  clearKey(keyIndex: number): void {
    // Send a device-specific clear command, or a *valid* tiny black image.
    // NOTE: an all-zero buffer is not a decodable JPEG. Use a real black-JPEG
    // constant (see ElgatoHidDriver.clearKey) or a CLE-style command (see MiraboxDriver.clearKey).
    this.sendImage(keyIndex, /* TINY_BLACK_JPEG or device clear cmd */ new Uint8Array(0));
  }

  setBrightness(level: number): void {
    if (!this.device || !this.hidLib) return;
    this.hidLib.symbols.hid_send_feature_report(
      this.device, acmeBrightnessReport(level), 32
    );
  }

  private _sendInit(): void {
    // Send handshake, brightness, clear, heartbeat start — whatever your protocol needs.
  }

  private _write(buf: Uint8Array): void {
    if (!this.device || !this.hidLib) return;
    // hid_write requires report ID prepended as byte 0.
    const arr = new Uint8Array(buf.length + 1);
    arr[0] = 0x00;
    arr.set(buf, 1);
    this.hidLib.symbols.hid_write(this.device, arr, arr.length);
  }

  private _parseInput(data: Uint8Array): void {
    const states = acmeParseInput(data, this.model.keyCount);
    if (!states) return;
    for (const { keyIndex, pressed } of states) {
      this.emit('key', { keyIndex, state: pressed ? 'down' : 'up' });
    }
  }

  private _cleanup(): void {
    if (this.readTimer) { clearInterval(this.readTimer); this.readTimer = null; }
    if (this.device && this.hidLib) {
      this.hidLib.symbols.hid_close(this.device);
      this.device = null;
    }
    if (this.hidLib) {
      // Safe to exit/close here: a device was opened, so IOKit state is consistent.
      this.hidLib.symbols.hid_exit();
      this.hidLib.close();
      this.hidLib = null;
      _workerHidLib = null; // allow a fresh load on the next open()
    }
  }
}
```

**Key design rules for any driver:**
- `hid_write` requires `report-ID byte + payload`. Prepend `0x00` if the device uses report ID 0.
- `hid_read_timeout` with ≤5ms is safe on the single-threaded worker event loop.
- Always emit `'error'` then `'disconnect'` on read failure so `driver-manager` can reconnect.
- Never call `hid_exit()` + `dlclose()` after a failed open (macOS IOKit bug — see comment in `mirabox.ts`).
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
  ACME_X5_MODEL,   // ← add here
];
```

**Order matters**: `probeAndOpen()` in `driver-manager.ts` tries each model in order and
stops at the first successful `hid_open`. Put Elgato / specific devices before catch-all
entries so they take priority over third-party devices that might share a VID/PID range.

`DEFAULT_MODEL` (also exported from `registry.ts`) is the fallback used when nothing is
connected — it stays `MK2_MODEL` unless you have a reason to change it.

---

## Step 5 — wire up `hid-worker.ts` (Path C only)

The worker thread instantiates the right driver class via `createDriver()`, which
switches on `model.driverKind`. Path A and B devices use `driverKind: 'elgato-hid'`
and need **no changes here**. For a Path C device, add a case:

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

Then set `driverKind: 'custom'` (or introduce a more specific `DriverKind` value if you
have several Path-C device families) on your model.

---

## Phase 4 — measure image orientation on hardware

Run with `DECKBRIDGE_MOCK=0` and a real device connected. Use the web UI (http://localhost:3000)
or Elgato software to push a known asymmetric image (e.g., a right-pointing arrow) to key 0.

Adjust `image.rotate` and `image.flipH` / `image.flipV` in the model until the image appears
upright and un-mirrored on the physical device:

| What you see | Fix |
|---|---|
| Image upside-down | `rotate: 180` |
| Image rotated 90° CW | `rotate: 270` |
| Image rotated 90° CCW | `rotate: 90` |
| Image mirrored left-right | `flipH: true` |
| Image mirrored top-bottom | `flipV: true` |
| Colors swapped (red/blue) | ⚠️ not auto-handled — see "Color order is not implemented" |

Rotations are applied CW before flips. If the device also needs a different orientation
for splash images than for live CORA frames (some hardware does), set
`splash.transformOverride` on the model rather than changing `image` itself.

---

## Phase 5 — measure key index mappings on hardware

If you started with an empty `keyMap` (identity mapping), verify it now.

1. Push image "key 0" (a big "0" label) to all 15 keys from the web UI mock, then switch to real.
2. Press each physical key and check the key index logged in the web UI comm panel.
3. Fill in `keyMap.coraToWireImage` / `keyMap.wireInputToCora` (or the simpler
   `imageOffset` / `inputOffset` if the mapping is a constant shift) based on your
   observations.

For an N-key device where N > 15, decide which keys to expose as "keys 0–14" and
set `-1` for unused physical keys in `wireInputToCora`.

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

**hid_open succeeds but reads are all zeros / wrong data**
→ You opened the wrong HID interface. Set `usagePage` and `usage` on the model and
ensure `findHidPath` in `ffi/hidapi.ts` resolves to the correct path.

**Images appear but with wrong colors (red/blue swapped)**
→ `colorMode` does **not** fix this — see
[Color order is not implemented](#color-order-is-not-implemented-known-limitation).

**Key presses not registered**
→ Check your protocol's `parseInput` — does the report ID guard (`data[0] !== 0x01`)
match your device? Capture a real key press with hidapitester and inspect the raw bytes.

**Multiple devices detected as the same model**
→ Ensure `usbProductIds` is a precise list. Two different models with overlapping PIDs need
separate model entries and specific PIDs in each `usbProductIds` array.

**hid_write always returns -1**
→ The HID report must be `pktSize + 1` bytes with report ID `0x00` at index 0.
Check your driver's `_write()` prepends the report ID byte correctly.

**macOS: crash or SIGBUS on reconnect**
→ See the `hid_exit()` / `_workerHidLib` rules under
[Key design rules](#step-3--implement-the-driver).
