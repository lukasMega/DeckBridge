// WebHID copy of MiraboxDriver's packet sequencing (the desktop driver stays separate
// to keep the worker lean). test/core-replay.test.ts pins both to the same fixtures.
import { DEFAULT_BRIGHTNESS } from '../../shared/types.js';
import { CLEAR_ALL_KEYS, HID_REPORT_ID_BYTE } from '../mirabox/protocol.js';
import type { KeyEvent } from '../../shared/types.js';
import type { DeviceModel } from '../driver.js';
import {
  CMD_DIS,
  CMD_HAN,
  CMD_STP,
  CMD_CONNECT,
  buildCrt,
  buildBat,
  padChunkBoundaries,
  buildLig,
  buildCle,
  buildCleDc,
  parseAckReport,
} from '../mirabox/protocol.js';

import type { ReportSink } from './types.js';

export class MiraboxCore {
  private pktSize: number;
  private reportIdByte = HID_REPORT_ID_BYTE;
  private imageBatch = false;
  private pendingStp = false;
  private asleep = false;
  // Wake restores brightness; reinit still uses default brightness.
  private lastLevel = DEFAULT_BRIGHTNESS;
  // Synchronous sinks allow scratch reuse between writes.
  private _chunkScratch: Buffer = Buffer.alloc(0);
  private _writeScratch: Buffer = Buffer.alloc(0);

  constructor(
    private readonly model: DeviceModel,
    private readonly out: ReportSink,
  ) {
    this.pktSize = model.wire.packetSize;
    this.reset();
  }

  get packetSize(): number {
    return this.pktSize;
  }
  get reportId(): number {
    return this.reportIdByte;
  }

  reset(): void {
    this.reportIdByte = this.model.wire.reportId ?? HID_REPORT_ID_BYTE;
    this.asleep = false;
    this.setPacketSize(this.model.wire.packetSize);
  }

  setPacketSize(n: number): void {
    this.pktSize = n;
    this._chunkScratch = Buffer.alloc(n);
    this._writeScratch = Buffer.alloc(n + 1);
  }

  /** Bring the panel to a known state: DIS, brightness, clear all. Sent on open, and
   *  again after a sleep/wake gap (the device may have dropped into idle mode). */
  init(): void {
    // DIS wakes the panel, so a later setSleep(true) must send HAN again.
    this.asleep = false;
    this.write(buildCrt(CMD_DIS, [], this.pktSize));
    this.write(buildLig(DEFAULT_BRIGHTNESS, this.pktSize));
    this.write(buildCle(CLEAR_ALL_KEYS, this.pktSize));
    if (this.model.wire.sendStpAfterImage) {
      this.write(buildCrt(CMD_STP, [], this.pktSize));
    }
  }

  private lastHeartbeatAt = 0;

  startClock(now: number): void {
    this.lastHeartbeatAt = now;
  }

  heartbeat(now: number): boolean {
    const reinit = now - this.lastHeartbeatAt > this.model.wire.heartbeatMs! * 2;
    this.lastHeartbeatAt = now;
    if (reinit) this.init();
    this.write(buildCrt(CMD_CONNECT, [], this.pktSize));
    return reinit;
  }

  sendImage(
    imageKeyId: number,
    jpeg: Uint8Array,
    busyWait?: (ms: number) => void,
    chunkDelayMs?: number,
  ): void {
    const delayMs = chunkDelayMs ?? this.model.wire.chunkDelayMs ?? 0;
    const wire = this.model.wire.chunkPadByte ? padChunkBoundaries(jpeg, this.pktSize) : jpeg;
    this.write(buildBat(wire.length, imageKeyId, this.pktSize));
    const chunk = this._chunkScratch;
    for (let offset = 0; offset < wire.length; offset += this.pktSize) {
      const len = Math.min(this.pktSize, wire.length - offset);
      if (len < this.pktSize) chunk.fill(0, len);
      chunk.set(wire.subarray(offset, offset + len));
      this.write(chunk);
      if (delayMs > 0 && offset + this.pktSize < wire.length) busyWait?.(delayMs);
    }
    if (this.imageBatch) this.pendingStp = true;
    else this.write(buildCrt(CMD_STP, [], this.pktSize));
  }

  beginBatch(): void {
    this.imageBatch = true;
  }

  endBatch(): void {
    this.imageBatch = false;
    if (!this.pendingStp) return;
    this.pendingStp = false;
    this.write(buildCrt(CMD_STP, [], this.pktSize));
  }

  clearKey(imageKeyId: number): void {
    this.write(buildCle(imageKeyId, this.pktSize));
    if (this.model.wire.sendStpAfterImage) {
      this.write(buildCrt(CMD_STP, [], this.pktSize));
    }
  }

  setBrightness(level: number): void {
    this.lastLevel = level;
    this.write(buildLig(level, this.pktSize));
  }

  /** HAN screen-off; DIS + LIG wakes it. Gated on the model so unverified boards never get HAN. */
  setSleep(asleep: boolean): void {
    if (this.model.sleep !== 'mirabox-han' || asleep === this.asleep) return;
    this.asleep = asleep;
    if (asleep) {
      this.write(buildCrt(CMD_HAN, [], this.pktSize));
    } else {
      this.write(buildCrt(CMD_DIS, [], this.pktSize));
      this.write(buildLig(this.lastLevel, this.pktSize));
    }
  }

  closeReports(): Uint8Array[] {
    return [buildCleDc(this.pktSize), buildCrt(CMD_HAN, [], this.pktSize)].map((pkt) => {
      const report = new Uint8Array(pkt.length + 1);
      report[0] = this.reportId;
      report.set(pkt, 1);
      return report;
    });
  }

  parseInput(data: Uint8Array): KeyEvent[] | null {
    const parsed = parseAckReport(Buffer.from(data), this.reportId);
    if (!parsed) return null;
    const { keyIndex, stateByte } = parsed;
    if (this.model.wire.synthesizeKeyUp) {
      return [
        { keyIndex, state: 'down' },
        { keyIndex, state: 'up' },
      ];
    }
    return [{ keyIndex, state: stateByte === 0x01 ? 'down' : 'up' }];
  }

  private write(pkt: Buffer): void {
    if (pkt.length !== this.pktSize) {
      throw new Error(`Packet must be ${this.pktSize} bytes, got ${pkt.length}`);
    }
    // Mirabox framing: prepend the report-id byte. Reuse _writeScratch — hid_write
    // copies synchronously into the OS HID stack, so it's free to reuse next call.
    const arr = this._writeScratch;
    arr[0] = this.reportId;
    arr.set(pkt, 1);
    this.out(arr);
  }
}
