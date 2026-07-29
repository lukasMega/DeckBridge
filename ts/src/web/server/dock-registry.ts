// Tracks the live per-dock status list + which dock is selected, and resolves per-dock
// deviceKey/brightness against it (settings.devices[] keyed by deviceKey).
import type { PersistedSettings } from './persisted-settings.js';
import type { DockStatus } from '../../types.js';
import { DEFAULT_BRIGHTNESS } from '../../types.js';

export class DockRegistry {
  private docks: DockStatus[] = [];

  constructor(private readonly settings: PersistedSettings) {}

  get selectedDock(): number {
    return this.settings.selectedDock;
  }
  set selectedDock(index: number) {
    this.settings.selectedDock = index;
  }

  list(): DockStatus[] {
    return this.docks;
  }

  has(index: number): boolean {
    return this.docks.some((d) => d.index === index);
  }

  /** Replace the dock list; false (no-op) if unchanged — the 2s reconnect scan calls this every
   *  tick and an unchanged shape must not spam a broadcast. */
  update(docks: DockStatus[]): boolean {
    if (JSON.stringify(docks) === JSON.stringify(this.docks)) return false;
    this.docks = docks;
    return true;
  }

  /** The selected dock's status entry, falling back to dock[0]. */
  selectedStatus(): DockStatus | undefined {
    return this.docks.find((d) => d.index === this.selectedDock) ?? this.docks[0];
  }

  /** deviceKey of the dock at `index`; the selected dock falls back to dock[0]. '' = unknown/mock. */
  deviceKeyFor(index: number): string {
    const dock =
      index === this.selectedDock
        ? this.selectedStatus()
        : this.docks.find((d) => d.index === index);
    return dock?.deviceKey ?? '';
  }

  selectedDeviceKey(): string {
    return this.deviceKeyFor(this.selectedDock);
  }

  selectedBrightness(): number {
    return this.selectedStatus()?.brightness ?? DEFAULT_BRIGHTNESS;
  }

  brightnessFor(index: number): number {
    return this.settings.entryFor(this.deviceKeyFor(index))?.brightness ?? DEFAULT_BRIGHTNESS;
  }
}
