// A dock's info window (Ulanzi D200 wide key): pushes the persisted config to the driver
// and routes the window's presses.
import type { DeviceModel, DockDriver } from '../devices/driver.js';
import type { DockPrefs } from '../infra/dock-prefs.js';
import {
  DEFAULT_WIDE_KEY,
  hasWideWindow,
  wideKeyFirmwareMode,
  wideKeyWire,
  wideWindowElgato,
} from '../shared/wide-key.js';
import type { ExtraKeyConfig, WideKeyPress } from '../shared/types.js';

/** `storedOnly`: attach pushes only an explicit entry, so a dock with none keeps sending
 *  exactly what it always did. A live change pushes the resolved config either way, so
 *  removing the entry (a settings import) puts the default back. A unit that reports a
 *  D200X (slot 13 is a real key there) gets nothing: the firmware default stays. Returns
 *  the Elgato cells the window composes, which the caller replays into the worker. */
export function pushWideKey(
  driver: DockDriver,
  model: DeviceModel,
  prefs: DockPrefs | undefined,
  storedOnly: boolean,
  deviceType?: string,
): readonly number[] {
  const page = model.page;
  const wire = wideKeyWire(model);
  if (!prefs || !page || wire === undefined || !driver.setSmallWindow) return [];
  if (!hasWideWindow(model, deviceType)) return [];
  if (storedOnly && prefs.wideKeyStored() === undefined) return [];
  const cfg = prefs.wideKey();
  driver.setSmallWindow(wideKeyFirmwareMode(cfg, page), cfg.hourFormat);
  const { cells, show } = wideWindowElgato(cfg);
  driver.setWideWindow?.(wire, cells, show);
  return cells;
}

/** When the info window shows the Elgato app's images instead of its widget: always under
 *  content 'elgato'; under 'override' until `overrideMs` passes with no new source frame. */
export class WideKeyElgato {
  private lastFrameAt: number | undefined;

  constructor(
    private readonly model: () => DeviceModel,
    private readonly prefs: () => DockPrefs | undefined,
  ) {}

  /** A CORA frame reached the device. */
  noteFrame(keyIndex: number, nowMs: number): void {
    const cfg = this.prefs()?.wideKey();
    if (cfg && wideWindowElgato(cfg).cells.includes(keyIndex)) this.lastFrameAt = nowMs;
  }

  /** True = `wireId` is the window and it shows Elgato images now: no widget paints there. */
  yields(wireId: number, nowMs: number): boolean {
    const cfg = this.prefs()?.wideKey();
    if (!cfg || wireId !== wideKeyWire(this.model())) return false;
    if (cfg.content === 'elgato') return true;
    if (!wideWindowElgato(cfg).show || this.lastFrameAt === undefined) return false;
    return nowMs - this.lastFrameAt < cfg.overrideMs;
  }
}

/** Elgato cell (MK.2 index) each press value forwards the window to. */
const ELGATO_CELL: Partial<Record<WideKeyPress, number>> = { 'elgato-13': 13, 'elgato-14': 14 };

/** The widget config a painter reads for `wireId`. The info window's widget is only painted
 *  while the window shows it (content 'widget'): in every other mode the firmware owns the
 *  panel and the driver would drop the image anyway. The press side reads the config
 *  ungated (Q1: a press action does not depend on the content). */
export function paintedConfig(
  model: DeviceModel,
  prefs: DockPrefs | undefined,
  wireId: number,
  config: ExtraKeyConfig | undefined,
): ExtraKeyConfig | undefined {
  if (wireId !== wideKeyWire(model)) return config;
  return prefs?.wideKey().content === 'widget' ? config : undefined;
}

/** `model` with the window's input routed per `press`: exactly one of an Elgato cell, the
 *  wire-id extra key (DeckBridge action) or nothing. Pure; the registry model stays as it
 *  is, so this is never a model override. */
export function withWideKeyPress(model: DeviceModel, press: WideKeyPress): DeviceModel {
  const wire = wideKeyWire(model);
  const inputMap = model.keyMap.wireInputToCora;
  if (wire === undefined || !inputMap) return model;
  const wireInputToCora = [...inputMap];
  while (wireInputToCora.length <= wire) wireInputToCora.push(-1);
  wireInputToCora[wire] = ELGATO_CELL[press] ?? -1;
  const extraKeys = [...(model.keyMap.extraKeys ?? [])];
  let at = extraKeys.indexOf(wire);
  if (at < 0 && press === 'deckbridge') at = extraKeys.push(wire) - 1;
  // Parallel to extraKeys; -1 = no switch (a device code is never negative).
  const extraKeyInputs = extraKeys.map((_, i) => model.keyMap.extraKeyInputs?.[i] ?? -1);
  if (at >= 0) extraKeyInputs[at] = press === 'deckbridge' ? wire : -1;
  return { ...model, keyMap: { ...model.keyMap, wireInputToCora, extraKeys, extraKeyInputs } };
}

/** The model a dock's key decoder reads. `wireCommonDriverEvents` calls it per event, like
 *  live key-map tuning, so a changed `press` applies at the next press with no reopen. */
export class WideKeyInput {
  private last: { base: DeviceModel; press: WideKeyPress; routed: DeviceModel } | undefined;

  constructor(private readonly prefs: () => DockPrefs | undefined) {}

  model(base: DeviceModel): DeviceModel {
    if (!base.page) return base;
    const press = this.prefs()?.wideKey().press ?? DEFAULT_WIDE_KEY.press;
    if (this.last?.base !== base || this.last.press !== press) {
      this.last = { base, press, routed: withWideKeyPress(base, press) };
    }
    return this.last.routed;
  }
}
