import { loadSettings, saveSettings, settingsPath } from '../../settings-store.js';
import type { Settings, DeviceIdentitySettings } from '../../settings-store.js';
import { openPathInOS } from '../../os-utils.ts';
import {
  getOrCreateDeviceIdentity as getOrCreateDeviceIdentityPure,
  isStableDeviceKey,
} from '../../device-identity.js';
import { isExtraKeyConfig } from '../../types.js';
import type { DockStatus, ExtraKeyConfig } from '../../types.js';

const IMAGE_MODE_SETTINGS = [null, 'resize', 'pad-black', 'pad-average', 'pad-edge'];

/** Shape guard for a persisted/imported extraKeys map (wire id → config). */
function isExtraKeysRecord(v: unknown): v is Record<string, ExtraKeyConfig> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  return Object.values(v).every(isExtraKeyConfig);
}

/** Migration (2026-07-16, action→widget model): strip a stale/corrupt extraKeys
 *  map so it can't fail isDeviceIdentitySettings and drop the whole identity
 *  entry — that would regenerate MAC/serial and force an Elgato re-pair. */
function stripInvalidExtraKeys(d: unknown): void {
  if (typeof d !== 'object' || d === null) return;
  const r = d as Record<string, unknown>;
  if (r.extraKeys !== undefined && !isExtraKeysRecord(r.extraKeys)) delete r.extraKeys;
}

/** The optional per-device settings half of isDeviceIdentitySettings. */
function hasValidDeviceSettings(r: Record<string, unknown>): boolean {
  return (
    (r.brightness === undefined || typeof r.brightness === 'number') &&
    (r.brightnessOverride === undefined || typeof r.brightnessOverride === 'boolean') &&
    (r.imageModeOverride === undefined ||
      IMAGE_MODE_SETTINGS.includes(r.imageModeOverride as null)) &&
    (r.extraKeys === undefined || isExtraKeysRecord(r.extraKeys))
  );
}

/** Shape guard for a persisted/imported `devices` entry: identity fields are
 *  required strings; per-device settings are optional but must be well-typed.
 *  Applied on both disk load and raw-JSON import, so a corrupt entry can't
 *  poison runtime state. */
function isDeviceIdentitySettings(d: unknown): d is DeviceIdentitySettings {
  if (typeof d !== 'object' || d === null) return false;
  const r = d as Record<string, unknown>;
  return (
    typeof r.deviceKey === 'string' &&
    typeof r.mdnsServiceName === 'string' &&
    typeof r.macAddress === 'string' &&
    typeof r.dockSerial === 'string' &&
    typeof r.childSerial === 'string' &&
    hasValidDeviceSettings(r)
  );
}

/** The settings.json slice owned by the WebUI server: the selected dock and the
 *  per-physical-device entries (identity + brightness/override/imageMode/
 *  extraKeys), keyed by device-identity.ts's deviceKeyFor(). This class is the
 *  sole settings.json writer — DriverManager/DeviceSession resolve identities
 *  through getOrCreateIdentity() rather than touching disk themselves. */
export class PersistedSettings {
  selectedDock = 0;
  private devices: DeviceIdentitySettings[] = [];

  /** `cacheRoot` is overridable so tests never touch the real user cache dir;
   *  production passes undefined and settings-store.ts picks the default. */
  constructor(private readonly cacheRoot?: string) {}

  /** Apply settings.json (if present) over the defaults. Malformed device
   *  entries are dropped (same guard as import). Legacy path-keyed entries are
   *  pruned too: the IOKit path is volatile, so they can never re-match a
   *  device and would accumulate one phantom row per replug. */
  async load(): Promise<void> {
    const saved = await loadSettings(this.cacheRoot);
    if (typeof saved.selectedDock === 'number') this.selectedDock = saved.selectedDock;
    if (Array.isArray(saved.devices)) {
      saved.devices.forEach(stripInvalidExtraKeys);
      this.devices = saved.devices
        .filter(isDeviceIdentitySettings)
        .filter((d) => isStableDeviceKey(d.deviceKey));
    }
  }

  /** Fire-and-forget write-through — called after every mutation of a persisted
   *  field. Errors are logged inside saveSettings(), never thrown. */
  persist(): void {
    void saveSettings(this.current(), this.cacheRoot);
  }

  json(): string {
    return JSON.stringify(this.current(), null, 2);
  }

  /** Open settings.json in the OS default handler. Writes current settings
   *  first — the file may not exist yet and `open` fails silently on a missing
   *  path. Failures beyond that are swallowed in os-utils.ts. */
  async openFile(): Promise<void> {
    await saveSettings(this.current(), this.cacheRoot);
    await openPathInOS(settingsPath(this.cacheRoot));
  }

  entryFor(deviceKey: string): DeviceIdentitySettings | undefined {
    return deviceKey ? this.devices.find((d) => d.deviceKey === deviceKey) : undefined;
  }

  /** Look up (or generate + persist) the stable identity for `deviceKey`.
   *  Pure generation lives in device-identity.ts. */
  getOrCreateIdentity(deviceKey: string, defaultMdnsName: string): DeviceIdentitySettings {
    const result = getOrCreateDeviceIdentityPure(deviceKey, defaultMdnsName, this.devices);
    if (result.created) {
      this.devices = result.devices;
      this.persist();
    }
    return result.identity;
  }

  /** Rename `deviceKey`'s persisted mDNS name; false if it has no entry yet. */
  updateMdnsName(deviceKey: string, name: string): boolean {
    const entry = this.entryFor(deviceKey);
    if (!entry) return false;
    entry.mdnsServiceName = name;
    this.persist();
    return true;
  }

  /** Replace devices[] from a raw-JSON import; false (and ignored, not thrown)
   *  if malformed. */
  importDevices(devices: unknown): boolean {
    if (!Array.isArray(devices) || !devices.every(isDeviceIdentitySettings)) return false;
    this.devices = devices;
    this.persist();
    return true;
  }

  /** Copy each real dock's live brightness into its persisted device entry.
   *  Persists only on actual change; docks without a deviceKey are skipped. */
  syncDockBrightness(docks: DockStatus[]): void {
    let changed = false;
    for (const dock of docks) {
      const e = this.entryFor(dock.deviceKey);
      if (e && e.brightness !== dock.brightness) {
        e.brightness = dock.brightness;
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  private current(): Settings {
    return {
      selectedDock: this.selectedDock,
      ...(this.devices.length > 0 ? { devices: this.devices } : {}),
    };
  }
}
