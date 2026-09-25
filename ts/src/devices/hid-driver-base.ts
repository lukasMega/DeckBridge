/** Shared HID plumbing for Elgato gen1/gen2 devices.
 *  Handles open, read-loop, serialized writes, feature reports, and disconnect.
 *  Runs on a worker thread; blocking hid_write never stalls the main loop. */
import { error } from '../logger.js';
import { findHidPath, isNullPtr, IS_MACOS } from '../ffi/hidapi.js';
import { hidErrorString } from '../ffi/wide-string.js';
import type { HidapiSymbols } from '../ffi/hidapi.js';
import { HidDeviceBase } from './hid-connection.js';
import type { DeviceModel } from './driver.js';
import type { KeyState } from '../types.js';
import { PROTOCOL_STRATEGY, type InfoReport, type ProtocolStrategy } from './protocol';

const READ_POLL_MS = 5;

function nullTerm(s: string): string {
  return s.split('\0')[0]!.trim();
}

export class ElgatoHidDriver extends HidDeviceBase {
  readonly model: DeviceModel;
  private readonly strategy: ProtocolStrategy;
  private lastKeyState: boolean[] = [];
  deviceSerial: string | undefined = undefined;
  deviceFirmware: string | undefined = undefined;
  /** HID path this instance was opened with (path-based open only). Used to
   *  derive a stable per-device identity (device-identity.ts). */
  hidPath: string | undefined = undefined;
  /** Reused output-report buffer, sized on first sendImage (see sendImage). */
  private _pktScratch: Uint8Array = new Uint8Array(0);
  /** Built on first clearKey, then kept: a gen1 blank is a ~19 KB allocation and
   *  clearKey runs on the USB worker thread. */
  private _blankImage: Uint8Array | undefined = undefined;
  /** Bound once so sendImage doesn't allocate a closure per image. */
  private readonly _writeBound = (pkt: Uint8Array): void => this._write(pkt);

  constructor(model: DeviceModel) {
    super();
    this.model = model;
    this.strategy = PROTOCOL_STRATEGY[model.protocol]!;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async open(hidPath?: string): Promise<void> {
    const hid = this._acquireLib();

    // An explicit hidPath (multi-device: a specific unit) opens that exact
    // interface; otherwise enumerate + open the first usage-matched path.
    const path =
      hidPath ??
      (this.model.usagePage !== undefined && this.model.usage !== undefined
        ? findHidPath(this.model.usbVendorId, this.model.usagePage, this.model.usage)
        : null);

    let dev: unknown = null;
    if (path) {
      dev = hid.hid_open_path(path);
      if (!isNullPtr(dev)) {
        this.hidPath = path;
      } else if (IS_MACOS) {
        // Never fall through to hid_open(VID/PID) on macOS: it opens the first IOKit
        // interface and a denied open SIGBUSes (see mirabox.ts).
        this._releaseLibAfterFailedOpen();
        throw new Error(
          `device present but hid_open_path failed (path=${path}). On macOS this is ` +
            `almost always a missing Input Monitoring permission — grant it to your ` +
            `terminal app (or the tjs binary) under System Settings → Privacy & Security → ` +
            `Input Monitoring, then restart that app.`,
        );
      }
    }

    // VID/PID fallback: off macOS, and only without a targeted hidPath (it could
    // grab the WRONG unit).
    if (isNullPtr(dev) && !IS_MACOS && hidPath === undefined) {
      for (const pid of this.model.usbProductIds) {
        const d = hid.hid_open(this.model.usbVendorId, pid, null);
        if (!isNullPtr(d)) {
          dev = d;
          break;
        }
      }
    }

    if (isNullPtr(dev)) {
      // Release the IOHIDManager (hid_exit, no dlclose) so the host's
      // worker.terminate() after this throw does not SIGBUS on macOS — see
      // _releaseLibAfterFailedOpen.
      this._releaseLibAfterFailedOpen();
      throw new Error(
        `${this.model.name} not found (VID=0x${this.model.usbVendorId.toString(16)} PIDs=${this.model.usbProductIds.map((p) => '0x' + p.toString(16)).join(',')})`,
      );
    }

    this.device = dev;
    this._readDeviceInfo();
    this.lastKeyState = Array.from({ length: this.model.keyCount }, () => false);

    this._startReadLoop(hid, this.model.wire.inSize, READ_POLL_MS, (readBuf, n) =>
      this._parseInput(readBuf.subarray(0, n)),
    );

    // Send reset-to-logo on connect so stale images are cleared.
    this._sendFeatureReport(this._resetReport());
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async close(): Promise<void> {
    this._cleanup();
  }

  sendImage(keyIndex: number, bytes: Uint8Array): void {
    if (!this.device || !this.hidLib) return;
    // Reused scratch, allocated once per driver (as MiraboxDriver does): a fresh
    // 1024 B buffer per chunk was ~10 KB of garbage per key, per frame.
    if (this._pktScratch.length !== this.model.wire.packetSize) {
      this._pktScratch = new Uint8Array(this.model.wire.packetSize);
    }
    this.strategy.writeImage(keyIndex, bytes, this._pktScratch, this._writeBound);
  }

  clearKey(keyIndex: number): void {
    this._blankImage ??= this.strategy.blankImage(this.model.keyWidth, this.model.keyHeight);
    this.sendImage(keyIndex, this._blankImage);
  }

  setBrightness(level: number): void {
    this._sendFeatureReport(this.strategy.brightnessReport(level));
  }

  private _write(buf: Uint8Array): void {
    this._writeRaw(buf, 'elgato-hid', (_n, err) => `hid_write error: ${err}`);
  }

  private _sendFeatureReport(buf: Uint8Array): void {
    if (!this.device || !this.hidLib) return;
    const n = this.hidLib.symbols.hid_send_feature_report(this.device, buf, buf.length);
    if (n < 0) {
      const err = hidErrorString(this.hidLib.symbols, this.device);
      error('elgato-hid', `hid_send_feature_report error: ${err}`);
    }
  }

  private _parseInput(data: Uint8Array): void {
    const states = this.strategy.parseInput(data, this.model.keyCount);
    if (!states) return;

    for (const { keyIndex, pressed } of states) {
      const prev = this.lastKeyState[keyIndex] ?? false;
      if (pressed !== prev) {
        this.lastKeyState[keyIndex] = pressed;
        const state: KeyState = pressed ? 'down' : 'up';
        this.emit('key', { keyIndex, state });
      }
    }
  }

  private _resetReport(): Uint8Array {
    return this.strategy.resetReport();
  }

  private _readDeviceInfo(): void {
    if (!this.device || !this.hidLib) return;
    const hid = this.hidLib.symbols;
    const { serial, firmware } = this.strategy.infoReports;
    const buf = new Uint8Array(32);
    try {
      this.deviceSerial = this._readInfoString(hid, buf, serial) ?? this.deviceSerial;
      this.deviceFirmware = this._readInfoString(hid, buf, firmware) ?? this.deviceFirmware;
    } catch {
      // Feature report read failure must not abort open()
    }
  }

  /** Read one ASCII device-info feature report into the shared `buf`. Undefined
   *  when the device returns fewer bytes than the value's offset. */
  private _readInfoString(
    hid: HidapiSymbols,
    buf: Uint8Array,
    report: InfoReport,
  ): string | undefined {
    buf.fill(0);
    buf[0] = report.reportId;
    const n = hid.hid_get_feature_report(this.device, buf, buf.length);
    if (n <= report.offset) return undefined;
    const end = report.lengthPrefixed ? report.offset + Math.min(buf[1]!, n - report.offset) : n;
    return nullTerm(String.fromCharCode(...buf.slice(report.offset, end)));
  }

  // Reset-to-logo so stale images are cleared while the device is still open.
  protected onBeforeClose(): void {
    this._sendFeatureReport(this._resetReport());
  }

  protected _cleanup(): void {
    this._stopReadTimer();
    this._closeDevice();
    this._teardownLib();
  }
}
