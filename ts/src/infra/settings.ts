import { isTapFeedback, loadSettings, saveSettings, settingsPath } from './settings-store.js';
import type { Settings, DeviceIdentitySettings, PersistedLogLevel } from './settings-store.js';
import { isLogLevel } from '../shared/cli.js';
import { openPathInOS } from './os-utils.ts';
import {
  getOrCreateDeviceIdentity as getOrCreateDeviceIdentityPure,
  isStableDeviceKey,
} from './device-identity.js';
import { isModelOverridesRecord, validateModelOverride } from '../devices/model-overrides.js';
import { findModelById } from '../devices/registry.js';
import type { DeviceModelOverride } from '../devices/driver.js';
import { log } from '../shared/logger.js';
import {
  isExtraKeyConfig,
  isOneOf,
  isTouchStripRepaintMs,
  normalizeExtraKeyConfig,
  TOUCH_STRIP_MODES,
  TOUCH_STRIP_UPLOADS,
  TOUCH_STRIP_ZONE_FITS,
} from '../shared/types.js';
import type { DockStatus, ExtraKeyConfig } from '../shared/types.js';
import type { UpdateState } from './update-check.js';
import { encoderSettingsError } from '../shared/encoder-settings.js';
import { DockPrefs, defaultRuntimePrefs } from './dock-prefs.js';
import type { DockPrefsStore } from './dock-prefs.js';

/** Grace-period bounds for elgatoAutoRestartDelayS (see
 *  .claude/plans/2026-09-27_auto-restart-elgato-app.md §4.2). */
const ELGATO_AUTO_RESTART_DELAY_S_MIN = 3;
const ELGATO_AUTO_RESTART_DELAY_S_MAX = 120;
const ELGATO_AUTO_RESTART_DELAY_S_DEFAULT = 10;

/** Clamp a persisted/incoming grace-period value into the accepted range. */
function clampAutoRestartDelayS(delayS: number): number {
  return Math.min(
    ELGATO_AUTO_RESTART_DELAY_S_MAX,
    Math.max(ELGATO_AUTO_RESTART_DELAY_S_MIN, delayS),
  );
}

/** Shape guard for a persisted/imported extraKeys map (wire id → config). */
function isExtraKeysRecord(v: unknown): v is Record<string, ExtraKeyConfig> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  return Object.values(v).every(isExtraKeyConfig);
}

/** Optional per-device fields shared by stripInvalidDeviceSettings and
 *  hasValidDeviceSettings — one table so both stay in sync and neither trips
 *  the complexity limit on a long if-chain. */
const OPTIONAL_DEVICE_FIELDS: ReadonlyArray<{ key: string; isValid: (v: unknown) => boolean }> = [
  { key: 'brightness', isValid: (v) => typeof v === 'number' },
  { key: 'brightnessOverride', isValid: (v) => typeof v === 'boolean' },
  { key: 'extraKeys', isValid: isExtraKeysRecord },
  { key: 'touchStripMode', isValid: (v) => isOneOf(TOUCH_STRIP_MODES, v) },
  { key: 'touchStripRepaintMs', isValid: isTouchStripRepaintMs },
  { key: 'touchStripZoneFit', isValid: (v) => isOneOf(TOUCH_STRIP_ZONE_FITS, v) },
  { key: 'touchStripUpload', isValid: (v) => isOneOf(TOUCH_STRIP_UPLOADS, v) },
  { key: 'encoders', isValid: (v) => !encoderSettingsError(v) },
  { key: 'tapFeedback', isValid: isTapFeedback },
  { key: 'pairedAt', isValid: (v) => typeof v === 'string' },
];

/** Strip bad optional per-device fields so they can't fail isDeviceIdentitySettings
 *  and drop the whole identity entry — that would regenerate MAC/serial and force an
 *  Elgato re-pair. extraKeys: migration 2026-07-16 (action→widget model);
 *  touchStripDisabled: replaced by touchStripMode 2026-09-22, no migration;
 *  imageModeOverride: replaced by overrides.image.resizeMode/padFill, no migration. */
function stripInvalidDeviceSettings(d: unknown): void {
  if (typeof d !== 'object' || d === null) return;
  const r = d as Record<string, unknown>;
  for (const { key, isValid } of OPTIONAL_DEVICE_FIELDS) {
    if (r[key] !== undefined && !isValid(r[key])) delete r[key];
  }
  delete r.touchStripDisabled;
  delete r.imageModeOverride;
}

/** Fold pre-`style` text fields of a valid entry's extraKeys into `style`. */
function normalizeDeviceExtraKeys(d: DeviceIdentitySettings): DeviceIdentitySettings {
  if (!d.extraKeys) return d;
  const extraKeys = Object.fromEntries(
    Object.entries(d.extraKeys).map(([wireId, cfg]) => [wireId, normalizeExtraKeyConfig(cfg)]),
  );
  return { ...d, extraKeys };
}

/** The optional per-device settings half of isDeviceIdentitySettings. */
function hasValidDeviceSettings(r: Record<string, unknown>): boolean {
  return OPTIONAL_DEVICE_FIELDS.every(
    ({ key, isValid }) => r[key] === undefined || isValid(r[key]),
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

/** Validate a persisted/imported `modelOverrides` map, dropping (with a warn)
 *  every entry that names an unknown model or fails validateModelOverride. Runs
 *  on BOTH disk load and raw-JSON import, same as isDeviceIdentitySettings — an
 *  invalid override must never poison runtime state, and a bad keyMap can make a
 *  device look dead. */
export function sanitizeModelOverrides(raw: unknown): Record<string, DeviceModelOverride> {
  if (raw === undefined) return {};
  if (!isModelOverridesRecord(raw)) {
    log('warn', 'settings', 'modelOverrides: not an object map — ignoring');
    return {};
  }
  const out: Record<string, DeviceModelOverride> = {};
  for (const [modelId, override] of Object.entries(raw)) {
    const model = findModelById(modelId);
    if (!model) {
      log('warn', 'settings', `modelOverrides['${modelId}']: unknown model id — dropped`);
      continue;
    }
    const result = validateModelOverride(override, model);
    if (!result.ok) {
      log(
        'warn',
        'settings',
        `modelOverrides['${modelId}']: dropped — ${result.errors.join('; ')}`,
      );
      continue;
    }
    out[modelId] = result.value;
  }
  return out;
}

/** settings.json in memory: process-wide prefs and the per-physical-device
 *  entries (identity + brightness/override/extraKeys/…), keyed by
 *  device-identity.ts's deviceKeyFor(). Loaded once by app.ts before anything
 *  else reads it; this class is the sole settings.json writer. */
export class PersistedSettings implements DockPrefsStore {
  selectedDock = 0;
  /** undefined = not persisted; the level then comes from the CLI flag / env /
   *  the build-time default (see PersistedLogLevel). */
  logLevel: PersistedLogLevel | undefined = undefined;
  /** Opt-in second dock; false = single dock and no dock scan (types.ts
   *  MAX_MULTI_DECK_DOCKS, dock-scanner.ts). */
  multiDeck = false;
  /** GitHub-release update check opt-out (see update-check.ts). undefined = enabled. */
  updateCheck: boolean | undefined = undefined;
  updateState: UpdateState | undefined = undefined;
  /** Daily usage ping opt-out (see daily-ping.ts). undefined = enabled. */
  a7s: boolean | undefined = undefined;
  a7sDay: string | undefined = undefined;
  /** Elgato-app auto-restart opt-out + grace delay (see elgato-auto-restart.ts).
   *  undefined = enabled / default delay. */
  elgatoAutoRestart: boolean | undefined = undefined;
  elgatoAutoRestartDelayS: number | undefined = undefined;
  /** Browser's navigator.language (dailyPing's OS-locale fallback). Ephemeral —
   *  deliberately absent from current()/persist(), since the browser resends it
   *  on every load. */
  browserLocale: string | undefined = undefined;
  /** Prefs of a dock with no settings.json entry (mock mode, pre-connect). Never persisted. */
  readonly runtime = defaultRuntimePrefs();
  private devices: DeviceIdentitySettings[] = [];
  private modelOverrides: Record<string, DeviceModelOverride> = {};
  /** Serializes writes: overlapping write+rename pairs could land out of order. */
  private saveChain: Promise<void> = Promise.resolve();
  private pendingSave: Settings | undefined;

  /** `cacheRoot` is overridable so tests never touch the real user cache dir;
   *  production passes undefined and settings-store.ts picks the default. */
  constructor(readonly cacheRoot?: string) {}

  /** Apply settings.json (if present) over the defaults. Malformed device
   *  entries are dropped (same guard as import). Legacy path-keyed entries are
   *  pruned too: the IOKit path is volatile, so they can never re-match a
   *  device and would accumulate one phantom row per replug. */
  async load(): Promise<void> {
    const saved = await loadSettings(this.cacheRoot);
    if (typeof saved.selectedDock === 'number') this.selectedDock = saved.selectedDock;
    if (isLogLevel(saved.logLevel)) this.logLevel = saved.logLevel;
    if (typeof saved.multiDeck === 'boolean') this.multiDeck = saved.multiDeck;
    if (typeof saved.updateCheck === 'boolean') this.updateCheck = saved.updateCheck;
    if (saved.updateState) this.updateState = saved.updateState;
    if (typeof saved.a7s === 'boolean') this.a7s = saved.a7s;
    if (typeof saved.a7sDay === 'string') this.a7sDay = saved.a7sDay;
    if (typeof saved.elgatoAutoRestart === 'boolean') {
      this.elgatoAutoRestart = saved.elgatoAutoRestart;
    }
    if (typeof saved.elgatoAutoRestartDelayS === 'number') {
      this.elgatoAutoRestartDelayS = clampAutoRestartDelayS(saved.elgatoAutoRestartDelayS);
    }
    this.modelOverrides = sanitizeModelOverrides(saved.modelOverrides);
    if (Array.isArray(saved.devices)) {
      saved.devices.forEach(stripInvalidDeviceSettings);
      this.devices = saved.devices
        .filter(isDeviceIdentitySettings)
        .filter((d) => isStableDeviceKey(d.deviceKey))
        .map(normalizeDeviceExtraKeys);
    }
  }

  /** Fire-and-forget write-through — called after every mutation of a persisted
   *  field. Errors are logged inside saveSettings(), never thrown. */
  persist(): void {
    void this.queueSave(this.current());
  }

  /** Resolves once every queued snapshot is on disk. */
  async flush(): Promise<void> {
    await this.saveChain;
  }

  /** A burst of saves coalesces onto one write of the newest snapshot. */
  private queueSave(snapshot: Settings): Promise<void> {
    this.pendingSave = snapshot;
    this.saveChain = this.saveChain.then(async (): Promise<void> => {
      const pending = this.pendingSave;
      if (pending === undefined) return;
      this.pendingSave = undefined;
      return saveSettings(pending, this.cacheRoot);
    });
    return this.saveChain;
  }

  json(): string {
    return JSON.stringify(this.current(), null, 2);
  }

  /** Open settings.json in the OS default handler. Writes current settings
   *  first — the file may not exist yet and `open` fails silently on a missing
   *  path. Failures beyond that are swallowed in os-utils.ts. */
  async openFile(): Promise<void> {
    await this.queueSave(this.current());
    await openPathInOS(settingsPath(this.cacheRoot));
  }

  /** Live per-device prefs of the dock with `deviceKey` ('' = no entry → runtime fallback). */
  for(deviceKey: string): DockPrefs {
    return new DockPrefs(this, deviceKey);
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
    this.devices = devices.map(normalizeDeviceExtraKeys);
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

  /** Persist a new log level (WebUI "Debug logging"). `undefined` clears it, so
   *  the CLI flag / env / build-time default takes over again. */
  setLogLevel(level: PersistedLogLevel | undefined): void {
    this.logLevel = level;
    this.persist();
  }

  /** Persist the multi-deck opt-in (WebUI "Use two decks at once"). */
  setMultiDeck(enabled: boolean): void {
    this.multiDeck = enabled;
    this.persist();
  }

  /** Persist the update-check opt-out (WebUI "Check for updates" toggle). */
  setUpdateCheck(enabled: boolean): void {
    this.updateCheck = enabled;
    this.persist();
  }

  setUpdateState(state: UpdateState): void {
    this.updateState = state;
    this.persist();
  }

  /** Record the UTC day of the latest usage ping (daily-ping.ts). */
  setDailyPingDay(day: string): void {
    this.a7sDay = day;
    this.persist();
  }

  // Elgato-app auto-restart (see main/elgato-auto-restart.ts)

  /** Persist the auto-restart opt-out + grace delay (WebUI "Elgato app" panel). An
   *  omitted `delayS` leaves the current delay untouched. */
  setElgatoAutoRestart(enabled: boolean, delayS?: number): void {
    this.elgatoAutoRestart = enabled;
    if (delayS !== undefined) this.elgatoAutoRestartDelayS = clampAutoRestartDelayS(delayS);
    this.persist();
  }

  /** Whether the auto-restart feature is on. Absent setting = on. */
  elgatoAutoRestartEnabled(): boolean {
    return this.elgatoAutoRestart ?? true;
  }

  /** Grace-period seconds before an auto-restart fires. Absent setting = the default. */
  elgatoAutoRestartDelaySeconds(): number {
    return clampAutoRestartDelayS(
      this.elgatoAutoRestartDelayS ?? ELGATO_AUTO_RESTART_DELAY_S_DEFAULT,
    );
  }

  /** Set `pairedAt` on `deviceKey`'s entry the first time the Elgato child client
   *  attaches to it. No-op (returns false) if the entry doesn't exist yet (mock mode,
   *  deviceKey === '') or already has a pairedAt — only stable keys ever reach
   *  devices[], so no isStableDeviceKey re-check is needed here (load() prunes
   *  path-keyed entries already). */
  markPaired(deviceKey: string): boolean {
    const entry = this.entryFor(deviceKey);
    if (!entry || entry.pairedAt !== undefined) return false;
    entry.pairedAt = new Date().toISOString();
    this.persist();
    return true;
  }

  /** Whether `deviceKey` has ever completed an Elgato pairing (markPaired ran). */
  wasPaired(deviceKey: string): boolean {
    return this.entryFor(deviceKey)?.pairedAt !== undefined;
  }

  // Model overrides (device tuning) — see devices/model-overrides.ts

  /** Every model's override, by model id. Read by DriverManager at probe time. */
  allModelOverrides(): Record<string, DeviceModelOverride> {
    return this.modelOverrides;
  }

  overrideFor(modelId: string): DeviceModelOverride | undefined {
    return this.modelOverrides[modelId];
  }

  /** Store (or, with undefined, clear) one model's override. Callers validate
   *  first — this is the write half only. */
  setModelOverride(modelId: string, override: DeviceModelOverride | undefined): void {
    if (override === undefined || Object.keys(override).length === 0) {
      delete this.modelOverrides[modelId];
    } else {
      this.modelOverrides[modelId] = override;
    }
    this.persist();
  }

  /** Replace the whole map from a raw-JSON import; invalid entries are dropped
   *  (not thrown), same policy as importDevices. */
  importModelOverrides(raw: unknown): void {
    this.modelOverrides = sanitizeModelOverrides(raw);
    this.persist();
  }

  private current(): Settings {
    return {
      selectedDock: this.selectedDock,
      ...(this.logLevel !== undefined ? { logLevel: this.logLevel } : {}),
      ...(this.multiDeck ? { multiDeck: true } : {}),
      ...(this.updateCheck !== undefined ? { updateCheck: this.updateCheck } : {}),
      ...(this.updateState ? { updateState: this.updateState } : {}),
      ...(this.a7s !== undefined ? { a7s: this.a7s } : {}),
      ...(this.a7sDay ? { a7sDay: this.a7sDay } : {}),
      ...(this.elgatoAutoRestart !== undefined
        ? { elgatoAutoRestart: this.elgatoAutoRestart }
        : {}),
      ...(this.elgatoAutoRestartDelayS !== undefined
        ? { elgatoAutoRestartDelayS: this.elgatoAutoRestartDelayS }
        : {}),
      ...(this.devices.length > 0 ? { devices: this.devices } : {}),
      ...(Object.keys(this.modelOverrides).length > 0
        ? { modelOverrides: this.modelOverrides }
        : {}),
    };
  }
}
