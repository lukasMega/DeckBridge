/** `deckbridge devices` subcommand: lists detected stream-deck HID devices, then
 *  the caller exits. Enumeration only — listHidPaths/hidDevicePresent match against
 *  a deckbridge-native enumeration snapshot, never hid_open (macOS SIGBUS on a
 *  bad trial-open; see driver-manager.ts's defaultPresenceCheck for the same rule). */
import { setupNativeLibs } from '../infra/native-libs.js';
import {
  hidDevicePresent,
  hidPathsMatching,
  hidSerialForPath,
  listHidPaths,
  matchesHidQuery,
  type HidDeviceInfo,
} from '../ffi/hidapi.js';
import { TSV_ABSENT } from '../ffi/native-load.js';
import { DEVICE_MODELS, findModel } from '../devices/registry.js';
import { platformName } from '../infra/os-utils.js';

export interface EnumeratedDevice {
  vendorId: number;
  productId: number;
  serial: string | null;
  path: string | null;
}

export interface DeviceRow {
  model: string;
  vidPid: string;
  serial: string;
  path: string;
  supported: string;
}

interface DeviceLookup {
  paths(vid: number, usagePage: number, usage: number, pid: number): string[];
  serial(path: string): string | null;
  present(vid: number, pid: number): boolean;
}

function collectEnumerated(lookup: DeviceLookup): EnumeratedDevice[] {
  const found: EnumeratedDevice[] = [];
  for (const model of DEVICE_MODELS) {
    const { usbVendorId: vendorId, usagePage, usage } = model;
    for (const productId of model.usbProductIds) {
      if (usagePage !== undefined && usage !== undefined) {
        for (const path of lookup.paths(vendorId, usagePage, usage, productId)) {
          found.push({ vendorId, productId, path, serial: lookup.serial(path) });
        }
      } else if (lookup.present(vendorId, productId)) {
        found.push({ vendorId, productId, path: null, serial: null });
      }
    }
  }
  return found;
}

/** Every HID interface matching a known model's VID+PID, via deckbridge-native
 *  enumeration. Mirabox models (usagePage+usage set) yield one row per physical
 *  path + its serial; Elgato models have no safe path-enumeration primitive (only
 *  hid_open by VID/PID, which this command must never do) so they yield presence
 *  only — path/serial come back null. Sync FFI: CLI only, never a running server. */
export function enumerateDevices(): EnumeratedDevice[] {
  return collectEnumerated({
    paths: listHidPaths,
    serial: hidSerialForPath,
    present: hidDevicePresent,
  });
}

/** Pure twin of `enumerateDevices` over an already-fetched inventory (the WebUI gets
 *  one from the scan worker), so the server never calls the sync enumerators. */
export function deviceRowsFromInventory(devices: readonly HidDeviceInfo[]): DeviceRow[] {
  return collectEnumerated({
    paths: (vendorId, usagePage, usage, productId) =>
      hidPathsMatching(devices, { vendorId, productIds: [productId], usagePage, usage }),
    serial: (path) => {
      const hit = devices.find((d) => d.path === path);
      return hit?.serial && hit.serial !== TSV_ABSENT ? hit.serial : null;
    },
    present: (vendorId, productId) =>
      devices.some((d) => matchesHidQuery(d, { vendorId, productIds: [productId] })),
  }).map(toDeviceRow);
}

function hex4(n: number): string {
  return n.toString(16).padStart(4, '0');
}

/** Pure — maps one enumerated device to its display row (registry match + string
 *  formatting), independent of the FFI enumeration so it's unit-testable. */
export function toDeviceRow(dev: EnumeratedDevice): DeviceRow {
  const model = findModel(dev.vendorId, dev.productId);
  return {
    model: model?.name ?? 'unknown',
    vidPid: `${hex4(dev.vendorId)}:${hex4(dev.productId)}`,
    serial: dev.serial ?? '-',
    path: dev.path ?? '-',
    supported: model !== null ? 'yes' : 'no',
  };
}

const COLUMNS: ReadonlyArray<{ key: keyof DeviceRow; header: string }> = [
  { key: 'model', header: 'MODEL' },
  { key: 'vidPid', header: 'VID:PID' },
  { key: 'serial', header: 'SERIAL' },
  { key: 'path', header: 'PATH' },
  { key: 'supported', header: 'SUPPORTED' },
];

/** Pure text-table formatter. Returns "no devices found" for an empty list. */
export function formatDeviceTable(rows: readonly DeviceRow[]): string {
  if (rows.length === 0) return 'no devices found';
  const widths = COLUMNS.map((c) => Math.max(c.header.length, ...rows.map((r) => r[c.key].length)));
  const line = (cells: readonly string[]): string =>
    cells
      .map((c, i) => c.padEnd(widths[i]!))
      .join('  ')
      .trimEnd();
  return [
    line(COLUMNS.map((c) => c.header)),
    ...rows.map((r) => line(COLUMNS.map((c) => r[c.key]))),
  ].join('\n');
}

// Elgato desktop app hardcodes MAC_OS/WIN as the only platforms platformName()
// reliably identifies (see os-utils.ts); anything else (Linux, unknown) is where
// hidraw permissions are actually a thing worth hinting about.
const [MAC_OS, WIN] = ['macOS', 'Windows'];

const PERMISSION_HINT =
  'hint: no devices detected — on Linux, check hidraw udev rules ' +
  '(packaging/linux/99-deckbridge.rules) and group membership.';

export async function runDevicesCommand(): Promise<void> {
  await setupNativeLibs();
  const rows = enumerateDevices().map(toDeviceRow);
  console.log(formatDeviceTable(rows));
  const platform = platformName();
  if (rows.length === 0 && platform !== MAC_OS && platform !== WIN) {
    console.log(PERMISSION_HINT);
  }
}
