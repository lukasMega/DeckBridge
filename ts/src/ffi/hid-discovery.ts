/** Supported-device discovery used by the dedicated scan worker. Full HID
 * inventory remains in hidapi.ts for explicit diagnostics only. */
import FFI from 'tjs:ffi';
import { debug, warn } from '../logger.js';
import {
  BUFFER,
  INT,
  SIZE_T,
  STRING,
  hidPathsMatching,
  parseHidRows,
  type HidDeviceInfo,
} from './hidapi.js';
import { guardedCall, LIST_BUF_BYTES, TSV_ABSENT } from './native-load.js';

interface DiscoverySymbols {
  mirabox_hid_list_supported(filterSpec: string, buf: Uint8Array, bufLen: number): number;
  mirabox_hid_reset(): number;
}

let lib: { symbols: DiscoverySymbols; close(): void } | null = null;
let snapshot: HidDeviceInfo[] = [];

function loadDiscovery(): typeof lib {
  const path = (typeof tjs !== 'undefined' ? tjs.env['DECKBRIDGE_NATIVE_LIB'] : undefined) ?? '';
  if (!path) return null;
  try {
    const loaded = FFI.dlopen(path, {
      mirabox_hid_list_supported: {
        args: [STRING, BUFFER, SIZE_T],
        returns: INT,
      },
      mirabox_hid_reset: {
        args: [],
        returns: INT,
      },
    }) as unknown as { symbols: DiscoverySymbols; close(): void };
    debug('ffi', `supported HID discovery loaded: ${path}`);
    return loaded;
  } catch (e) {
    warn('ffi', `supported HID discovery load failed: ${String(e)}`);
    return null;
  }
}

export function installDiscoverySnapshot(devices: HidDeviceInfo[]): void {
  snapshot = devices;
}

export function cachedDiscoverySerial(hidPath: string): string | null {
  const hit = snapshot.find((d) => d.path === hidPath);
  return hit?.serial && hit.serial !== TSV_ABSENT ? hit.serial : null;
}

export function cachedDiscoveryPaths(
  vendorId: number,
  productIds: readonly number[],
  usagePage?: number,
  usage?: number,
): string[] {
  return hidPathsMatching(snapshot, { vendorId, productIds, usagePage, usage });
}

/** Drop the native library's cached HidApi so the next scan re-runs hid_init.
 * Must be called on the same thread that scans (the discovery worker): on macOS the
 * fresh IOHIDManager is scheduled on the calling thread's run loop. Without this, a
 * device unplugged after a successful open can stay invisible to enumeration for the
 * rest of the process lifetime. */
export function resetHidDiscovery(): boolean {
  lib ??= loadDiscovery();
  const l = lib;
  if (!l) return false;
  return guardedCall('mirabox_hid_reset', false, () => l.symbols.mirabox_hid_reset() === 1);
}

export function scanSupportedHidDevicesTimed(
  pairs: readonly { vendorId: number; productId: number }[],
): { devices: HidDeviceInfo[]; tookMs: number } {
  const t0 = Date.now();
  lib ??= loadDiscovery();
  const l = lib;
  if (!l) return { devices: [], tookMs: Date.now() - t0 };
  const filterSpec = [
    ...new Set(
      pairs.map(
        ({ vendorId, productId }) =>
          `${vendorId.toString(16).padStart(4, '0')}:${productId.toString(16).padStart(4, '0')}`,
      ),
    ),
  ].join(',');
  const devices = guardedCall<HidDeviceInfo[]>('mirabox_hid_list_supported', [], () => {
    const buf = new Uint8Array(LIST_BUF_BYTES);
    const count = l.symbols.mirabox_hid_list_supported(filterSpec, buf, buf.length);
    return count <= 0 ? [] : parseHidRows(buf);
  });
  return { devices, tookMs: Date.now() - t0 };
}
