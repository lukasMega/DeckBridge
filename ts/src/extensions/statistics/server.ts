// Statistics extension, worker side: turns dock events into SessionStats counters and
// serves them as GET /api/ext/statistics/snapshot.
import type {
  ExtensionEvent,
  ExtensionInput,
  ExtensionServerFactory,
} from '../../extension/api.js';
import { SessionStats } from './session-stats.js';

interface Layout {
  columns: number;
  extraKeys: readonly number[];
}

/** Grid keys read "R1 C2"; side keys "Extra 1" by their panel position. */
function keyLabel(layout: Layout, input: ExtensionInput): string | null {
  if (input.kind === 'key') {
    const row = Math.floor(input.mk2 / layout.columns) + 1;
    return `R${row} C${(input.mk2 % layout.columns) + 1}`;
  }
  if (input.kind === 'extraKey') {
    const pos = layout.extraKeys.indexOf(input.wireId);
    return `Extra ${pos < 0 ? input.wireId : pos + 1}`;
  }
  return null;
}

export function createStatistics(appStartedAt: number, now: () => number = Date.now) {
  // Counters follow each event's own time, not the batch's arrival.
  let eventAt: number | undefined;
  const stats = new SessionStats(appStartedAt, () => eventAt ?? now());
  const layouts = new Map<string, Layout>();

  function apply(e: ExtensionEvent): void {
    switch (e.type) {
      case 'deckAttached':
        layouts.set(e.deviceKey, { columns: Math.max(1, e.columns), extraKeys: e.extraKeys });
        stats.deckConnected(e.deviceKey, e.modelName, e.source, e.hasEncoders);
        break;
      case 'imageProcessed':
        stats.imageProcessed(e.deviceKey, e.cached);
        break;
      case 'input':
        applyInput(e.deviceKey, e.input);
        break;
    }
  }

  function applyInput(deviceKey: string, input: ExtensionInput): void {
    if (input.kind === 'dialPress') stats.dialPress(deviceKey, input.state);
    else if (input.kind === 'dialRotate') stats.dialRotate(deviceKey, input.delta);
    else if (input.kind !== 'touch') {
      const layout = layouts.get(deviceKey);
      const label = layout ? keyLabel(layout, input) : null;
      if (label !== null) stats.key(deviceKey, label, input.state);
    }
  }

  return {
    onEvents(events: readonly ExtensionEvent[]): void {
      for (const e of events) {
        eventAt = e.at;
        apply(e);
      }
      eventAt = undefined;
    },
    snapshot: () => stats.snapshot(),
  };
}

const statistics: ExtensionServerFactory = (ctx) => {
  const s = createStatistics(ctx.appStartedAt);
  return {
    onEvents: (events) => s.onEvents(events),
    handle(req) {
      if (req.method === 'GET' && req.path === 'snapshot') return { body: s.snapshot() };
      return { status: 404, body: { error: 'not found' } };
    },
  };
};

export default statistics;
