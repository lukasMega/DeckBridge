/** Generic USB HID worker message protocol. */
import type {
  KeyState,
  DialEvent,
  TouchInputEvent,
  TouchStripOptions,
  TouchWindowRegion,
} from './types.js';
import type { DeviceModelId, DeviceImageSpec, DeviceModelOverride } from './devices/driver.js';
import type { LogLevel } from './logger.js';

export type MainToWorker =
  // `hidPath` targets a SPECIFIC unclaimed HID interface (multi-device: two
  // units of the same model). Absent → the driver enumerates + opens the first
  // usage-matched path itself (primary probe).
  // `overrides` is the user's device tuning for this model (settings.json
  // modelOverrides). The whole effective model is deliberately NOT sent: the
  // worker keeps sourcing driverKind/VID/PID from its own registry, so no
  // override can smuggle in a different driver, and the message stays small.
  | {
      type: 'open';
      modelId: DeviceModelId;
      hidPath?: string;
      overrides?: DeviceModelOverride;
    }
  // Raw CORA image: the worker transforms (resize/rotate/encode) + caches it,
  // then writes it to the device. Off the main thread so the FFI
  // transform never stalls the CORA ACK loop (see P1).
  | { type: 'image'; keyIndex: number; bytes: Uint8Array; format: 'jpeg' | 'bmp' }
  // Already-native bytes (pre-encoded) — written verbatim, no transform.
  | { type: 'sendImage'; keyIndex: number; bytes: Uint8Array }
  // Source image with an explicit transform spec (which may differ from
  // model.image — splash orientation overrides, or a widget's own geometry;
  // see splash-sender.ts and extra-keys.ts). The worker transforms with the
  // given spec and then writes it. Offloads the synchronous FFI call that
  // would otherwise stall the main thread on every device connect (see P1 /
  // Finding 1).
  | { type: 'imageWithSpec'; keyIndex: number; bytes: Uint8Array; spec: DeviceImageSpec }
  | { type: 'setBrightness'; level: number }
  | { type: 'clearKey'; keyIndex: number }
  // Live device-tuning swap — image-transform fields only, so no reopen is
  // needed. Re-merged on top of the worker's OWN registry entry, exactly like
  // 'open'. The main thread sends this only when keyMap/wire/splash are
  // untouched (classifyOverrideChange in devices/model-overrides.ts); the
  // worker ignores those sections regardless, since the open driver instance
  // keeps reading the model it opened with.
  | { type: 'setOverrides'; overrides?: DeviceModelOverride }
  // Assembled Stream Deck + window image (800×100 JPEG, or a partial-window
  // region) — the worker splits it into the device's touch-segment displays.
  | { type: 'touchImage'; bytes: Uint8Array; region?: TouchWindowRegion }
  // Touch-strip wire ids DeckBridge widgets own: 'touchImage' segments for them
  // are withheld, and a zone leaving the mask gets the app's image back. The worker resets it to empty on open/close.
  | { type: 'setTouchStripMask'; wireIds: number[] }
  // Redraw the app's image (black if it never drew) on zones a widget just left.
  | { type: 'restoreTouchSegments'; wireIds: number[] }
  // Full-strip zone fit + upload policy (settings.json). Reset to the defaults on open.
  | { type: 'setTouchStripOptions'; options: TouchStripOptions }
  // Runtime log-level change (WebUI "Debug logging"). Without this the USB
  // worker — where the interesting device traffic is — stays at its spawn-time
  // level while the main thread switches to debug.
  | { type: 'setLogLevel'; level: string }
  | { type: 'close' };

export type WorkerToMain =
  | { type: 'opened'; ok: true; deviceSerial?: string; deviceFirmware?: string; hidPath?: string }
  | { type: 'opened'; ok: false; error: string }
  | { type: 'key'; keyIndex: number; state: KeyState }
  | { type: 'dial'; event: DialEvent }
  | { type: 'touch'; event: TouchInputEvent }
  | { type: 'inputAction'; message: string }
  | { type: 'log'; level: LogLevel; component: string; message: string }
  | { type: 'error'; message: string }
  // One image finished writing to the device — drives the WebUI imagesSent stat.
  | { type: 'imageSent'; keyIndex: number }
  // The driver re-initialized the device (sleep/wake CLE ALL) — the main
  // thread repaints what it owns (extra-key icons).
  | { type: 'reinit' }
  | { type: 'disconnect' }
  | { type: 'closed' };
