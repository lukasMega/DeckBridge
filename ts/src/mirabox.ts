import { findHidPath, isNullPtr, IS_MACOS } from './ffi/hidapi.js';
import type { HidapiSymbols } from './ffi/hidapi.js';
import { probeOutputReportSize } from './devices/hid-report-descriptor.js';
import { HidDeviceBase } from './devices/hid-connection.js';
import { debug, info, warn } from './logger.js';
import { CLEAR_ALL_KEYS, DEFAULT_BRIGHTNESS, HID_REPORT_ID_BYTE } from './types.js';
import type { KeyEvent, KeyState } from './types.js';
import type { DeviceModel } from './devices/driver.js';
import { supportsImageBatching } from './devices/driver.js';
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
} from './devices/mirabox-protocol.js';

export { parseAckReport, buildCrt, buildBat, padChunkBoundaries, buildLig, buildCle, buildCleDc };

export class MiraboxDriver extends HidDeviceBase {
  /** HID path this instance was opened with (path-based open only — see open()). Undefined on
   * the VID/PID-fallback path (off-macOS only), or before open() completes. Used to derive a
   * stable per-device identity (device-identity.ts) — NOT just for the open() call itself. */
  hidPath: string | undefined = undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastHeartbeatAt = 0;
  private pktSize: number;
  private reportId = HID_REPORT_ID_BYTE;
  private imageBatch = false;
  private pendingStp = false;
  // Reused scratch buffers (single-threaded worker), sized in open(): one image
  // chunk and one report-id-prefixed write frame. Avoids a fresh 1024 B + 1025 B
  // allocation per chunk per image (P5).
  private _chunkScratch: Buffer = Buffer.alloc(0);
  private _writeScratch: Buffer = Buffer.alloc(0);

  constructor(private readonly model: DeviceModel) {
    super();
    this.pktSize = model.wire.packetSize;
  }

  private _buildCrt(cmd: number[], extra: number[] = []): Buffer {
    return buildCrt(cmd, extra, this.pktSize);
  }

  private _buildBat(jpegLen: number, keyId: number): Buffer {
    return buildBat(jpegLen, keyId, this.pktSize);
  }

  private _buildLig(brightness: number): Buffer {
    return buildLig(brightness, this.pktSize);
  }

  private _buildCle(keyId: number): Buffer {
    return buildCle(keyId, this.pktSize);
  }

  private _buildCleDc(): Buffer {
    return buildCleDc(this.pktSize);
  }

  /** Find the HID path for this model, filtering by each of its PIDs in turn.
   *  PID filtering disambiguate models that share VID+usage (e.g. K1 Pro vs 293). */
  private findDevicePath(
    vid: number,
    pids: readonly number[],
    usagePage: number,
    usage: number,
  ): string | null {
    for (const pid of pids) {
      const path = findHidPath(vid, usagePage, usage, pid);
      if (path) return path;
    }
    return null;
  }

  /** Replace `pktSize` (and the buffers sized from it) with the output-report size the
   *  device declares — only for models setting `wire.packetSizeCandidates`, and only
   *  when the report descriptor is unambiguous and agrees on one candidate. Mutates
   *  `pktSize`, so open() re-seeds it from the model on every (re)connect. */
  private _adoptProbedPacketSize(hid: HidapiSymbols, dev: unknown): void {
    const candidates = this.model.wire.packetSizeCandidates;
    if (!candidates) return;
    const probed = probeOutputReportSize(hid, dev, candidates);
    if (probed === null || probed === this.pktSize) return;
    warn(
      'hid',
      `packet size corrected from the report descriptor: model says ${this.pktSize} B, ` +
        `device reports ${probed} B — using ${probed}`,
    );
    this.pktSize = probed;
    this._chunkScratch = Buffer.alloc(this.pktSize);
    this._writeScratch = Buffer.alloc(this.pktSize + 1);
  }

  /** Bring the panel to a known state: DIS, brightness, clear all. Sent on open, and
   *  again after a sleep/wake gap (the device may have dropped into idle mode). */
  private _writeInitSequence(): void {
    this.write(this._buildCrt(CMD_DIS));
    this.write(this._buildLig(DEFAULT_BRIGHTNESS));
    this.write(this._buildCle(CLEAR_ALL_KEYS));
    if (this.model.wire.sendStpAfterImage) {
      this.write(this._buildCrt(CMD_STP));
    }
  }

  async open(hidPath?: string): Promise<void> {
    this.pktSize = this.model.wire.packetSize;
    this.reportId = this.model.wire.reportId ?? HID_REPORT_ID_BYTE;
    this._chunkScratch = Buffer.alloc(this.pktSize);
    this._writeScratch = Buffer.alloc(this.pktSize + 1);

    const hid = this._acquireLib();

    const vid = this.model.usbVendorId;
    const pids = this.model.usbProductIds;
    const usagePage = this.model.usagePage!;
    const usage = this.model.usage!;

    // Prefer path-based open (filters by usage_page/usage, same as node-hid):
    // hid_open(VID, PID) picks the first IOKit interface, which macOS may have claimed.
    // An explicit hidPath (a specific unit) skips enumeration; absent → enumerate and
    // open the first usage-matched path.
    let dev: unknown = null;
    const path = hidPath ?? this.findDevicePath(vid, pids, usagePage, usage);
    if (path) {
      debug('hid', `hid_open_path(${path})`);
      dev = hid.hid_open_path(path);
      if (!isNullPtr(dev)) {
        debug('hid', 'hid_open_path succeeded');
        this.hidPath = path;
      } else if (IS_MACOS) {
        // Present (enumeration matched) but open refused — half-seated cable, missing
        // Input Monitoring. Do NOT fall through to hid_open(VID/PID): on macOS that
        // opens the first IOKit interface (keyboard/consumer collection) and a denied
        // open of it SIGBUSes. Release IOHIDManager so worker.terminate() is safe, then
        // fail loudly and let scheduleReconnect() retry.
        this._releaseLibAfterFailedOpen();
        throw new Error(
          `device present but hid_open_path failed (path=${path}). On macOS this is ` +
            `almost always a missing Input Monitoring permission — grant it to your ` +
            `terminal app (or the tjs binary) under System Settings → Privacy & Security → ` +
            `Input Monitoring, then restart that app.`,
        );
      } else {
        warn('hid', 'hid_open_path returned null — falling back to hid_open(VID/PID)');
      }
    }

    // Fall back to hid_open(VID, PID), off macOS only (there it opens the first IOKit
    // interface, often a keyboard, and segfaults on a denied/absent open; elsewhere it
    // covers enumeration finding no usage-matched path). No-explicit-path case only —
    // with a targeted hidPath a VID/PID open could grab the wrong unit.
    if (isNullPtr(dev) && !IS_MACOS && hidPath === undefined) {
      for (const pid of pids) {
        debug('hid', `hid_open(vid=0x${vid.toString(16)}, pid=0x${pid.toString(16)})`);
        dev = hid.hid_open(vid, pid, null);
        if (!isNullPtr(dev)) {
          debug('hid', `hid_open succeeded pid=0x${pid.toString(16)}`);
          break;
        }
      }
    }

    if (isNullPtr(dev)) {
      // Release the IOHIDManager that hid_init() scheduled on this worker thread (via hid_exit, no
      // dlclose) so the host's worker.terminate() does not SIGBUS — see _releaseLibAfterFailedOpen.
      // The worker is terminated right after this throw; scheduleReconnect() retries on a fresh worker.
      this._releaseLibAfterFailedOpen();
      throw new Error(
        `Mirabox device not found (VID=0x${vid.toString(16)} PIDs=${Array.from(pids).join(',')})`,
      );
    }
    info('hid', 'device opened successfully');
    this.device = dev;

    // Let the device correct our packet-size guess, for models that opted in. Must run
    // before the first write below: every CRT command is packet-size framed, and getting
    // it wrong produces no error at all — just a black panel.
    this._adoptProbedPacketSize(hid, dev);

    // Polling loop: hid_read_timeout blocks ≤5ms — safe on single-threaded event loop
    // because data is available immediately or not at all in practice.
    const inSize = this.model.wire.inSize;
    this._startReadLoop(hid, inSize, 5, (readBuf, n) =>
      this.parseInput(Buffer.from(readBuf.subarray(0, n))),
    );

    const wire = this.model.wire;

    this._writeInitSequence();

    const heartbeatMs = wire.heartbeatMs!;
    this.lastHeartbeatAt = Date.now();
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();
      const gap = now - this.lastHeartbeatAt;
      this.lastHeartbeatAt = now;
      if (gap > heartbeatMs * 2) {
        // Heartbeat was delayed (system sleep) — device may be in idle mode; re-initialize.
        info('hid', `sleep/wake detected (gap=${gap}ms) — re-initializing device`);
        this._writeInitSequence();
        // The CLE ALL above wiped everything on the panel — let the main
        // thread repaint what it owns (extra-key icons; see extra-keys.ts).
        this.emit('reinit');
      }
      this.write(this._buildCrt(CMD_CONNECT));
    }, heartbeatMs);
    await Promise.resolve();
  }

  close(): Promise<void> {
    this._cleanup();
    return Promise.resolve();
  }

  sendImage(imageKeyId: number, jpeg: Uint8Array, chunkDelayMs?: number): void {
    if (!this.device || !this.hidLib) return;
    // An explicit argument (k1pro-probe) wins; otherwise the model supplies the
    // pacing — see DeviceWireSpec.chunkDelayMs.
    const delayMs = chunkDelayMs ?? this.model.wire.chunkDelayMs ?? 0;
    try {
      const wire = this.model.wire.chunkPadByte ? padChunkBoundaries(jpeg, this.pktSize) : jpeg;
      this.write(this._buildBat(wire.length, imageKeyId));
      const chunk = this._chunkScratch;
      let offset = 0;
      while (offset < wire.length) {
        const len = Math.min(this.pktSize, wire.length - offset);
        if (len < this.pktSize) chunk.fill(0, len); // zero stale tail of last partial chunk
        chunk.set(wire.subarray(offset, offset + len));
        this.write(chunk);
        offset += this.pktSize;
        // Pace chunks: diagnostic for the k1pro-probe (does the byte-1024 seam
        // corruption come from a device receive-timing overrun?), and a per-model
        // knob for boards that drop back-to-back chunks.
        if (delayMs > 0 && offset < wire.length) this._busyWait(delayMs);
      }
      if (this.imageBatch) this.pendingStp = true;
      else this.write(this._buildCrt(CMD_STP));
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** Only enabled 293S-family models may defer per-image STP framing. */
  beginImageBatch(): void {
    this.imageBatch =
      supportsImageBatching(this.model) && this.model.wire.batchImageTransfers === true;
  }

  endImageBatch(): void {
    this.imageBatch = false;
    if (!this.pendingStp) return;
    this.pendingStp = false;
    this.write(this._buildCrt(CMD_STP));
  }

  // Blocking spin-wait — diagnostic pacing between HID writes. The device sees
  // the same inter-transfer gap as a real sleep; busy-wait avoids threading an
  // async path through the sync write loop.
  private _busyWait(ms: number): void {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      /* spin */
    }
  }

  clearKey(imageKeyId: number): void {
    this.write(this._buildCle(imageKeyId));
    if (this.model.wire.sendStpAfterImage) {
      this.write(this._buildCrt(CMD_STP));
    }
  }

  setBrightness(level: number): void {
    this.write(this._buildLig(level));
  }

  // Comm tracing (the human-readable write/read descriptions the 'comm' event carries)
  // is a no-op here: hid-worker never forwards 'comm' out of the worker thread, so a real
  // device has no listener to ever satisfy. d6-capture.ts's CaptureDriver overrides these
  // two hooks to get real tracing when run as a standalone dev probe.

  protected traceWrite(_pkt: Buffer): void {}

  protected traceRead(_human: string, _data: Buffer): void {}

  private write(pkt: Buffer): void {
    if (pkt.length !== this.pktSize) {
      throw new Error(`Packet must be ${this.pktSize} bytes, got ${pkt.length}`);
    }
    if (!this.device || !this.hidLib) return;
    // Mirabox framing: prepend the report-id byte. Reuse _writeScratch — hid_write
    // copies synchronously into the OS HID stack, so it's free to reuse next call.
    const arr = this._writeScratch;
    arr[0] = this.reportId;
    arr.set(pkt, 1);
    this._writeRaw(arr, 'hid', (n, errStr) => `hid_write returned ${n}: ${errStr}`);
    this.traceWrite(pkt);
  }

  private parseInput(data: Buffer): void {
    const parsed = parseAckReport(data, this.reportId);
    if (!parsed) {
      this.traceRead('unknown input', data);
      return;
    }
    const { keyIndex, stateByte } = parsed;

    if (this.model.wire.synthesizeKeyUp) {
      // v1 only sends keydown; synthesize a keyup immediately after.
      this.traceRead(
        `ACK key=0x${keyIndex.toString(16).padStart(2, '0')} down (synthesized up)`,
        data,
      );
      this.emit('key', { keyIndex, state: 'down' } satisfies KeyEvent);
      this.emit('key', { keyIndex, state: 'up' } satisfies KeyEvent);
    } else {
      const state: KeyState = stateByte === 0x01 ? 'down' : 'up';
      this.traceRead(`ACK key=0x${keyIndex.toString(16).padStart(2, '0')} ${state}`, data);
      this.emit('key', { keyIndex, state } satisfies KeyEvent);
    }
  }

  // Disconnect sequence written while the device is still open: CLE with DC
  // marker, then HAN. Both are report-id-prefixed like every Mirabox write.
  protected onBeforeClose(): void {
    if (!this.device || !this.hidLib) return;
    const hid = this.hidLib.symbols;
    // Raw hid_write rather than write(): teardown logs each return code and must not
    // take write()'s error path or comm tracing on a handle that is about to close.
    const send = (label: string, pkt: Buffer): void => {
      const arr = new Uint8Array(pkt.length + 1);
      arr[0] = this.reportId;
      arr.set(pkt, 1);
      const n = hid.hid_write(this.device, arr, arr.length);
      debug('hid', `disconnect ${label} hid_write → ${n}`);
    };
    try {
      send('CLE-DC', this._buildCleDc());
      send('HAN', this._buildCrt(CMD_HAN));
    } catch (e: unknown) {
      warn('hid', `error during disconnect sequence: ${String(e)}`);
    }
    debug('hid', 'hid_close');
  }

  protected _cleanup(): void {
    debug('hid', '_cleanup: starting');
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this._stopReadTimer();
    this._closeDevice();
    const exitRet = this._teardownLib();
    if (exitRet !== null) debug('hid', `hid_exit() → ${exitRet}`);
    debug('hid', '_cleanup: done');
  }
}
