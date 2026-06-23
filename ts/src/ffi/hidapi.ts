// tjs:ffi bindings for libhidapi.
import FFI from 'tjs:ffi';
import { debug, info, warn } from '../logger.js';

export const POINTER = 'pointer';
export const STRING = 'string';
export const BUFFER = 'buffer';
export const SIZE_T = 'size_t';
export const INT = 'int';
export const UINT16 = 'uint16';
export const UINT32 = 'uint32';

/** macOS uses the .dylib suffix. Gates the hid_open(VID/PID) fallback, which on
 *  macOS opens the device's first IOKit interface (often a keyboard/consumer
 *  collection) and SIGBUSes the whole process on a permission-denied open.
 *  See MiraboxDriver.open(). */
export const IS_MACOS = FFI.suffix === 'dylib';

export function isNullPtr(p: unknown): boolean {
  if (p == null) return true;
  try {
    return (p as { equals(x: null): boolean }).equals(null);
  } catch {
    return false;
  }
}

export interface HidapiSymbols {
  hid_init(): number;
  hid_exit(): number;
  hid_open(vid: number, pid: number, serial: null): unknown;
  hid_open_path(path: string): unknown;
  hid_write(device: unknown, buf: Uint8Array, len: number): number;
  hid_read_timeout(device: unknown, buf: Uint8Array, len: number, timeoutMs: number): number;
  hid_send_feature_report(device: unknown, buf: Uint8Array, len: number): number;
  hid_get_feature_report(device: unknown, buf: Uint8Array, len: number): number;
  hid_close(device: unknown): void;
  hid_error(device: unknown): string | null;
}

const HID_ENUM = 'deckbridge-native';

function tryLoad(path: string): { symbols: HidapiSymbols; close(): void } {
  debug('ffi', `dlopen: trying ${path}`);

  /* prettier-ignore */
  const lib = FFI.dlopen(path, {
    hid_init:               { args: [],                            returns: INT     },
    hid_exit:               { args: [],                            returns: INT     },
    hid_open:               { args: [UINT16, UINT16, POINTER],     returns: POINTER },
    hid_open_path:          { args: [STRING],                      returns: POINTER },
    hid_write:              { args: [POINTER, BUFFER, SIZE_T],     returns: INT     },
    hid_read_timeout:       { args: [POINTER, BUFFER, SIZE_T, INT],returns: INT     },
    hid_send_feature_report:{ args: [POINTER, BUFFER, SIZE_T],     returns: INT     },
    hid_get_feature_report: { args: [POINTER, BUFFER, SIZE_T],     returns: INT     },
    hid_close:              { args: [POINTER],                     returns: 'void'  },
    hid_error:              { args: [POINTER],                     returns: STRING  },
  });
  debug('ffi', `dlopen: loaded ${path}`);
  return lib as unknown as { symbols: HidapiSymbols; close(): void };
}

interface HidEnumSymbols {
  mirabox_hid_find_path(
    vid: number,
    pid: number,
    usagePage: number,
    usage: number,
    buf: Uint8Array,
    bufLen: number,
  ): number;
  mirabox_hid_present(vid: number, pid: number): number;
}

// Cached deckbridge-native handle, kept open for the process lifetime: dlclose() churn
// around HID libs causes SIGBUS on macOS (see _workerHidLib in mirabox.ts). Only
// successful loads are cached, so a missing/failed DECKBRIDGE_NATIVE_LIB can be retried later.
let _hidEnumLib: { symbols: HidEnumSymbols; close(): void } | null = null;

function loadHidEnum(): { symbols: HidEnumSymbols; close(): void } | null {
  const path = (typeof tjs !== 'undefined' ? tjs.env['DECKBRIDGE_NATIVE_LIB'] : undefined) ?? '';
  if (!path) {
    debug('ffi', `DECKBRIDGE_NATIVE_LIB not set - skipping ${HID_ENUM} hid enum`);
    return null;
  }
  debug('ffi', `loading ${HID_ENUM} hid enum: ${path}`);
  try {
    const lib = FFI.dlopen(path, {
      mirabox_hid_find_path: {
        args: [UINT16, UINT16, UINT16, UINT16, BUFFER, SIZE_T],
        returns: INT,
      },
      mirabox_hid_present: {
        args: [UINT16, UINT16],
        returns: INT,
      },
    }) as unknown as { symbols: HidEnumSymbols; close(): void };
    debug('ffi', `${HID_ENUM} hid enum loaded`);
    return lib;
  } catch (e) {
    warn('ffi', `deckbridge-native hid enum load failed: ${String(e)}`);
    return null;
  }
}

export function findHidPath(vid: number, usagePage: number, usage: number, pid = 0): string | null {
  debug(
    'ffi',
    `findHidPath: vid=0x${vid.toString(16)} pid=0x${pid.toString(16)} usagePage=0x${usagePage.toString(16)} usage=0x${usage.toString(16)}`,
  );
  _hidEnumLib ??= loadHidEnum();
  const lib = _hidEnumLib;
  if (!lib) return null;
  try {
    const buf = new Uint8Array(512);
    const found = lib.symbols.mirabox_hid_find_path(vid, pid, usagePage, usage, buf, buf.length);
    if (!found) {
      debug('ffi', 'mirabox_hid_find_path: no device found');
      return null;
    }
    const end = buf.indexOf(0);
    const path = new TextDecoder().decode(buf.subarray(0, end >= 0 ? end : buf.length));
    debug('ffi', `mirabox_hid_find_path: found path=${path}`);
    return path;
  } catch (e) {
    warn('ffi', `mirabox_hid_find_path threw: ${String(e)}`);
    return null;
  }
}

/** True if a HID device with this VID+PID is connected, via deckbridge-native
 *  enumeration (never hid_open). Used by the host's probe to pick the connected
 *  model before spawning a worker — so we never hid_open an absent device or
 *  load hidapi in a throwaway worker, both of which segfault on macOS. Returns
 *  false (no device) when deckbridge-native is unavailable. */
export function hidDevicePresent(vid: number, pid: number): boolean {
  _hidEnumLib ??= loadHidEnum();
  const lib = _hidEnumLib;
  if (!lib) return false;
  try {
    return lib.symbols.mirabox_hid_present(vid, pid) === 1;
  } catch (e) {
    warn('ffi', `mirabox_hid_present threw: ${String(e)}`);
    return false;
  }
}

export function getHidapiSystemCandidates(): string[] {
  if (FFI.suffix === 'dylib') {
    return ['/opt/homebrew/lib/libhidapi.dylib', '/usr/local/lib/libhidapi.dylib'];
  }
  if (FFI.suffix === 'dll') {
    return ['hidapi.dll', 'C:\\Windows\\System32\\hidapi.dll'];
  }
  return ['/usr/lib/x86_64-linux-gnu/libhidapi-hidraw.so.0', '/usr/lib/libhidapi-hidraw.so.0'];
}

export function loadHidapi(): { symbols: HidapiSymbols; close(): void } {
  const bundled = (typeof tjs !== 'undefined' ? tjs.env['HIDAPI_LIB'] : undefined) ?? '';
  let systemCandidates: string[];
  if (FFI.suffix === 'dylib') {
    systemCandidates = [...getHidapiSystemCandidates(), `libhidapi.${FFI.suffix}`];
  } else if (FFI.suffix === 'dll') {
    systemCandidates = getHidapiSystemCandidates();
  } else {
    systemCandidates = [
      ...getHidapiSystemCandidates(),
      `libhidapi-hidraw.${FFI.suffix}.0`,
      `libhidapi.${FFI.suffix}`,
    ];
  }
  const candidates = bundled ? [bundled, ...systemCandidates] : systemCandidates;

  debug('ffi', `loadHidapi: candidates=[${candidates.join(', ')}]`);
  let last: unknown;
  for (const path of candidates) {
    try {
      const lib = tryLoad(path);
      const initRet = lib.symbols.hid_init();
      debug('ffi', `hid_init() → ${initRet} (0=ok)`);
      info('ffi', `loadHidapi: using ${path}${path === bundled ? ' (bundled)' : ''}`);
      return lib;
    } catch (e) {
      debug('ffi', `dlopen failed for ${path}: ${String(e)}`);
      last = e;
    }
  }
  throw new Error(
    `hidapi not found (tried: ${candidates.join(', ')}). ` +
      `Install with: brew install hidapi (macOS) | sudo apt install libhidapi-dev (Linux)\n` +
      String(last),
  );
}
