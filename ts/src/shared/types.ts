// WebUI wire types live in the `web-contract` leaf (web/contract.ts) so the
// browser tier shares one declaration instead of mirroring ours. Re-exported
// here so every existing `types.js` import keeps working.
import type { KeyState, TouchStripMode } from '../web/contract.js';

export type {
  ClientApp,
  CommEntry,
  DockStatus,
  EncoderCommands,
  EncoderSettings,
  ExtraKeyTextStyle,
  ExtraKeyWidget,
  KeyState,
  RealDeviceIdentity,
  TouchStripMode,
  WidgetDisplayInfo,
} from '../web/contract.js';

export const ELGATO_MK2_PID = 0x00a5;
export const ELGATO_PLUS_PID = 0x0084;
/** Stream Deck + touch-strip dimensions (pixels). The window-strip image is split
 *  into one slice per device touch segment before rendering. */
export const PLUS_TOUCH_WIDTH = 800;
export const PLUS_TOUCH_HEIGHT = 100;
export const ELGATO_TCP_PORT = 5343;
export const ELGATO_CHILD_PORT = 5344;
// Multi-device: scanned docks use a fixed port stride off the primary pair, so
// dock i listens on primary ELGATO_TCP_PORT+2i and child ELGATO_CHILD_PORT+2i.
export const CORA_PORT_STRIDE = 2;
// Structural ceiling on dock indices (and therefore CORA port pairs):
// dock 0 (process-lifetime) + up to 3 scanned docks.
export const MAX_DOCKS = 4;
// How many docks the opt-in "multiple decks" setting actually allows (primary +
// one scanned dock). Without it DeckBridge runs a single dock and stops scanning USB
// once that dock is up — see dock-scanner.ts.
export const MAX_MULTI_DECK_DOCKS = 2;

// Default device identity strings
export const DEFAULT_DOCK_FIRMWARE_VERSION = '1.01.016';
export const DEFAULT_CHILD_FIRMWARE_VERSION = '1.01.000';
export const DEFAULT_DOCK_SERIAL_NUMBER = 'A7FZA5190ILSAA';
export const DEFAULT_CHILD_SERIAL_NUMBER = 'A7FZA5191ILSNQ';

// mDNS advertisement
export const MDNS_SERVICE_NAME = 'Network Stream Deck';
export const MDNS_SERVICE_TYPE = 'elg';
export const MDNS_PROTOCOL = 'tcp';
export const MDNS_TXT_DEVICE_TYPE = '215';
export const MDNS_TXT_VID = '4057';

export const FIRMWARE_REPORT_SIZE = 32;

// Default MAC address for the dock (6 bytes, colon-separated hex string for UI)
export const DEFAULT_MAC_ADDRESS_STRING = '02:00:00:00:00:01';
export const DEFAULT_MAC_ADDRESS = [0x02, 0x00, 0x00, 0x00, 0x00, 0x01] as const;

export const DEFAULT_BRIGHTNESS = 100;

// Image cache
export const IMAGE_CACHE_SIZE = 100;

// Image transform
export const IMAGE_JPEG_QUALITY = 0.9;

export const HID_POLL_INTERVAL_MS = 3_000;

// WebUI server
export const WEBUI_PORT = 3000;
export const WEBUI_LISTEN_ADDRESS = '127.0.0.1';

// Mock driver
export const MOCK_KEY_PRESS_DURATION_MS = 50;

// Server listen address — override with DECKBRIDGE_BIND (e.g. "127.0.0.1") to restrict
// the CORA servers (5343/5344) to a single interface. WebUI honors the same override
// (see webuiBindAddr() below) — unset, it stays WEBUI_LISTEN_ADDRESS (localhost-only).
// A function, not a module-load constant: the CLI's --bind flag writes DECKBRIDGE_BIND
// into tjs.env from app.ts's body, which runs AFTER this module's imports (hence its
// top-level code) have already evaluated — a plain constant would freeze in the
// pre-flag value.
export function bindAddr(): string {
  return (typeof tjs !== 'undefined' ? tjs.env['DECKBRIDGE_BIND'] : undefined) ?? '0.0.0.0';
}

// WebUI listen address — same DECKBRIDGE_BIND override as bindAddr(), but defaults to
// WEBUI_LISTEN_ADDRESS (127.0.0.1) rather than 0.0.0.0: unset, the WebUI stays
// loopback-only exactly as before --bind existed; an explicit --bind (e.g. 0.0.0.0)
// exposes it on the LAN too, since on a headless box it's the only config surface.
export function webuiBindAddr(): string {
  return (
    (typeof tjs !== 'undefined' ? tjs.env['DECKBRIDGE_BIND'] : undefined) ?? WEBUI_LISTEN_ADDRESS
  );
}

export interface KeyEvent {
  keyIndex: number;
  state: KeyState;
}

/** A rotary encoder event from a Stream Deck +-style device. `index` is the
 *  encoder (0..encoderCount-1); a turn's `delta` is +1 clockwise / -1 counter-clockwise. */
export type DialEvent =
  | { index: number; kind: 'press'; state: KeyState }
  | { index: number; kind: 'rotate'; delta: number };

/** A touch-strip event from a Stream Deck +-style device, in strip coordinates
 *  (0..touchWidth-1, 0..touchHeight-1). `endX`/`endY` are present for swipes. */
export interface TouchInputEvent {
  type: 'tap' | 'hold' | 'swipe';
  x: number;
  y: number;
  endX?: number;
  endY?: number;
}

/** A simulated non-grid input for the mock driver (POST /api/mock/*). */
export type MockInput =
  | { kind: 'extraKey'; wireId: number }
  | { kind: 'dial'; event: DialEvent }
  | { kind: 'touch'; event: TouchInputEvent };

/** A rectangular region of the Stream Deck + window (800×100) the app uploaded via
 *  the partial-window command. Absent = a full-window (0x0B) image. */
export interface TouchWindowRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ImageEvent {
  keyIndex: number;
  // Always a Buffer in practice (produced by Buffer.concat in image-assembler.ts);
  // typed as such so consumers can pass it on (WebUI cache, worker postMessage)
  // without a defensive re-copy. Holds JPEG (gen2) or BMP (gen1).
  data: Buffer;
  format: 'jpeg' | 'bmp';
}

export interface LogObject {
  level: 'debug' | 'info' | 'warn' | 'error';
  component: string;
  message: string;
}

// Extra-key widget config lives in extra-key-config.ts; re-exported for existing imports.
export * from './extra-key-config.js';

export const TOUCH_STRIP_MODES = [
  'elgato',
  'deckbridge-ignore',
  'deckbridge-repaint',
] as const satisfies readonly TouchStripMode[];

export const DEFAULT_TOUCH_STRIP_MODE: TouchStripMode = 'elgato';

/** How an Elgato strip zone (200 px) reaches a narrower slot window on a model with a
 *  full-strip surface. 'crop' = the strip pixels at the slot window, exactly what a
 *  full-strip upload shows there; 'scale' = the whole zone, fitted into the slot. */
export type TouchStripZoneFit = 'crop' | 'scale';
/** When a model with a full-strip surface gets one whole-strip upload instead of
 *  per-slot uploads: 'full-frames' = only for a whole-strip frame from the app;
 *  'always' = for every frame. Never while a zone is masked. */
export type TouchStripUpload = 'full-frames' | 'always';

export interface TouchStripOptions {
  zoneFit: TouchStripZoneFit;
  upload: TouchStripUpload;
}

export const TOUCH_STRIP_ZONE_FITS = ['crop', 'scale'] as const satisfies TouchStripZoneFit[];
export const TOUCH_STRIP_UPLOADS = ['full-frames', 'always'] as const satisfies TouchStripUpload[];
export const DEFAULT_TOUCH_STRIP_OPTIONS: Readonly<TouchStripOptions> = {
  zoneFit: 'crop',
  upload: 'full-frames',
};

/** 'deckbridge-repaint' hold-off: a widget returns to its strip zone this long after
 *  the Elgato app last drew there (the app's image shows in between). */
export const TOUCH_STRIP_REPAINT_DEFAULT_MS = 5000;
export const TOUCH_STRIP_REPAINT_MIN_MS = 1000;
export const TOUCH_STRIP_REPAINT_MAX_MS = 3_600_000;

export function isTouchStripRepaintMs(v: unknown): v is number {
  return (
    Number.isInteger(v) &&
    (v as number) >= TOUCH_STRIP_REPAINT_MIN_MS &&
    (v as number) <= TOUCH_STRIP_REPAINT_MAX_MS
  );
}

// Clear-and-null helpers. The guard-clear-forget-to-null sequence was written out
// at six teardown sites; assigning the return value makes forgetting impossible.
// Kept as two functions rather than one so neither relies on clearTimeout and
// clearInterval being interchangeable.

type TimerHandle = Parameters<typeof clearTimeout>[0];

/** `this.t = clearTimer(this.t)` for a setTimeout handle. */
export function clearTimer(timer: TimerHandle | null): null {
  if (timer !== null) clearTimeout(timer);
  return null;
}

/** `this.t = clearRepeating(this.t)` for a setInterval handle. */
export function clearRepeating(timer: TimerHandle | null): null {
  if (timer !== null) clearInterval(timer);
  return null;
}

// FNV-1a, 32-bit. Deterministic, no crypto needed — these hashes are stable
// identifiers and cache keys, never a security boundary.
export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** `fnv1a` as a fixed-width 8-char hex string — the cache-key / spec-revision form. */
export function fnv1aHex(text: string): string {
  return fnv1a(text).toString(16).padStart(8, '0');
}
