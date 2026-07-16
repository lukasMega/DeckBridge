// Persists a small set of "real hardware" WebUI settings (brightness,
// brightness-override, image-mode override, selected dock) to disk so they
// survive a restart. Everything else (mock config, driver mode) stays
// runtime-only — see .claude/plans/2026-07-13_persistent-settings.md.
//
// Disk-write pattern mirrors native-libs.ts: makeDir(recursive) → write to
// <target>.tmp-<pid> → rename() for atomicity.
import { log } from './logger.js';
import { defaultCacheRoot } from './native-libs.js';
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

/** Reads and parses the settings file. Returns {} on any error (missing
 *  file, invalid JSON, not an object) — never throws, so a corrupt/missing
 *  file can't block startup. */
export async function loadSettings(cacheRoot: string = defaultCacheRoot()): Promise<Settings> {
  try {
    const bytes = await tjs.readFile(settingsPath(cacheRoot));
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
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
