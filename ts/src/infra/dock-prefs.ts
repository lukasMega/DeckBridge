// One dock's per-device preferences, read and written live by deviceKey — see
// PersistedSettings.for(). A dock with no settings.json entry (mock mode, or
// before the first connect) uses the runtime-only fallback, never persisted.
import type { DeviceIdentitySettings, TapFeedback } from './settings-store.js';
import { tapFeedbackOf } from './settings-store.js';
import { DEFAULT_TOUCH_STRIP_MODE, TOUCH_STRIP_REPAINT_DEFAULT_MS } from '../shared/types.js';
import type {
  EncoderSettings,
  ExtraKeyConfig,
  StandbySettings,
  TouchStripMode,
} from '../shared/types.js';
import type { PageDefinition } from '../shared/page-config.js';
import { resolveStandby } from '../shared/standby-settings.js';

export const DEFAULT_BRIGHTNESS_OVERRIDE = true;

/** Fallback values for a dock with no settings.json entry, shared by every such lookup. */
export interface RuntimePrefs {
  brightnessOverride: boolean;
  touchStripMode: TouchStripMode;
  touchStripRepaintMs: number;
  encoders: EncoderSettings;
  standby: Partial<StandbySettings>;
}

export function defaultRuntimePrefs(): RuntimePrefs {
  return {
    brightnessOverride: DEFAULT_BRIGHTNESS_OVERRIDE,
    touchStripMode: DEFAULT_TOUCH_STRIP_MODE,
    touchStripRepaintMs: TOUCH_STRIP_REPAINT_DEFAULT_MS,
    encoders: {},
    standby: {},
  };
}

/** Where a DockPrefs reads and writes: the entry is looked up per call, since a
 *  settings import replaces the entries. */
export interface DockPrefsStore {
  entryFor(deviceKey: string): DeviceIdentitySettings | undefined;
  persist(): void;
  readonly runtime: RuntimePrefs;
}

export class DockPrefs {
  constructor(
    private readonly store: DockPrefsStore,
    readonly deviceKey: string,
  ) {}

  /** undefined = no settings.json entry; setters then write the runtime fallback. */
  entry(): DeviceIdentitySettings | undefined {
    return this.store.entryFor(this.deviceKey);
  }

  /** Persisted brightness; undefined = use the device/model default. */
  brightness(): number | undefined {
    return this.entry()?.brightness;
  }

  /** "Ignore brightness from the Elgato app". */
  brightnessOverride(): boolean {
    const e = this.entry();
    return e
      ? (e.brightnessOverride ?? DEFAULT_BRIGHTNESS_OVERRIDE)
      : this.store.runtime.brightnessOverride;
  }

  extraKeyConfig(wireId: number): ExtraKeyConfig | undefined {
    return this.entry()?.extraKeys?.[String(wireId)];
  }

  extraKeyConfigs(): Record<string, ExtraKeyConfig> {
    return this.entry()?.extraKeys ?? {};
  }

  pages(): readonly PageDefinition[] {
    return this.entry()?.pages ?? [];
  }

  stripMode(): TouchStripMode {
    const e = this.entry();
    return e ? (e.touchStripMode ?? DEFAULT_TOUCH_STRIP_MODE) : this.store.runtime.touchStripMode;
  }

  /** 'deckbridge-repaint' hold-off, read live each widget tick. */
  repaintMs(): number {
    const e = this.entry();
    return e
      ? (e.touchStripRepaintMs ?? TOUCH_STRIP_REPAINT_DEFAULT_MS)
      : this.store.runtime.touchStripRepaintMs;
  }

  encoders(): EncoderSettings | undefined {
    const e = this.entry();
    return e ? e.encoders : this.store.runtime.encoders;
  }

  tapFeedback(): TapFeedback {
    return tapFeedbackOf(this.entry());
  }

  /** What is persisted, unresolved (the WebUI POST merges into it). */
  standbyStored(): Partial<StandbySettings> {
    const e = this.entry();
    return (e ? e.standby : this.store.runtime.standby) ?? {};
  }

  /** Resolved over the defaults, read live (the WebUI and imports change it). */
  standby(): StandbySettings {
    return resolveStandby(this.standbyStored());
  }

  setBrightnessOverride(enabled: boolean): void {
    this.write(
      (e) => (e.brightnessOverride = enabled),
      (r) => (r.brightnessOverride = enabled),
    );
  }

  setStripMode(mode: TouchStripMode): void {
    this.write(
      (e) => (e.touchStripMode = mode),
      (r) => (r.touchStripMode = mode),
    );
  }

  setRepaintMs(ms: number): void {
    this.write(
      (e) => (e.touchStripRepaintMs = ms),
      (r) => (r.touchStripRepaintMs = ms),
    );
  }

  /** An empty object clears the persisted field. */
  setEncoders(encoders: EncoderSettings): void {
    this.write(
      (e) => {
        if (Object.keys(encoders).length > 0) e.encoders = encoders;
        else delete e.encoders;
      },
      (r) => (r.encoders = encoders),
    );
  }

  /** An empty object clears the persisted field. */
  setStandby(s: Partial<StandbySettings>): void {
    this.write(
      (e) => {
        if (Object.keys(s).length > 0) e.standby = s;
        else delete e.standby;
      },
      (r) => (r.standby = s),
    );
  }

  /** Persist-only: extra keys need a device entry. False when there is none. */
  setExtraKeyConfigs(map: Record<string, ExtraKeyConfig>): boolean {
    const e = this.entry();
    if (!e) return false;
    if (Object.keys(map).length > 0) e.extraKeys = map;
    else delete e.extraKeys;
    this.store.persist();
    return true;
  }

  /** Persist-only like setExtraKeyConfigs; an empty list clears the field. */
  setPages(list: readonly PageDefinition[]): boolean {
    const e = this.entry();
    if (!e) return false;
    if (list.length > 0) e.pages = [...list];
    else delete e.pages;
    this.store.persist();
    return true;
  }

  private write(
    persisted: (e: DeviceIdentitySettings) => void,
    runtime: (r: RuntimePrefs) => void,
  ): void {
    const e = this.entry();
    if (e) {
      persisted(e);
      this.store.persist();
    } else {
      runtime(this.store.runtime);
    }
  }
}
