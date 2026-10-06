// A dock's page-following layout: the PageTracker plus the layout lookup the side-key
// widgets and press actions share, so dock.ts stays under the line gate.
import { log } from '../shared/logger.js';
import type { ExtraKeyConfig } from '../shared/types.js';
import { layoutConfigFor } from '../shared/page-config.js';
import type { PageObservation } from '../shared/page-match.js';
import { advertisedGeometry, advertisedModel } from '../devices/registry.js';
import type { DeviceModel } from '../devices/driver.js';
import type { DockPrefs } from '../infra/dock-prefs.js';
import { PageTracker } from './page-tracker.js';
import type { PageTrackerClock } from './page-tracker.js';

export interface DockPagesOptions {
  index: number;
  model: () => DeviceModel;
  /** Undefined before identity: no saved pages exist yet. */
  prefs: () => DockPrefs | undefined;
  /** Side-key / strip widgets must repaint (the active layout changed). */
  repaint: () => void;
  onObservation?: (obs: PageObservation) => void;
  clock?: PageTrackerClock;
}

export class DockPages {
  private readonly tracker: PageTracker;

  constructor(private readonly opts: DockPagesOptions) {
    let cached:
      | { model: DeviceModel; profile: string; keyCount: number; columns: number }
      | undefined;
    this.tracker = new PageTracker({
      pages: () => opts.prefs()?.pages() ?? [],
      geometry: () => {
        const model = opts.model();
        // Per-frame call: resolve the advertised model once per model object.
        if (cached?.model !== model) {
          const { keyCount, columns } = advertisedGeometry(model);
          cached = { model, profile: advertisedModel(model).id, keyCount, columns };
        }
        return cached;
      },
      onActiveChange: () => opts.repaint(),
      onObservation: opts.onObservation,
      log: (level, message) => log(level, 'pages', `dock ${opts.index}: ${message}`),
      clock: opts.clock,
    });
  }

  noteFrame(key: number, hash: string): void {
    this.tracker.noteFrame(key, hash);
  }

  /** The Elgato app left or the model changed: forget the frames, keep the layout. */
  reset(): void {
    this.tracker.reset();
  }

  /** Saved pages changed: re-match and repaint (a layout edit keeps the same page active). */
  reload(): void {
    if (!this.tracker.reload()) this.opts.repaint();
  }

  stop(): void {
    this.tracker.stop();
  }

  /** The config shown on `wireId` now: the active page's layout, else the default one. */
  layoutConfig(wireId: number): ExtraKeyConfig | undefined {
    const prefs = this.opts.prefs();
    if (!prefs) return undefined;
    return layoutConfigFor(this.tracker.activePage(), prefs.extraKeyConfigs(), wireId);
  }
}
