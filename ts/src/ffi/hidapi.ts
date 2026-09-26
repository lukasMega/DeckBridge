// tjs:ffi bindings for libhidapi.
import FFI from 'tjs:ffi';
import { debug, info, warn } from '../logger.js';
import { decodeNulTerminated, guardedCall, LIST_BUF_BYTES, TSV_ABSENT } from './native-load.js';

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
  /** `const wchar_t*` — decode with hidErrorString(), never interpolate directly. */
  hid_error(device: unknown): unknown;
  /** hidapi >= 0.14 only. Absent on older builds — always check before calling, or
   *  go through getReportDescriptor(). See tryLoad()'s two-stage dlopen. */
  hid_get_report_descriptor?(device: unknown, buf: Uint8Array, len: number): number;
}

const HID_ENUM = 'deckbridge-native';

/* prettier-ignore */
const HIDAPI_CORE_SYMBOLS = {
  hid_init:               { args: [],                            returns: INT     },
  hid_exit:               { args: [],                            returns: INT     },
  hid_open:               { args: [UINT16, UINT16, POINTER],     returns: POINTER },
  hid_open_path:          { args: [STRING],                      returns: POINTER },
  hid_write:              { args: [POINTER, BUFFER, SIZE_T],     returns: INT     },
  hid_read_timeout:       { args: [POINTER, BUFFER, SIZE_T, INT],returns: INT     },
  hid_send_feature_report:{ args: [POINTER, BUFFER, SIZE_T],     returns: INT     },
  hid_get_feature_report: { args: [POINTER, BUFFER, SIZE_T],     returns: INT     },
  hid_close:              { args: [POINTER],                     returns: 'void'  },
  hid_error:              { args: [POINTER],                     returns: POINTER },
};

/* prettier-ignore */
const HIDAPI_DESCRIPTOR_SYMBOL = {
  hid_get_report_descriptor: { args: [POINTER, BUFFER, SIZE_T],   returns: INT     },
};

function tryLoad(path: string): { symbols: HidapiSymbols; close(): void } {
  debug('ffi', `dlopen: trying ${path}`);

  // Two-stage: hid_get_report_descriptor only exists in hidapi >= 0.14, and dlopen
  // resolves every symbol up front — asking for it against an older lib would fail the
  // whole load and take the device offline. So try the richer map first and silently
  // fall back to the core one, leaving the optional symbol undefined.
  let lib: unknown;
  try {
    lib = FFI.dlopen(path, { ...HIDAPI_CORE_SYMBOLS, ...HIDAPI_DESCRIPTOR_SYMBOL });
    debug('ffi', `dlopen: loaded ${path} (with hid_get_report_descriptor)`);
  } catch {
    lib = FFI.dlopen(path, HIDAPI_CORE_SYMBOLS);
    debug('ffi', `dlopen: loaded ${path} (hidapi < 0.14 — no hid_get_report_descriptor)`);
  }
  return lib as { symbols: HidapiSymbols; close(): void };
}

/** Raw HID report descriptor for an open device, or null when hidapi is too old to
 *  expose it, the call fails, or the device returns nothing. Never throws — a device
 *  that won't describe itself is a fallback-to-defaults case, not an error. */
export function getReportDescriptor(
  hid: HidapiSymbols,
  device: unknown,
  maxBytes: number,
): Uint8Array | null {
  if (typeof hid.hid_get_report_descriptor !== 'function') return null;
  try {
    const buf = new Uint8Array(maxBytes);
    const n = hid.hid_get_report_descriptor(device, buf, buf.length);
    if (n <= 0) {
      debug('ffi', `hid_get_report_descriptor returned ${n}`);
      return null;
    }
    return buf.subarray(0, Math.min(n, buf.length));
  } catch (e) {
    warn('ffi', `hid_get_report_descriptor threw: ${String(e)}`);
    return null;
  }
}

interface HidEnumSymbols {
  mirabox_hid_list_all(buf: Uint8Array, bufLen: number): number;
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
      mirabox_hid_list_all: {
        args: [BUFFER, SIZE_T],
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

/** Lazy-load the enum lib and call into it. A missing lib or a throw degrades to
 *  `fallback`: enumeration is best-effort, never fatal to the caller. */
function hidEnumCall<T>(name: string, fallback: T, fn: (sym: HidEnumSymbols) => T): T {
  _hidEnumLib ??= loadHidEnum();
  const lib = _hidEnumLib;
  if (!lib) return fallback;
  return guardedCall(name, fallback, () => fn(lib.symbols));
}

// ---------------------------------------------------------------------------
// Enumeration snapshot
//
// Every VID/PID-filtered helper below used to run its OWN native enumeration, and
// each of those is a full hid_enumerate() over every HID interface on the machine.
// The presence sweep alone is one call per registry VID/PID pair (~26) every
// HID_POLL_INTERVAL_MS, on the main thread. On Windows hidapi's enumeration opens
// each interface to read its product/serial strings, so one hostile composite
// device (the "freeze when this keyboard is plugged in" report, issue #67.2) is
// multiplied by 26 into seconds of blocked event loop — no CORA ACKs, no WebUI.
//
// Operational discovery now installs a supported-only snapshot from a dedicated
// worker. Legacy CLI/diagnostic callers may still request a short-lived full snapshot.
// ---------------------------------------------------------------------------

/** Reuse window for one full enumeration. Shorter than HID_POLL_INTERVAL_MS (3 s) on
 *  purpose: one sweep = one enumeration, and no tick ever reuses the previous tick's. */
const SNAPSHOT_TTL_MS = 1_000;

/** Above this, one enumeration alone eats a visible slice of a 3 s tick — worth a
 *  warn line, since it is the first thing to look for in a freeze report. */
const SLOW_ENUMERATE_MS = 250;

let _snapshot: HidDeviceInfo[] = [];
let _snapshotAt = 0;

/** Cached full HID enumeration, refreshed when older than `maxAgeMs` (0 forces a
 *  fresh one). [] when deckbridge-native is unavailable or enumeration failed —
 *  callers (via hidSnapshotOrFresh) retry once, uncached, before matching. */
export function hidSnapshot(maxAgeMs = SNAPSHOT_TTL_MS): HidDeviceInfo[] {
  const now = Date.now();
  if (_snapshotAt !== 0 && now - _snapshotAt < maxAgeMs) return _snapshot;
  _snapshot = listAllHidDevices();
  _snapshotAt = Date.now();
  const took = _snapshotAt - now;
  const line = `hid enumerate took ${took}ms (${_snapshot.length} interfaces)`;
  if (took >= SLOW_ENUMERATE_MS) warn('ffi', line);
  else debug('ffi', line);
  return _snapshot;
}

/** Drop the cached enumeration so the next query re-enumerates (test seam; also the
 *  hook for a future hotplug notification). */
export function invalidateHidSnapshot(): void {
  _snapshotAt = 0;
  _snapshot = [];
}

/** One VID/PID/usage-page/usage filter for a HID query. `productIds` omitted
 *  matches any product ID; `usagePage`/`usage` omitted matches any value.
 *  Shared between every VID/PID-filtered helper below and hid-discovery.ts's
 *  `cachedDiscoveryPaths`, so there is exactly one place that knows how a
 *  device row is matched against a query — no per-query native fallback
 *  reimplements this. */
export interface HidQuery {
  vendorId: number;
  productIds?: readonly number[];
  usagePage?: number;
  usage?: number;
}

/** Pure — no FFI, just field comparisons against an already-enumerated row. */
export function matchesHidQuery(d: HidDeviceInfo, q: HidQuery): boolean {
  return (
    d.vendorId === q.vendorId &&
    (q.productIds === undefined || q.productIds.includes(d.productId)) &&
    (q.usagePage === undefined || d.usagePage === q.usagePage) &&
    (q.usage === undefined || d.usage === q.usage)
  );
}

/** Every path in `devices` matching `q`, de-duplicated. Pure. */
export function hidPathsMatching(devices: readonly HidDeviceInfo[], q: HidQuery): string[] {
  return [...new Set(devices.filter((d) => matchesHidQuery(d, q)).map((d) => d.path))];
}

function singlePidQuery(
  vendorId: number,
  pid: number,
  usagePage?: number,
  usage?: number,
): HidQuery {
  return { vendorId, productIds: pid === 0 ? undefined : [pid], usagePage, usage };
}

/** The cached snapshot, or — when it's empty (enum lib unavailable, or nothing
 *  was connected at the last sweep) — a same-tick fresh enumeration. This is
 *  the one native re-check every VID/PID-filtered helper below falls back to:
 *  no separate per-query native entry point, just an uncached call to the
 *  same full enumeration `listAllHidDevices()` already uses. */
function hidSnapshotOrFresh(): HidDeviceInfo[] {
  const snap = hidSnapshot();
  return snap.length > 0 ? snap : hidSnapshot(0);
}

export function findHidPath(vid: number, usagePage: number, usage: number, pid = 0): string | null {
  debug(
    'ffi',
    `findHidPath: vid=0x${vid.toString(16)} pid=0x${pid.toString(16)} usagePage=0x${usagePage.toString(16)} usage=0x${usage.toString(16)}`,
  );
  const hit = hidSnapshotOrFresh().find((d) =>
    matchesHidQuery(d, singlePidQuery(vid, pid, usagePage, usage)),
  );
  debug('ffi', hit ? `hid snapshot: found path=${hit.path}` : 'hid snapshot: no device found');
  return hit?.path ?? null;
}

/** Every HID device path matching this VID+usagePage+usage (+optional PID),
 *  from deckbridge-native enumeration (never hid_open). Used to drive N units of
 *  the SAME model as separate docks: the coordinator opens each distinct path via
 *  hid_open_path. Returns [] when the enum lib is missing or nothing matches.
 *  Param order mirrors findHidPath. */
export function listHidPaths(vid: number, usagePage: number, usage: number, pid = 0): string[] {
  return hidPathsMatching(hidSnapshotOrFresh(), singlePidQuery(vid, pid, usagePage, usage));
}

/** True if a HID device with this VID+PID is connected, via deckbridge-native
 *  enumeration (never hid_open). Used by the host's probe to pick the connected
 *  model before spawning a worker — so we never hid_open an absent device or
 *  load hidapi in a throwaway worker, both of which segfault on macOS. Returns
 *  false (no device) when deckbridge-native is unavailable. */
export function hidDevicePresent(vid: number, pid: number): boolean {
  return hidSnapshotOrFresh().some((d) => matchesHidQuery(d, singlePidQuery(vid, pid)));
}

/** USB serial-number string of the device at `hidPath` (from deckbridge-native
 *  enumeration, never hid_open), or null when unavailable — no match, empty
 *  serial, or the enum lib is missing. Used to build a stable per-device key
 *  (VID:PID:serial) that survives reboot/replug, unlike the IOKit path. */
export function hidSerialForPath(hidPath: string): string | null {
  // A row exists but carries no serial: that is an answer (null), not a reason
  // to re-enumerate — a fresh sweep would report the same.
  const hit = hidSnapshotOrFresh().find((d) => d.path === hidPath);
  return hit?.serial && hit.serial !== TSV_ABSENT ? hit.serial : null;
}

/** One row of the unfiltered HID enumeration (see listAllHidDevices). */
export interface HidDeviceInfo {
  vendorId: number;
  productId: number;
  usagePage: number;
  usage: number;
  interfaceNumber: number;
  manufacturer: string;
  product: string;
  serial: string;
  path: string;
}

function parseHidRow(line: string): HidDeviceInfo | null {
  const f = line.split('\t');
  if (f.length !== 9) return null;
  return {
    vendorId: parseInt(f[0]!, 16),
    productId: parseInt(f[1]!, 16),
    usagePage: parseInt(f[2]!, 16),
    usage: parseInt(f[3]!, 16),
    interfaceNumber: Number(f[4]),
    manufacturer: f[5]!,
    product: f[6]!,
    serial: f[7]!,
    path: f[8]!,
  };
}

/** Rows of the NUL-terminated TSV block a native enumeration writes into `buf`. */
export function parseHidRows(buf: Uint8Array): HidDeviceInfo[] {
  return decodeNulTerminated(buf)
    .split('\n')
    .map(parseHidRow)
    .filter((d): d is HidDeviceInfo => d !== null);
}

/** Full diagnostic enumeration plus duration. A four-figure `tookMs` identifies
 * the hostile HID stack behavior which operational supported-only scans avoid. */
export function listAllHidDevicesTimed(): { devices: HidDeviceInfo[]; tookMs: number } {
  const t0 = Date.now();
  const devices = listAllHidDevices();
  return { devices, tookMs: Date.now() - t0 };
}

/** EVERY connected HID interface — no VID/PID filter, enumeration only (never
 *  hid_open). The diagnostics bundle uses this to show the devices DeckBridge
 *  does *not* recognize; a VID/PID-filtered call by definition cannot. Returns
 *  [] when deckbridge-native is unavailable. */
export function listAllHidDevices(): HidDeviceInfo[] {
  return hidEnumCall<HidDeviceInfo[]>('mirabox_hid_list_all', [], (sym) => {
    const buf = new Uint8Array(LIST_BUF_BYTES);
    const count = sym.mirabox_hid_list_all(buf, buf.length);
    return count <= 0 ? [] : parseHidRows(buf);
  });
}

export function getHidapiSystemCandidates(): string[] {
  if (FFI.suffix === 'dylib') {
    return ['/opt/homebrew/lib/libhidapi.dylib', '/usr/local/lib/libhidapi.dylib'];
  }
  if (FFI.suffix === 'dll') {
    // Stock Windows ships no system hidapi.dll — the embedded-extract path
    // (HIDAPI_LIB, set at boot from the bundle) is what actually loads it. These
    // are last-resort candidates: next to the running executable (packaging may
    // drop hidapi.dll there), then a bare name (DLL search path / PATH lookup).
    const exePath = typeof tjs !== 'undefined' ? tjs.exePath : '';
    const lastSep = Math.max(exePath.lastIndexOf('/'), exePath.lastIndexOf('\\'));
    const exeDir = lastSep >= 0 ? exePath.slice(0, lastSep + 1) : '';
    return exeDir ? [`${exeDir}hidapi.dll`, 'hidapi.dll'] : ['hidapi.dll'];
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
