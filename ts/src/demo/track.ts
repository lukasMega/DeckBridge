import { findModelById } from '../devices/registry.js';

export type FailReason = 'denied' | 'open' | 'write' | 'disconnect';
interface Beacon {
  trackEvent(event: string, target?: string): void;
}

function defaultBeacon(): Beacon | undefined {
  try {
    return (window.parent as Window & { __da?: Beacon }).__da;
  } catch {
    return undefined;
  }
}

export function createTracker(getBeacon: () => Beacon | undefined) {
  const sent = new Set<string>();
  function send(target: string): void {
    if (sent.has(target)) return;
    sent.add(target);
    try {
      getBeacon()?.trackEvent('demo', target);
    } catch {
      // Analytics must never interrupt the demo.
    }
  }
  function modelTarget(kind: 'mock' | 'hw', modelId: string): void {
    if (findModelById(modelId)) send(`${kind}:${modelId}`);
  }
  return {
    mockModel(modelId: string): void {
      modelTarget('mock', modelId);
    },
    hwConnected(modelId: string): void {
      modelTarget('hw', modelId);
    },
    hwUnknown(vid: number, pid: number): void {
      if (![vid, pid].every((id) => Number.isInteger(id) && id >= 0 && id <= 0xffff)) return;
      send(`hw:unknown:${vid.toString(16).padStart(4, '0')}:${pid.toString(16).padStart(4, '0')}`);
    },
    hwUnsupported(): void {
      send('hw:unsupported');
    },
    hwFail(reason: FailReason): void {
      send(`hw:fail:${reason}`);
    },
  };
}

export const track = createTracker(defaultBeacon);
