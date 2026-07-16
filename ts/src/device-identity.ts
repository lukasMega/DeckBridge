// Deterministic per-physical-device identity: MAC address + dock/child serial
// suffix, keyed by a stable device key so the SAME physical unit gets the SAME
// identity across restarts/replugs instead of whatever session slot it lands
// in. See .claude/plans/2026-07-14_per-device-identity.md for the design
// rationale (why HID path, not session index).
//
// Pure module, no I/O: WebUIServer owns settings.json persistence and calls
// getOrCreateDeviceIdentity() as a reducer over its in-memory devices array.
import { DEFAULT_DOCK_SERIAL_NUMBER, DEFAULT_CHILD_SERIAL_NUMBER } from './types.js';
import type { DeviceIdentitySettings } from './settings-store.js';

/** Prefix marking a deviceKey built from a stable USB serial (vs. a volatile
 *  IOKit-path fallback key). Entries without this prefix are ephemeral and get
 *  pruned on settings load — they can't reliably re-match the same unit. */
export const SERIAL_KEY_PREFIX = 'usb:';

/** True when `deviceKey` is serial-based and therefore stable across
 *  reboot/replug — the only keys worth persisting in settings.json. */
export function isStableDeviceKey(deviceKey: string): boolean {
  return deviceKey.startsWith(SERIAL_KEY_PREFIX);
}

/** The key identifying "the same physical device" across restarts. Preferred:
 *  the device's USB `serial` (`usb:<serial>`) — stable across reboot, replug,
 *  and port changes. Fallback: the HID path, used only when no serial is
 *  available (off-macOS VID/PID-fallback open, or a device that reports no
 *  serial). Path keys are NOT stable — the macOS IOKit path
 *  (`DevSrvsID:<entryID>`) changes whenever the OS re-enumerates the device, so
 *  path-keyed entries are treated as ephemeral (see isStableDeviceKey). */
export function deviceKeyFor(hidPath: string, serial?: string | null): string {
  return serial ? `${SERIAL_KEY_PREFIX}${serial}` : hidPath;
}

// FNV-1a, 32-bit. Deterministic, no crypto needed — this generates a stable
// identifier, not a security boundary.
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** `n` deterministic bytes derived from `deviceKey`. Salts the hash input per
 *  4-byte round so `n` can exceed 4 without repeating bytes. */
function hashBytes(deviceKey: string, n: number): number[] {
  const bytes: number[] = [];
  let round = 0;
  while (bytes.length < n) {
    const h = fnv1a(`${deviceKey}#${round}`);
    bytes.push((h >>> 24) & 0xff, (h >>> 16) & 0xff, (h >>> 8) & 0xff, h & 0xff);
    round++;
  }
  return bytes.slice(0, n);
}

/** Deterministic MAC for `deviceKey`. Keeps the locally-administered `02:`
 *  prefix (matches DEFAULT_MAC_ADDRESS_STRING) so it can never collide with a
 *  real vendor MAC. */
export function generateMacAddress(deviceKey: string): string {
  const bytes = hashBytes(deviceKey, 5);
  return ['02', ...bytes.map((b) => b.toString(16).padStart(2, '0'))].join(':');
}

/** Same substitution point as the old session-index scheme (chars 10-11 of
 *  the default serial) — MUST stay inside the first 12 chars: the Elgato app
 *  keys devices by serial.substring(0,12) (see device-session.ts). Two
 *  hash-derived base-36 chars replace the zero-padded session index — base-36
 *  (1296 slots) rather than 2 decimal digits (100 slots) meaningfully cuts
 *  the birthday-collision odds across several physical devices; the serial
 *  already mixes letters and digits elsewhere (e.g. DEFAULT_DOCK_SERIAL_NUMBER
 *  itself), so an alphanumeric suffix is no less valid to the Elgato app. */
export function generateSerial(template: string, deviceKey: string): string {
  const suffix = (fnv1a(deviceKey) % 1296).toString(36).padStart(2, '0');
  return `${template.slice(0, 10)}${suffix}${template.slice(12)}`;
}

/** Fresh identity for a device key that hasn't been seen before. Pure —
 *  callers append the result to their persisted devices array. */
export function generateDeviceIdentity(
  deviceKey: string,
  defaultMdnsName: string,
): DeviceIdentitySettings {
  return {
    deviceKey,
    mdnsServiceName: defaultMdnsName,
    macAddress: generateMacAddress(deviceKey),
    dockSerial: generateSerial(DEFAULT_DOCK_SERIAL_NUMBER, deviceKey),
    childSerial: generateSerial(DEFAULT_CHILD_SERIAL_NUMBER, deviceKey),
  };
}

/** Look up `deviceKey` in `devices`; if absent, generate + append a fresh
 *  identity. Pure: returns the (possibly unchanged) array plus the identity
 *  and whether a new entry was created — the caller persists on `created`. */
export function getOrCreateDeviceIdentity(
  deviceKey: string,
  defaultMdnsName: string,
  devices: DeviceIdentitySettings[],
): { identity: DeviceIdentitySettings; devices: DeviceIdentitySettings[]; created: boolean } {
  const found = devices.find((d) => d.deviceKey === deviceKey);
  if (found) return { identity: found, devices, created: false };
  const identity = generateDeviceIdentity(deviceKey, defaultMdnsName);
  return { identity, devices: [...devices, identity], created: true };
}
