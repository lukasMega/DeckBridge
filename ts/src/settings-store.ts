// Persists a small set of "real hardware" WebUI settings (brightness,
// brightness-override, image-mode override, selected dock) to disk so they
// survive a restart. Everything else (mock config, driver mode) stays
// runtime-only — see .claude/plans/2026-07-13_persistent-settings.md.
//
// Disk-write pattern mirrors native-libs.ts: makeDir(recursive) → write to
// <target>.tmp-<pid> → rename() for atomicity.
import { log } from './logger.js';
import { defaultCacheRoot } from './native-libs.js';
import { SERIAL_KEY_PREFIX } from './device-identity.js';
import type { ExtraKeyConfig, ImageModeOverride } from './types.js';

/** One physical device's persisted state, keyed by device-identity.ts's
 *  deviceKeyFor() (v1: the HID path). Holds both the stable identity
 *  (mdns/mac/serials — see .claude/plans/2026-07-14_per-device-identity.md) and
 *  the per-device settings (brightness/override/imageMode — see
 *  2026-07-15_per-device-settings.md). Settings fields are optional: absent =
 *  use the hardcoded default until the user changes it. */
export interface DeviceIdentitySettings {
  deviceKey: string;
  mdnsServiceName: string;
  macAddress: string;
  dockSerial: string;
  childSerial: string;
  brightness?: number;
  brightnessOverride?: boolean;
  imageModeOverride?: ImageModeOverride;
  /** DeckBridge-native actions for keys outside the emulated grid (293S 6th
   *  column), keyed by device wire id — see extra-keys.ts. */
  extraKeys?: Record<string, ExtraKeyConfig>;
}

export interface Settings {
  selectedDock?: number;
  devices?: DeviceIdentitySettings[];
}

const SETTINGS_FILE = 'settings.json';

// Per-process counter so overlapping saveSettings() calls (each fire-and-forget
// from a mutation) never share a tmp path — pid alone collides, letting two
// interleaved write+rename pairs corrupt the file or ENOENT on the second rename.
let tmpCounter = 0;

/** `cacheRoot` is overridable so tests can point at a throwaway tmp dir. */
export function settingsPath(cacheRoot: string = defaultCacheRoot()): string {
  return `${cacheRoot}/${SETTINGS_FILE}`;
}

/** Directory holding the user's plugin-widget JS files, next to the settings
 *  store (see extra-keys plugin widget / plugin-host.ts). */
export function pluginsDir(cacheRoot: string = defaultCacheRoot()): string {
  return `${cacheRoot}/plugins`;
}

// v1 protocol_version devices report this hardcoded serial on every unit of every v1
// model (see DeviceWireSpec.sharedSerial, devices/driver.ts) — mirajazz documents it,
// keydeck encodes it as "force_serial": true. Before deviceKeyFor() started appending
// a model id (see device-identity.ts), a v1 deck's settings.json entry was keyed by
// this serial alone: `usb:355499441494`.
const MIRABOX_V1_SHARED_SERIAL = '355499441494';
// The only v1 model that existed before model-suffixed keys were introduced — the 7
// AKP153-family rebadges (rebadge/akp153-v1-clones.ts) landed alongside this fix, so a
// pre-existing bare shared-serial entry can only have come from a 293S.
const MIRABOX_V1_SHARED_SERIAL_MODEL_ID = 'mirabox-293s';

/** Type guard: `d` is an object whose `deviceKey` field equals `key`. Module-scoped (not
 *  a closure) — it captures nothing from `migrateSharedSerialEntries`. */
function isEntryWithKey(d: unknown, key: string): d is { deviceKey: string } {
  return typeof d === 'object' && d !== null && (d as { deviceKey?: unknown }).deviceKey === key;
}

/** One-shot migration: rewrite a pre-fix bare `usb:355499441494` settings entry to the
 *  model-suffixed key the fixed `deviceKeyFor()` now produces for a 293S, so the same
 *  physical unit keeps its MAC/serial/mDNS name instead of looking like a brand-new
 *  device (which would force an Elgato re-pair). Only migrates when unambiguous: exactly
 *  one bare entry, and no suffixed entry already present. Two or more bare entries were
 *  already colliding before this fix — guessing which one is "the" 293S would be worse
 *  than leaving them alone (both simply re-pair). Mutates `devices` in place. */
function migrateSharedSerialEntries(devices: unknown[]): void {
  const bareKey = `${SERIAL_KEY_PREFIX}${MIRABOX_V1_SHARED_SERIAL}`;
  const suffixedKey = `${bareKey}:${MIRABOX_V1_SHARED_SERIAL_MODEL_ID}`;

  const bareEntries = devices.filter((d) => isEntryWithKey(d, bareKey));
  const [bareEntry] = bareEntries;
  if (bareEntries.length !== 1 || !bareEntry) return; // 0 = nothing to do; 2+ = already colliding
  if (devices.some((d) => isEntryWithKey(d, suffixedKey))) return; // already migrated

  bareEntry.deviceKey = suffixedKey;
  log('info', 'settings', `migrated shared-serial device identity: ${bareKey} -> ${suffixedKey}`);
}

/** Reads and parses the settings file. Returns {} on any error (missing
 *  file, invalid JSON, not an object) — never throws, so a corrupt/missing
 *  file can't block startup. */
export async function loadSettings(cacheRoot: string = defaultCacheRoot()): Promise<Settings> {
  try {
    const bytes = await tjs.readFile(settingsPath(cacheRoot));
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const record = parsed as Record<string, unknown>;
    if (Array.isArray(record.devices)) migrateSharedSerialEntries(record.devices);
    return parsed;
  } catch (e) {
    if ((e as { code?: string }).code !== 'ENOENT') {
      log('warn', 'settings', `loadSettings failed: ${(e as Error).message}`);
    }
    return {};
  }
}

/** Writes `data` to the settings file, atomically (tmp file + rename). */
export async function saveSettings(
  data: Settings,
  cacheRoot: string = defaultCacheRoot(),
): Promise<void> {
  const target = settingsPath(cacheRoot);
  const tmp = `${target}.tmp-${tjs.pid}-${tmpCounter++}`;
  try {
    await tjs.makeDir(cacheRoot, { recursive: true });
    await tjs.writeFile(tmp, JSON.stringify(data, null, 2));
    await tjs.rename(tmp, target);
  } catch (e) {
    log('error', 'settings', `saveSettings failed: ${(e as Error).message}`);
    try {
      await tjs.remove(tmp);
    } catch {}
  }
}
