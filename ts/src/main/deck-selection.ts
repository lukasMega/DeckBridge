// Which of the detected USB decks may run. Pure over the discovery snapshot, so the primary
// probe, the dock scanner and the WebUI picker all agree on one key per physical unit.
import type { DeviceModel } from '../devices/driver.js';
import { DEVICE_MODELS } from '../devices/registry.js';
import { deviceKeyFor, sharedSerialModelId } from '../infra/device-identity.js';
import { MAX_DETECTED_DECKS } from '../shared/types.js';
import type { DetectedDeck } from '../shared/types.js';
import type { HidDiscovery } from './driver-manager-discovery.js';

export interface DetectedUnit {
  key: string;
  name: string;
  serial: string | null;
  hidPath: string;
}

/** The same key a dock gets once it opens this unit (dock-scanner.ts, resolveRealDeviceIdentity). */
export function unitKey(discovery: HidDiscovery, model: DeviceModel, hidPath: string): string {
  return deviceKeyFor(hidPath, discovery.serial(hidPath), sharedSerialModelId(model));
}

/** Every supported unit in the last scan, capped at MAX_DETECTED_DECKS. Registry order, then
 *  path order, so the list (and the "first decks found" default) is stable between ticks. */
export function detectUnits(
  discovery: HidDiscovery,
  models: readonly DeviceModel[] = DEVICE_MODELS,
): DetectedUnit[] {
  const out: DetectedUnit[] = [];
  for (const model of models) {
    for (const hidPath of discovery.paths(model).toSorted((a, b) => a.localeCompare(b))) {
      out.push({
        key: unitKey(discovery, model, hidPath),
        name: model.name,
        serial: discovery.serial(hidPath),
        hidPath,
      });
    }
  }
  return out.slice(0, MAX_DETECTED_DECKS);
}

/** A unit may run unless the user's choice names other detected decks. A choice that matches
 *  nothing seen (unplugged decks, or a volatile path key) is ignored: it must never leave
 *  every deck locked out. */
export function deckAllowed(
  key: string,
  selected: readonly string[],
  detected: readonly DetectedUnit[],
): boolean {
  if (!selected.some((k) => detected.some((d) => d.key === k))) return true;
  return selected.includes(key);
}

const signature = (units: DetectedUnit[]): string => units.map((u) => u.key).join('|');

/** The manager's selection state: last scan, the user's choice, and whether multi-deck is on. */
export class DeckSelection {
  multiDeck = false;
  selected: string[] = [];
  private detected: DetectedUnit[] = [];

  /** Re-read the discovery snapshot; true when the set of decks changed. */
  refresh(discovery: HidDiscovery): boolean {
    const next = detectUnits(discovery);
    if (signature(next) === signature(this.detected)) return false;
    this.detected = next;
    return true;
  }

  /** Selection only matters with multi-deck on; off keeps the first-found single deck. */
  keyAllowed(key: string): boolean {
    return !this.multiDeck || deckAllowed(key, this.selected, this.detected);
  }

  unitAllowed(discovery: HidDiscovery, model: DeviceModel, hidPath: string): boolean {
    return this.keyAllowed(unitKey(discovery, model, hidPath));
  }

  view(isActive: (key: string) => boolean): DetectedDeck[] {
    return this.detected.map((u) => ({
      key: u.key,
      name: u.name,
      ...(u.serial ? { serial: u.serial } : {}),
      active: isActive(u.key),
    }));
  }
}
