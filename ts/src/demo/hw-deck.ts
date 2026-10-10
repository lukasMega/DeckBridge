import type { DeviceModel } from '../devices/driver.js';
import { DEVICE_MODELS, findModel } from '../devices/registry.js';
import { HidTransport, hidFilters, reportLength } from '../webhid/transport.js';
import { HwSession } from '../webhid/hw-session.js';
import type { DeckEvents, DemoDeck } from './deck.js';
import type { FailReason, track } from './track.js';

export class HwDeck implements DemoDeck {
  readonly kind = 'hw';

  constructor(
    readonly model: DeviceModel,
    private readonly session: HwSession,
    private readonly onFailure: () => void,
  ) {}

  paintKey(index: number, icon: OffscreenCanvas | null): void {
    if (icon) void this.session.paint(index, icon).catch(this.onFailure);
  }
  paintStrip(zone: number, icon: OffscreenCanvas): void {
    void this.session.paintStrip(zone, icon).catch(this.onFailure);
  }
  setBrightness(level: number): void {
    this.session.setBrightness(level);
  }
  close(): Promise<void> {
    return this.session.close();
  }
}

export type HwConnection =
  | HwDeck
  | { unknown: { vid: number; pid: number } }
  | { fail: FailReason }
  | null;

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : '';
}

export function connectHwDeck(events: DeckEvents, tracker: typeof track): Promise<HwConnection> {
  const hid = navigator.hid;
  if (!hid) {
    tracker.hwUnsupported();
    return Promise.resolve(null);
  }
  let selection: Promise<HIDDevice[]>;
  try {
    // Keep chooser invocation inside the originating button click.
    selection = hid.requestDevice({ filters: hidFilters(DEVICE_MODELS) });
  } catch (error) {
    const reason = errorName(error) === 'SecurityError' ? 'denied' : 'open';
    tracker.hwFail(reason);
    return Promise.resolve({ fail: reason });
  }
  return selection.then(
    async (devices): Promise<HwConnection> => {
      const device =
        devices.find((candidate) => {
          const model = findModel(candidate.vendorId, candidate.productId);
          if (!model) return false;
          const id = model.protocol.startsWith('elgato-') ? 2 : (model.wire.reportId ?? 0);
          return reportLength(candidate, 'output', id) !== null;
        }) ?? devices[0];
      if (!device) return null;
      const model = findModel(device.vendorId, device.productId);
      if (!model) {
        tracker.hwUnknown(device.vendorId, device.productId);
        return { unknown: { vid: device.vendorId, pid: device.productId } };
      }
      let writeFailed = false;
      let ready = false;
      let lost = false;
      function fail(): void {
        if (writeFailed) return;
        writeFailed = true;
        tracker.hwFail('write');
        if (ready && !lost) {
          lost = true;
          events.lost('write');
        }
      }
      const transport = new HidTransport(device, fail, hid);
      const session = new HwSession(device, model, transport);
      session.onKey(events.key);
      session.onDial((event) => events.dial?.(event));
      session.onTouch((event) => events.touch?.(event));
      transport.onLost(() => {
        if (lost) return;
        lost = true;
        tracker.hwFail('disconnect');
        if (ready) events.lost('disconnect');
      });
      try {
        await session.open();
        if (writeFailed || lost) {
          await session.close().catch(() => undefined);
          return { fail: writeFailed ? 'write' : 'disconnect' };
        }
        ready = true;
        tracker.hwConnected(model.id);
        return new HwDeck(model, session, fail);
      } catch (error) {
        await session.close().catch(() => undefined);
        const reason = errorName(error) === 'SecurityError' ? 'denied' : 'open';
        tracker.hwFail(reason);
        return { fail: reason };
      }
    },
    (error): HwConnection => {
      if (errorName(error) === 'NotFoundError') return null;
      const reason = errorName(error) === 'SecurityError' ? 'denied' : 'open';
      tracker.hwFail(reason);
      return { fail: reason };
    },
  );
}
