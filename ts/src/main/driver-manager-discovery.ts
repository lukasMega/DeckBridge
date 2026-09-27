// USB discovery for DriverManager: one worker-side scan per sweep installs a
// snapshot, then every per-model query reads it (never enumerates itself).
import type { DeviceModel } from '../devices/driver.js';
import { DEVICE_MODELS } from '../devices/registry.js';
import {
  cachedDiscoveryPaths,
  cachedDiscoverySerial,
  installDiscoverySnapshot,
} from '../ffi/hid-discovery.js';
import { deviceKeyFor, sharedSerialModelId } from '../infra/device-identity.js';
import { HidScanWorkerHost } from '../worker/hid-scan-worker-host.js';
import { log } from '../shared/logger.js';

export interface HidDiscovery {
  /** One supported-device scan; installs the snapshot the queries read. Resolves to its ms. */
  scan(): Promise<number>;
  /** Presence by enumeration, never a trial hid_open (segfaults on macOS). */
  present(model: DeviceModel): boolean;
  /** Every usage-matched HID path for this model, one per physical unit. */
  paths(model: DeviceModel): string[];
  serial(hidPath: string): string | null;
  /** Re-init the native HID stack before the next scan (after a disconnect). */
  requestReset(): void;
  /** Skip a model with no usage-matched path instead of opening by VID/PID. */
  readonly requireTargetedPath: boolean;
}

/** Production discovery: the process-lifetime scan worker, so a stalled Windows
 *  HID call never blocks CORA/WebUI. */
export function nativeHidDiscovery(): HidDiscovery {
  const scanner = new HidScanWorkerHost();
  return {
    async scan(): Promise<number> {
      try {
        const result = await scanner.scan();
        installDiscoverySnapshot(result.devices);
        return result.tookMs;
      } catch (e) {
        installDiscoverySnapshot([]);
        log('error', 'hid', `discovery worker failed: ${(e as Error).message}`);
        return 0;
      }
    },
    present: (model) => cachedDiscoveryPaths(model.usbVendorId, model.usbProductIds).length > 0,
    paths: (model) =>
      cachedDiscoveryPaths(model.usbVendorId, model.usbProductIds, model.usagePage, model.usage),
    serial: cachedDiscoverySerial,
    requestReset: () => scanner.requestReset(),
    requireTargetedPath: true,
  };
}

/** Identity of a just-opened primary device: stable USB-serial key, else the
 *  (volatile) hidPath, else a per-model key (VID/PID-fallback open, no
 *  usage-matched path) — same rule as the extra-session path. */
export function resolveRealDeviceIdentity(
  discovery: HidDiscovery,
  hidPath: string | undefined,
  model: DeviceModel,
): { deviceKey: string; serial: string | null } {
  const serial = hidPath ? discovery.serial(hidPath) : null;
  return {
    deviceKey: deviceKeyFor(hidPath ?? `model:${model.id}`, serial, sharedSerialModelId(model)),
    serial,
  };
}

/** Any Elgato-branded model enumerated on USB — gates the "Elgato app is blocking
 *  access" screen so it can't fire without Elgato hardware present. */
export function elgatoHardwarePresent(discovery: HidDiscovery): boolean {
  return DEVICE_MODELS.some(
    (model) => model.driverKind === 'elgato-hid' && discovery.present(model),
  );
}
