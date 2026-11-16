/** Ulanzi Stream Controller D200 driver (page protocol).
 *
 *  Unlike every other DeckBridge driver, this one cannot write a single key: the
 *  firmware repaints the grid from a ZIP archive. sendImage() therefore stages
 *  into UlanziPage, and a debounced flush builds and ships the page.
 *
 *  Runs on the USB worker thread only — a full page is ~180 synchronous HID
 *  writes, which must never touch the main thread's CORA ACK loop (P1).
 *
 *  NOT HARDWARE-TESTED. See .claude/plans/2026-09-10_ulanzi-d200-support.md
 *  (Phase B is the bring-up runbook) and docs/references.md. */

import { HidDeviceBase } from '../hid-device-base.js';
import { debug, info, warn } from '../../shared/logger.js';
import { DEFAULT_BRIGHTNESS } from '../../shared/types.js';
import type { KeyEvent } from '../../shared/types.js';
import { HID_REPORT_ID_BYTE } from '../mirabox/protocol.js';
import type { DeviceModel, DevicePageSpec } from '../driver.js';
import {
  CMD,
  DEFAULT_FONT,
  buildChunks,
  buildPacket,
  describeIncoming,
  describeOutgoing,
  encodeBrightness,
  encodeSmallWindow,
  formatClock,
  parseIncoming,
} from './ulanzi-protocol.js';
import { UlanziPage, FlushScheduler, splitBySize } from './ulanzi-page.js';
import { buildSafePageZip } from './ulanzi-zip.js';
import type { PageBatch } from './ulanzi-page.js';

/** How long open() lets the read loop run before the first page. Hardware-proved
 *  ordering (aleyvag §4.4): send the clock, DRAIN the 0x0303 device-info reply
 *  and the heartbeats, and only then the first ZIP. Skip the drain and the
 *  firmware ACKs the archive with 0x010b and silently renders nothing. */
const HANDSHAKE_DRAIN_MS = 250;

/** Read poll interval, matching MiraboxDriver. */
const READ_POLL_MS = 5;

/** A 1×1 all-black PNG (grayscale, stored deflate). Used by clearKey: a
 *  ViewParam with no Icon leaves the previous pixmap on screen, and the firmware
 *  renders an undersized icon as a solid square of its colour — which is exactly
 *  the "key is off" look we want. */
const BLACK_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x00, 0x00, 0x00, 0x00, 0x3a, 0x7e, 0x9b,
  0x55, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x01, 0x01, 0x02, 0x00, 0xfd, 0xff,
  0x00, 0x00, 0x00, 0x02, 0x00, 0x01, 0x7e, 0x05, 0x0d, 0xd2, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
  0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

export class UlanziDriver extends HidDeviceBase {
  private readonly page: UlanziPage;
  private readonly scheduler: FlushScheduler;
  private readonly spec: DevicePageSpec;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private lastKeepaliveAt = 0;
  private flushSeq = 0;
  /** Running total of boundary-byte rebuilds. If this stays at 0 on hardware,
   *  the workaround in ulanzi-zip.ts can be deleted (plan O8). */
  private padRetryTotal = 0;
  private brightness = DEFAULT_BRIGHTNESS;
  private _writeScratch: Buffer = Buffer.alloc(0);

  constructor(readonly model: DeviceModel) {
    super();
    this.spec = model.page!;
    this.page = new UlanziPage(this.spec.partialUpdates);
    this.scheduler = new FlushScheduler(
      { debounceMs: this.spec.flushDebounceMs, minIntervalMs: this.spec.minFlushIntervalMs },
      () => this.flush(),
    );
  }

  async open(hidPath: string): Promise<void> {
    this._writeScratch = Buffer.alloc(this.model.wire.packetSize + 1);
    // Discovery matched usagePage/usage, so this is interface 0 (Consumer 0x0c /
    // usage 0x01), not the boot-keyboard collection whose writes time out.
    const hid = this._openPath(hidPath);
    info('hid', 'device opened successfully');

    this._startReadLoop(hid, this.model.wire.inSize, READ_POLL_MS, (readBuf, n) =>
      this.parseInput(readBuf.subarray(0, n)),
    );

    await this.handshake();
    this.startKeepalive();
  }

  /** Ordering is load-bearing: clock → drain the device's replies → unlock →
   *  brightness → first full page. See HANDSHAKE_DRAIN_MS. */
  private async handshake(): Promise<void> {
    this.sendClock();
    await new Promise((resolve) => setTimeout(resolve, HANDSHAKE_DRAIN_MS));
    this.sendUnlock();
    this.setBrightness(this.brightness);
    // Establish the grid immediately, even with no images yet: this replaces the
    // Ulanzi logo screen and installs the info-window entry.
    this.writePage(this.page.takeBatch() ?? { slots: [], full: true });
  }

  private startKeepalive(): void {
    const keepaliveMs = this.spec.keepaliveMs;
    this.lastKeepaliveAt = Date.now();
    this.keepaliveTimer = setInterval(() => {
      const now = Date.now();
      const gap = now - this.lastKeepaliveAt;
      this.lastKeepaliveAt = now;
      if (gap > keepaliveMs * 2) {
        // The timer was starved (system sleep). The firmware blanks back to its
        // own screen after ~10 s of silence, so nothing on the panel is ours any
        // more — redo the init writes and repaint the whole remembered page.
        info('hid', `sleep/wake detected (gap=${gap}ms) — re-initializing device`);
        this.sendClock();
        this.sendUnlock();
        this.setBrightness(this.brightness);
        this.page.restoreAll();
        this.scheduler.schedule();
        this.emit('reinit');
        return;
      }
      // ANY outbound write resets the firmware's watchdog; the clock frame is
      // the cheapest one that also keeps the info window ticking.
      this.sendClock();
    }, keepaliveMs);
  }

  /** Our close() sends LOCK, and the panel stays locked until UNLOCK (jcalado
   *  FIRMWARE.md) — without this a second session shows nothing until a replug. */
  private sendUnlock(): void {
    this.writePacket(buildPacket(CMD.UNLOCK, 0));
  }

  private sendClock(): void {
    const payload = encodeSmallWindow({
      mode: this.spec.smallWindowMode,
      time: formatClock(new Date()),
    });
    this.writePacket(buildPacket(CMD.SMALL_WINDOW, payload.length, payload));
  }

  close(): Promise<void> {
    this._cleanup();
    return Promise.resolve();
  }

  /** keyIndex here is the device slot id (image-render.ts has already mapped the
   *  CORA index through keyMap.coraToWireImage and dropped the -1 holes). */
  sendImage(slotId: number, png: Uint8Array): void {
    if (!this.device || !this.hidLib || !this.isKeySlot(slotId)) return;
    if (this.page.stage(slotId, png)) this.scheduler.schedule();
  }

  clearKey(slotId: number): void {
    if (!this.device || !this.hidLib || !this.isKeySlot(slotId)) return;
    if (this.page.stage(slotId, BLACK_PNG)) this.scheduler.schedule();
  }

  /** Real LCD keys only: a staged hole or the info-window slot would land in the manifest. */
  private isKeySlot(slotId: number): boolean {
    return this.model.keyMap.coraToWireImage?.includes(slotId) === true && slotId >= 0;
  }

  setBrightness(level: number): void {
    this.brightness = level;
    const payload = encodeBrightness(level);
    this.writePacket(buildPacket(CMD.BRIGHTNESS, payload.length, payload));
  }

  /** Build and ship whatever is staged. Errors are reported, not thrown: the
   *  batch stays dirty and the next staged image retries it. */
  private flush(): void {
    if (!this.device || !this.hidLib) return;
    const batch = this.page.takeBatch();
    if (!batch) return;
    try {
      // SET_BUTTONS replaces the grid, so only the first group may use it; the
      // rest merge in via PARTIAL_UPDATE. Without partial updates there is no
      // safe way to split, so the page goes out whole.
      const groups = splitBySize(batch.slots, this.spec.partialUpdates ? this.spec.maxZipBytes : 0);
      groups.forEach((slots, i) => {
        this.writePage({ slots, full: batch.full && i === 0 });
      });
      this.page.onFlushed(batch);
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  }

  private writePage(batch: PageBatch): void {
    const t0 = Date.now();
    const { zip, retries, safe } = buildSafePageZip(batch.slots, {
      columns: this.model.columns,
      smallWindowMode: this.spec.smallWindowMode,
      smallWindowSlot: this.spec.smallWindowSlot,
      font: DEFAULT_FONT,
      flushSeq: this.flushSeq++,
    });
    if (retries > 0) {
      this.padRetryTotal += retries;
      debug(
        'hid',
        `page ZIP needed ${retries} boundary-byte pad retries (total ${this.padRetryTotal})`,
      );
    }
    if (!safe) {
      // Sent anyway — see buildSafePageZip. If pages tear on hardware, this line
      // is the first thing to look for in the log.
      warn('hid', 'page ZIP has an unsafe chunk-boundary byte — sending it regardless');
    }
    if (this.spec.maxZipBytes > 0 && zip.length > this.spec.maxZipBytes) {
      // Oversized archives are dropped SILENTLY by (at least) the Qt firmware
      // generation — there is no error to catch, so warn rather than guess.
      warn(
        'hid',
        `page ZIP is ${zip.length} B, over this model's ${this.spec.maxZipBytes} B cap — ` +
          `the firmware may drop it silently`,
      );
    }
    const cmd = batch.full ? CMD.SET_BUTTONS : CMD.PARTIAL_UPDATE;
    const packets = buildChunks(cmd, zip);
    const delayMs = this.spec.chunkDelayMs ?? 0;
    const t1 = Date.now();
    let failed = 0;
    // A failed chunk still lets the rest go out: the firmware counts bytes against the
    // header length, and a short upload would swallow the next page as its tail.
    for (let i = 0; i < packets.length; i++) {
      if (!this.writePacket(packets[i]!)) failed++;
      if (delayMs > 0 && i < packets.length - 1) this._busyWait(delayMs);
    }
    if (failed > 0) throw new Error(`page upload: ${failed}/${packets.length} writes failed`);
    info(
      'hid',
      `page ${batch.full ? 'full' : 'partial'}: ${batch.slots.length} slots, ` +
        `${zip.length} B in ${packets.length} packets ` +
        `(png ${batch.slots.reduce((n, s) => n + (s.png?.length ?? 0), 0)} B, ` +
        `zip ${t1 - t0} ms, write ${Date.now() - t1} ms)`,
    );
  }

  // Blocking spin-wait between chunks — the device sees the same inter-transfer
  // gap as a real sleep, without threading an async path through the sync write
  // loop. Mirrors MiraboxDriver._busyWait.
  private _busyWait(ms: number): void {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      /* spin */
    }
  }

  /** False when hid_write failed (already logged by _writeRaw). */
  private writePacket(pkt: Buffer): boolean {
    if (pkt.length !== this.model.wire.packetSize) {
      throw new Error(`Packet must be ${this.model.wire.packetSize} bytes, got ${pkt.length}`);
    }
    if (!this.device || !this.hidLib) return false;
    // hidapi wants the report-id byte in front of every write, exactly as on the
    // Mirabox path — the D200's reports are unnumbered, so it is 0x00.
    const arr = this._writeScratch;
    arr[0] = HID_REPORT_ID_BYTE;
    arr.set(pkt, 1);
    const n = this._writeRaw(arr, 'hid', (r, errStr) => `hid_write returned ${r}: ${errStr}`);
    // Framed packets only: a page's ~180 raw chunks would bury the log.
    if (pkt[0] === 0x7c && pkt[1] === 0x7c) debug('hid', `tx ${describeOutgoing(pkt)}`);
    return n >= 0;
  }

  private parseInput(data: Uint8Array): void {
    const parsed = parseIncoming(data);
    // Heartbeats arrive ~1 Hz; logging every one would drown the comm log.
    if (parsed?.kind !== 'heartbeat') debug('hid', `rx ${describeIncoming(parsed)}`);
    if (!parsed) return;

    if (parsed.kind === 'info') {
      // Log the identity JSON verbatim on every open: it names the firmware
      // generation (Qt/RK3308 vs EasyUI/SSD210) and whether the unit is really a
      // D200X, which is the first thing any bug report from the other generation
      // needs. See the plan's "Two firmware generations behind one VID:PID".
      info('hid', `device info: ${parsed.json}`);
      return;
    }
    if (parsed.kind !== 'button') return;

    // The wide info-window slot reports presses too (category 0x00). It maps to
    // -1 in keyMap.wireInputToCora, so device-session drops it; emit uniformly.
    this.emit('key', {
      keyIndex: parsed.slotId,
      state: parsed.pressed ? 'down' : 'up',
    } satisfies KeyEvent);
  }

  /** Lock the panel on the way out so it dims instead of holding a stale page.
   *  Deliberately NOT 0x0004 — that kills the display app until a replug. */
  protected onBeforeClose(): void {
    if (!this.device || !this.hidLib) return;
    try {
      const pkt = buildPacket(CMD.LOCK, 0);
      const arr = new Uint8Array(pkt.length + 1);
      arr[0] = HID_REPORT_ID_BYTE;
      arr.set(pkt, 1);
      const n = this.hidLib.symbols.hid_write(this.device, arr, arr.length);
      debug('hid', `disconnect LOCK hid_write → ${n}`);
    } catch (e: unknown) {
      warn('hid', `error during disconnect sequence: ${String(e)}`);
    }
  }

  protected _cleanup(): void {
    debug('hid', '_cleanup: starting');
    this.scheduler.cancel();
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    this.page.reset();
    this._stopReadTimer();
    this._closeDevice();
    const exitRet = this._teardownLib();
    if (exitRet !== null) debug('hid', `hid_exit() → ${exitRet}`);
    debug('hid', '_cleanup: done');
  }
}
