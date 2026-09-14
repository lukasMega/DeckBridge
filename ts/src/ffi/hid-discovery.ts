/** Supported-device discovery used by the dedicated scan worker. Full HID
 * inventory remains in hidapi.ts for explicit diagnostics only. */
import FFI from 'tjs:ffi';
import { debug, warn } from '../logger.js';
import { BUFFER, INT, SIZE_T, STRING, parseHidRow, type HidDeviceInfo } from './hidapi.js';

interface DiscoverySymbols {
  mirabox_hid_list_supported(filterSpec: string, buf: Uint8Array, bufLen: number): number;
}

const LIST_BUF_BYTES = 512 * 1024;
const TSV_ABSENT = '-';
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
  const paths = snapshot
    .filter(
      (d) =>
        d.vendorId === vendorId &&
        productIds.includes(d.productId) &&
        (usagePage === undefined || d.usagePage === usagePage) &&
        (usage === undefined || d.usage === usage),
    )
    .map((d) => d.path);
  return [...new Set(paths)];
}

export function scanSupportedHidDevicesTimed(
  pairs: readonly { vendorId: number; productId: number }[],
): { devices: HidDeviceInfo[]; tookMs: number } {
  const t0 = Date.now();
  lib ??= loadDiscovery();
  if (!lib) return { devices: [], tookMs: Date.now() - t0 };
  const filterSpec = [
    ...new Set(
      pairs.map(
        ({ vendorId, productId }) =>
          `${vendorId.toString(16).padStart(4, '0')}:${productId.toString(16).padStart(4, '0')}`,
      ),
    ),
  ].join(',');
  try {
    const buf = new Uint8Array(LIST_BUF_BYTES);
    const count = lib.symbols.mirabox_hid_list_supported(filterSpec, buf, buf.length);
    if (count <= 0) return { devices: [], tookMs: Date.now() - t0 };
    const end = buf.indexOf(0);
    const text = new TextDecoder().decode(buf.subarray(0, end >= 0 ? end : buf.length));
    const devices = text
      .split('\n')
      .map(parseHidRow)
      .filter((d): d is HidDeviceInfo => d !== null);
    return { devices, tookMs: Date.now() - t0 };
  } catch (e) {
    warn('ffi', `mirabox_hid_list_supported threw: ${String(e)}`);
    return { devices: [], tookMs: Date.now() - t0 };
  }
}
