import { findHidPath, isNullPtr, IS_MACOS } from './ffi/hidapi.js';
import { HidDeviceBase } from './devices/hid-connection.js';
import { debug, info, warn } from './logger.js';
import { formatCommHex } from './comm-format.js';
import { CLEAR_ALL_KEYS, DEFAULT_BRIGHTNESS, HID_REPORT_ID_BYTE } from './types.js';
import type { KeyEvent, KeyState } from './types.js';
import type { DeviceModel } from './devices/driver.js';
import {
  CMD_DIS,
  CMD_HAN,
  CMD_STP,
  CMD_CONNECT,
  CRT_DESCRIBERS,
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
  /** HID path this instance was opened with (path-based open only — see
   *  open()). Undefined on the VID/PID-fallback path (off-macOS only), or
   *  before open() completes. Used to derive a stable per-device identity
   *  (device-identity.ts) — NOT just for the open() call itself. */
  hidPath: string | undefined = undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastHeartbeatAt = 0;
  private pktSize = 1024;
  private reportId = HID_REPORT_ID_BYTE;
  // Reused scratch buffers (single-threaded worker), sized in open(): one image
  // chunk and one report-id-prefixed write frame. Avoids a fresh 1024 B + 1025 B
  // allocation per chunk per image (P5).
  private _chunkScratch: Buffer = Buffer.alloc(0);
  private _writeScratch: Buffer = Buffer.alloc(0);

  constructor(private readonly model: DeviceModel) {
    super();
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

  async open(hidPath?: string): Promise<void> {
    this.pktSize = this.model.wire!.packetSize;
    this.reportId = this.model.wire?.reportId ?? HID_REPORT_ID_BYTE;
    this._chunkScratch = Buffer.alloc(this.pktSize);
    this._writeScratch = Buffer.alloc(this.pktSize + 1);

    const hid = this._acquireLib();

    const vid = this.model.usbVendorId;
    const pids = this.model.usbProductIds;
    const usagePage = this.model.usagePage!;
    const usage = this.model.usage!;

    // Prefer path-based open (filters by usage_page/usage, same as node-hid).
    // hid_open(VID, PID) picks the first IOKit interface which may be system-claimed on macOS.
    // Explicit hidPath (multi-device: a specific unit) skips enumeration and
    // opens that exact interface. Absent → enumerate + open the first
    // usage-matched path (primary probe / single device).
    let dev: unknown = null;
    const path = hidPath ?? this.findDevicePath(vid, pids, usagePage, usage);
    if (path) {
      debug('hid', `hid_open_path(${path})`);
      dev = hid.hid_open_path(path);
      if (!isNullPtr(dev)) {
        debug('hid', 'hid_open_path succeeded');
        this.hidPath = path;
      } else if (IS_MACOS) {
        // Device is present (enumeration matched the vendor interface) but the
        // open was refused (e.g. half-seated cable, missing Input Monitoring).
        // Do NOT fall through to hid_open(VID/PID): on macOS that opens the
        // device's first IOKit interface — a keyboard/consumer collection — and
        // a permission-denied open of it SIGBUSes the whole process. Release the
        // IOHIDManager (so the host's worker.terminate() is safe) and fail
        // loudly so scheduleReconnect() keeps the app alive and retries.
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

    // Fall back to hid_open(VID, PID), off macOS only — one attempt per PID.
    // On macOS this opens the first IOKit interface (often a keyboard) and
    // segfaults on a denied/absent open, so the path-based open above is the
    // only safe route there; elsewhere it's a useful fallback when enumeration
    // found no usage-matched path. scheduleReconnect() in app.ts handles retries.
    // Only for the no-explicit-path case: with a targeted hidPath, a VID/PID
    // open could grab the WRONG (or the primary's) unit, so let it fail instead.
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
      // Release the IOHIDManager that hid_init() scheduled on this worker thread
      // (via hid_exit, no dlclose) so the host's worker.terminate() does not
      // SIGBUS — see _releaseLibAfterFailedOpen. The worker is terminated right
      // after this throw; scheduleReconnect() retries on a fresh worker.
      this._releaseLibAfterFailedOpen();
      throw new Error(
        `Mirabox device not found (VID=0x${vid.toString(16)} PIDs=${Array.from(pids).join(',')})`,
      );
    }
    info('hid', 'device opened successfully');
    this.device = dev;

    // Polling loop: hid_read_timeout blocks ≤5ms — safe on single-threaded event loop
    // because data is available immediately or not at all in practice.
    const inSize = this.model.wire!.inSize;
    this._startReadLoop(hid, inSize, 5, (readBuf, n) =>
      this.parseInput(Buffer.from(readBuf.subarray(0, n))),
    );

    const wire = this.model.wire!;

    this.write(this._buildCrt(CMD_DIS));
    this.write(this._buildLig(DEFAULT_BRIGHTNESS));
    this.write(this._buildCle(CLEAR_ALL_KEYS));
    if (wire.sendStpAfterImage) {
      this.write(this._buildCrt(CMD_STP));
    }

    const heartbeatMs = wire.heartbeatMs!;
    this.lastHeartbeatAt = Date.now();
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();
      const gap = now - this.lastHeartbeatAt;
      this.lastHeartbeatAt = now;
      if (gap > heartbeatMs * 2) {
        // Heartbeat was delayed (system sleep) — device may be in idle mode; re-initialize.
        info('hid', `sleep/wake detected (gap=${gap}ms) — re-initializing device`);
        this.write(this._buildCrt(CMD_DIS));
        this.write(this._buildLig(DEFAULT_BRIGHTNESS));
        this.write(this._buildCle(CLEAR_ALL_KEYS));
        if (wire.sendStpAfterImage) {
          this.write(this._buildCrt(CMD_STP));
        }
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

  sendImage(imageKeyId: number, jpeg: Uint8Array, chunkDelayMs = 0): void {
    if (!this.device || !this.hidLib) return;
    try {
      const wire = this.model.wire?.chunkPadByte ? padChunkBoundaries(jpeg, this.pktSize) : jpeg;
      this.write(this._buildBat(wire.length, imageKeyId));
      const chunk = this._chunkScratch;
      let offset = 0;
      while (offset < wire.length) {
        const len = Math.min(this.pktSize, wire.length - offset);
        if (len < this.pktSize) chunk.fill(0, len); // zero stale tail of last partial chunk
        chunk.set(wire.subarray(offset, offset + len));
        this.write(chunk);
        offset += this.pktSize;
        // Diagnostic only (k1pro-probe): pace chunks to test whether the
        // byte-1024 seam corruption is a device receive-timing overrun.
        if (chunkDelayMs > 0 && offset < wire.length) this._busyWait(chunkDelayMs);
      }
      this.write(this._buildCrt(CMD_STP));
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    }
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
    if (this.model.wire!.sendStpAfterImage) {
      this.write(this._buildCrt(CMD_STP));
    }
  }

  setBrightness(level: number): void {
    this.write(this._buildLig(level));
  }

  private describeWrite(pkt: Buffer): string {
    const isCrt = pkt[0] === 0x43 && pkt[1] === 0x52 && pkt[2] === 0x54;
    if (!isCrt) return 'image-data chunk';
    const cmd = String.fromCharCode(pkt[5] ?? 0, pkt[6] ?? 0, pkt[7] ?? 0);
    return this.describeCrtCmd(pkt, cmd);
  }

  private describeCrtCmd(pkt: Buffer, cmd: string): string {
    const b = (i: number): number => pkt[i] ?? 0;
    const describe = CRT_DESCRIBERS[cmd];
    if (describe) return describe(b);
    const full = String.fromCharCode(b(5), b(6), b(7), b(8), b(9), b(10), b(11));
    if (full === 'CONNECT') return 'CRT CONNECT (heartbeat)';
    return `CRT ${cmd}`;
  }

  private emitComm(human: string, data: Buffer, direction: 'rx' | 'tx' = 'tx'): void {
    const hex = formatCommHex(data);
    this.emit('comm', {
      direction,
      protocol: 'mirabox',
      component: 'mirabox',
      human,
      hex,
      totalBytes: data.length,
    });
  }

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
    this.emitComm(this.describeWrite(pkt), pkt, 'tx');
  }

  private parseInput(data: Buffer): void {
    const parsed = parseAckReport(data, this.reportId);
    if (!parsed) {
      this.emitComm('unknown input', data, 'rx');
      return;
    }
    const { keyIndex, stateByte } = parsed;

    if (this.model.wire!.synthesizeKeyUp) {
      // v1 only sends keydown; synthesize a keyup immediately after.
      this.emitComm(
        `ACK key=0x${keyIndex.toString(16).padStart(2, '0')} down (synthesized up)`,
        data,
        'rx',
      );
      this.emit('key', { keyIndex, state: 'down' } satisfies KeyEvent);
      this.emit('key', { keyIndex, state: 'up' } satisfies KeyEvent);
    } else {
      const state: KeyState = stateByte === 0x01 ? 'down' : 'up';
      this.emitComm(`ACK key=0x${keyIndex.toString(16).padStart(2, '0')} ${state}`, data, 'rx');
      this.emit('key', { keyIndex, state } satisfies KeyEvent);
    }
  }

  // Disconnect sequence written while the device is still open: CLE with DC
  // marker, then HAN. Both are report-id-prefixed like every Mirabox write.
  protected onBeforeClose(): void {
    if (!this.device || !this.hidLib) return;
    const hid = this.hidLib.symbols;
    try {
      const dcPkt = this._buildCleDc();
      const dcArr = new Uint8Array(dcPkt.length + 1);
      dcArr[0] = this.reportId;
      dcArr.set(dcPkt, 1);
      const dcN = hid.hid_write(this.device, dcArr, dcArr.length);
      debug('hid', `disconnect CLE-DC hid_write → ${dcN}`);

      const hanPkt = this._buildCrt(CMD_HAN);
      const hanArr = new Uint8Array(hanPkt.length + 1);
      hanArr[0] = this.reportId;
      hanArr.set(hanPkt, 1);
      const hanN = hid.hid_write(this.device, hanArr, hanArr.length);
      debug('hid', `disconnect HAN hid_write → ${hanN}`);
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
