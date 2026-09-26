// Persists a small set of "real hardware" WebUI settings (brightness,
// brightness-override, selected dock) to disk so they survive a restart.
// Everything else (mock config, driver mode) stays runtime-only — see
// .claude/plans/2026-07-13_persistent-settings.md.
//
// Disk-write pattern mirrors native-libs.ts: makeDir(recursive) → write to
// <target>.tmp-<pid> → rename() for atomicity.
import { log } from './logger.js';
import type { CliLogLevel } from './cli.js';
import { defaultCacheRoot } from './native-libs.js';
import { SERIAL_KEY_PREFIX } from './device-identity.js';
import type {
  EncoderSettings,
  ExtraKeyConfig,
  TouchStripMode,
  TouchStripOptions,
  TouchStripUpload,
  TouchStripZoneFit,
} from './types.js';
import { DEFAULT_TOUCH_STRIP_OPTIONS } from './types.js';
import type { DeviceModelId, DeviceModelOverride } from './devices/driver.js';
import type { UpdateState } from './update-check.js';

/** One physical device's persisted state, keyed by device-identity.ts's
 *  deviceKeyFor() (v1: the HID path). Holds both the stable identity
 *  (mdns/mac/serials — see .claude/plans/2026-07-14_per-device-identity.md) and
 *  the per-device settings (brightness/override — see
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
  /** DeckBridge-native actions for keys outside the emulated grid (293S 6th
   *  column), keyed by device wire id — see extra-keys.ts. */
  extraKeys?: Record<string, ExtraKeyConfig>;
  /** Touch-strip display mode (AKP05E). Default 'elgato' = the app only. */
  touchStripMode?: TouchStripMode;
  /** 'deckbridge-repaint' hold-off after an Elgato frame; default TOUCH_STRIP_REPAINT_DEFAULT_MS. */
  touchStripRepaintMs?: number;
  /** Full-strip models (AKP05E): how a 200-px app zone maps onto a slot window.
   *  Default 'crop'. settings.json only — no WebUI control. */
  touchStripZoneFit?: TouchStripZoneFit;
  /** Full-strip models: when to send one whole-strip upload. Default 'full-frames'.
   *  settings.json only — no WebUI control. */
  touchStripUpload?: TouchStripUpload;
  /** Encoder override — only honored while touchStripMode is a deckbridge-* mode. */
  encoders?: EncoderSettings;
  /** What a tap refresh shows on the widget; each absent flag takes its default
   *  (DEFAULT_TAP_FEEDBACK). settings.json only — no WebUI control. */
  tapFeedback?: Partial<TapFeedback>;
}

/** Tap-refresh feedback: `flash` = inverted colours for a moment on the tap;
 *  `placeholder` = '…' until the refresh completes. Independent, both allowed. */
export interface TapFeedback {
  flash: boolean;
  placeholder: boolean;
}

export const DEFAULT_TAP_FEEDBACK: TapFeedback = { flash: true, placeholder: false };

/** Shape guard for a persisted tapFeedback: an object whose known flags are booleans. */
export function isTapFeedback(v: unknown): v is Partial<TapFeedback> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return (
    (r.flash === undefined || typeof r.flash === 'boolean') &&
    (r.placeholder === undefined || typeof r.placeholder === 'boolean')
  );
}

/** A dock's effective tap feedback: its persisted flags over the defaults. */
export function tapFeedbackOf(entry: DeviceIdentitySettings | undefined): TapFeedback {
  return { ...DEFAULT_TAP_FEEDBACK, ...entry?.tapFeedback };
}

/** Persisted log level. Precedence (documented in cli.ts's usage text and
 *  docs/troubleshooting.md): CLI flag > DECKBRIDGE_LOG_LEVEL > settings.json >
 *  build-time `__LOG_LEVEL__`. Alias of cli.ts's canonical CliLogLevel (the
 *  single source of truth for accepted levels) so the two can't drift apart. */
export type PersistedLogLevel = CliLogLevel;

export interface Settings {
  selectedDock?: number;
  logLevel?: PersistedLogLevel;
  /** Opt-in multi-deck: dock a second supported device as its own headless CORA
   *  dock (max MAX_MULTI_DECK_SESSIONS). Absent/false = a single dock, and no USB
   *  scanning at all once it is connected. */
  multiDeck?: boolean;
  devices?: DeviceIdentitySettings[];
  /** Per-MODEL device tuning (rotation/flip/size/quality/keyMap — see
   *  devices/model-overrides.ts), keyed by model id.
   *
   *  Keyed by model id rather than by `deviceKey` on purpose: deviceKeyFor()
   *  needs the device's serial, which is only known AFTER open() succeeds, but
   *  image/wire/keyMap must already be correct for that first open and first
   *  splash. It also matches the intent — these are calibration values for an
   *  untested board, destined to be upstreamed into the registry, not per-unit
   *  taste. Per-unit settings (brightness/imageMode) stay in devices[]. */
  modelOverrides?: Record<DeviceModelId, DeviceModelOverride>;
  /** GitHub-release update check (update-check.ts). Absent `updateCheck` = on
   *  (opt-out); `updateState` caches the last result so a 30x/day restarter
   *  doesn't burn the unauthenticated GitHub rate limit. */
  updateCheck?: boolean;
  updateState?: UpdateState;
  /** Daily usage ping (daily-ping.ts). Absent = on (opt-out); `false` disables
   *  it, independently of `updateCheck`. `a7sDay` is the UTC day of the last ping
   *  — the only dailyPing state kept, and it never leaves the machine. */
  a7s?: boolean;
  a7sDay?: string;
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

/** A dock's persisted strip options (settings.json), or undefined when it keeps the
 *  defaults — so the caller can skip a redundant worker message. */
export function touchStripOptionsOf(entry: DeviceIdentitySettings): TouchStripOptions | undefined {
  if (entry.touchStripZoneFit === undefined && entry.touchStripUpload === undefined) {
    return undefined;
  }
  return {
    zoneFit: entry.touchStripZoneFit ?? DEFAULT_TOUCH_STRIP_OPTIONS.zoneFit,
    upload: entry.touchStripUpload ?? DEFAULT_TOUCH_STRIP_OPTIONS.upload,
  };
}
