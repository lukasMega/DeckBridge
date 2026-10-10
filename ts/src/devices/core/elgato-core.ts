// WebHID copy of ElgatoHidDriver's packet sequencing (the desktop driver stays separate
// to keep the worker lean). test/core-replay.test.ts pins both to the same fixtures.
import type { DeviceModel } from '../driver.js';
import type { KeyEvent } from '../../shared/types.js';
import { PROTOCOL_STRATEGY, type ProtocolStrategy } from '../protocol/index.js';
import type { ReportSink } from './types.js';

export class ElgatoCore {
  private readonly strategy: ProtocolStrategy;
  private lastKeyState: boolean[] = [];
  private pktScratch = new Uint8Array(0);
  private blankImage: Uint8Array | undefined;

  constructor(
    private readonly model: DeviceModel,
    private readonly out: { write: ReportSink; sendFeature: ReportSink },
  ) {
    this.strategy = PROTOCOL_STRATEGY[model.protocol]!;
  }

  init(): void {
    this.lastKeyState = Array.from({ length: this.model.keyCount }, () => false);
    this.out.sendFeature(this.strategy.resetReport());
  }

  sendImage(keyIndex: number, bytes: Uint8Array): void {
    if (this.pktScratch.length !== this.model.wire.packetSize) {
      this.pktScratch = new Uint8Array(this.model.wire.packetSize);
    }
    this.strategy.writeImage(keyIndex, bytes, this.pktScratch, this.out.write);
  }

  clearKey(keyIndex: number): void {
    this.blankImage ??= this.strategy.blankImage(this.model.keyWidth, this.model.keyHeight);
    this.sendImage(keyIndex, this.blankImage);
  }

  setBrightness(level: number): void {
    this.out.sendFeature(this.strategy.brightnessReport(level));
  }

  parseInput(data: Uint8Array): KeyEvent[] {
    const states = this.strategy.parseInput(data, this.model.keyCount);
    const events: KeyEvent[] = [];
    if (!states) return events;
    for (const { keyIndex, pressed } of states) {
      if (pressed !== (this.lastKeyState[keyIndex] ?? false)) {
        this.lastKeyState[keyIndex] = pressed;
        events.push({ keyIndex, state: pressed ? 'down' : 'up' });
      }
    }
    return events;
  }

  close(): void {
    this.out.sendFeature(this.strategy.resetReport());
  }
}
