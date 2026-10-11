// Dock hooks -> SessionStats: one place that knows how a dock event becomes a counter.
import { VIRTUAL_DOCK_INDEX } from '../shared/types.js';
import { advertisedGeometry } from '../devices/registry.js';
import type { SessionStats } from '../web/server/session-stats.js';
import type { Dock } from './dock.js';
import type { DockHooks } from './dock-types.js';
import { physicalEncoderCount } from './dock-status.js';

type DeckSource = Parameters<SessionStats['deckConnected']>[2];

/** Stats hooks for dock `index`. The Dock is looked up per event: dock 0 outlives
 *  its devices, so a replug may bring a different deck. */
export function statsHooks(
  stats: SessionStats,
  index: number,
  dockAt: () => Dock | undefined,
): Pick<DockHooks, 'attached' | 'input' | 'imageSent'> {
  return {
    attached(mock) {
      const dock = dockAt();
      if (!dock?.identity) return;
      let source: DeckSource = index === VIRTUAL_DOCK_INDEX ? 'browser' : 'usb';
      if (mock) source = 'mock';
      stats.deckConnected(
        dock.identity.deviceKey,
        dock.model.name,
        source,
        physicalEncoderCount(dock.model) > 0,
      );
    },
    input(input) {
      const dock = dockAt();
      const key = dock?.identity?.deviceKey ?? '';
      if (!dock || key === '') return;
      switch (input.kind) {
        case 'key': {
          const columns = advertisedGeometry(dock.model).columns;
          const row = Math.floor(input.mk2 / columns) + 1;
          stats.key(key, `R${row} C${(input.mk2 % columns) + 1}`, input.state);
          break;
        }
        case 'extraKey': {
          const pos = dock.model.keyMap.extraKeys?.indexOf(input.wireId) ?? -1;
          stats.key(key, `Extra ${pos < 0 ? input.wireId : pos + 1}`, input.state);
          break;
        }
        case 'dialPress':
          stats.dialPress(key, input.state);
          break;
        case 'dialRotate':
          stats.dialRotate(key, input.delta);
          break;
        default:
          break; // touch: phase 2
      }
    },
    imageSent(_keyIndex, cached) {
      stats.imageProcessed(dockAt()?.identity?.deviceKey ?? '', cached);
    },
  };
}
