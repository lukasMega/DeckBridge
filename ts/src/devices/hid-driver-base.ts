/** Shared HID plumbing for Elgato gen1/gen2 devices.
 *  Handles open, read-loop, serialized writes, feature reports, and disconnect.
 *  Runs on a worker thread; blocking hid_write never stalls the main loop. */
import { error } from '../logger.js';
import { findHidPath, isNullPtr } from '../ffi/hidapi.js';
import type { HidapiSymbols } from '../ffi/hidapi.js';
import { HidDeviceBase } from './hid-connection.js';
import type { DeviceModel } from './driver.js';
import type { KeyState } from '../types.js';
import { PROTOCOL_STRATEGY, type ProtocolStrategy } from './protocol';

const READ_BUF_SIZE = 512;
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

  constructor(model: DeviceModel) {
    super();
    this.model = model;
    this.strategy = PROTOCOL_STRATEGY[model.protocol]!;
  }

  /** Open the device by path. An explicit `hidPath` (multi-device: a specific
   *  unit) opens that exact interface; otherwise enumerate + open the first
   *  usage-matched path. Records this.hidPath on success. Null if not opened. */
  private _openByPath(hid: HidapiSymbols, hidPath?: string): unknown {
    const path =
      hidPath ??
      (this.model.usagePage !== undefined && this.model.usage !== undefined
        ? findHidPath(this.model.usbVendorId, this.model.usagePage, this.model.usage)
        : null);
    if (!path) return null;
    const opened = hid.hid_open_path(path);
    if (isNullPtr(opened)) return null;
    this.hidPath = path;
    return opened;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async open(hidPath?: string): Promise<void> {
    const hid = this._acquireLib();

    let dev = this._openByPath(hid, hidPath);

    // Only for the no-explicit-path case: with a targeted hidPath, a VID/PID
    // open could grab the WRONG unit, so let it fail instead.
    if (!dev && hidPath === undefined) {
      for (const pid of this.model.usbProductIds) {
        const d = hid.hid_open(this.model.usbVendorId, pid, null);
        if (!isNullPtr(d)) {
          dev = d;
          break;
        }
      }
    }

    if (!dev) {
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

    this._startReadLoop(hid, READ_BUF_SIZE, READ_POLL_MS, (readBuf, n) =>
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
    const packets = this.strategy.packImage(keyIndex, bytes);
    for (const pkt of packets) {
      this._write(pkt);
    }
  }

  clearKey(keyIndex: number): void {
    // Send a solid-black image for this key.
    if (this.model.protocol === 'elgato-gen1') {
      const bmpSize = 54 + this.model.keyWidth * this.model.keyHeight * 3;
      const blank = new Uint8Array(bmpSize); // all zeros → black BMP pixels
      this.sendImage(keyIndex, blank);
    } else {
      // Minimal 1×1 black JPEG (upscaled to the key size by firmware)
      const TINY_BLACK_JPEG = new Uint8Array([
        0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00,
        0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x08, 0x06, 0x06, 0x07, 0x06,
        0x05, 0x08, 0x07, 0x07, 0x07, 0x09, 0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b,
        0x0c, 0x19, 0x12, 0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20,
        0x24, 0x2e, 0x27, 0x20, 0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29, 0x2c, 0x30, 0x31,
        0x34, 0x34, 0x34, 0x1f, 0x27, 0x39, 0x3d, 0x38, 0x32, 0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff,
        0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00,
        0x1f, 0x00, 0x00, 0x01, 0x05, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b,
        0xff, 0xc4, 0x00, 0xb5, 0x10, 0x00, 0x02, 0x01, 0x03, 0x03, 0x02, 0x04, 0x03, 0x05, 0x05,
        0x04, 0x04, 0x00, 0x00, 0x01, 0x7d, 0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21,
        0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08,
        0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a,
        0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35, 0x36, 0x37,
        0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56,
        0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75,
        0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x93, 0x94,
        0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa,
        0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7,
        0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3,
        0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
        0xf9, 0xfa, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0xfb, 0x00, 0xff,
        0xd9,
      ]);
      this.sendImage(keyIndex, TINY_BLACK_JPEG);
    }
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
      const err = this.hidLib.symbols.hid_error(this.device) ?? 'unknown';
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
    try {
      if (this.model.protocol === 'elgato-gen1') {
        this._readGen1Info(hid);
      } else if (this.model.protocol === 'elgato-gen2') {
        this._readGen2Info(hid);
      }
    } catch {
      // Feature report read failure must not abort open()
    }
  }

  private _readGen1Info(hid: HidapiSymbols): void {
    const buf = new Uint8Array(32);
    // serial: report 0x03, ASCII at offset 5
    buf[0] = 0x03;
    const n = hid.hid_get_feature_report(this.device, buf, 32);
    if (n > 5) this.deviceSerial = nullTerm(String.fromCharCode(...buf.slice(5, n)));
    // firmware: report 0x04, ASCII at offset 5
    buf.fill(0);
    buf[0] = 0x04;
    const n2 = hid.hid_get_feature_report(this.device, buf, 32);
    if (n2 > 5) this.deviceFirmware = nullTerm(String.fromCharCode(...buf.slice(5, n2)));
  }

  private _readGen2Info(hid: HidapiSymbols): void {
    const buf = new Uint8Array(32);
    // serial: report 0x06, length byte at byte 1, data from byte 2
    buf[0] = 0x06;
    const n = hid.hid_get_feature_report(this.device, buf, 32);
    if (n > 2) {
      this.deviceSerial = nullTerm(
        String.fromCharCode(...buf.slice(2, 2 + Math.min(buf[1]!, n - 2))),
      );
    }
    // firmware: report 0x05, ASCII at offset 6, length-prefixed at byte 1
    buf.fill(0);
    buf[0] = 0x05;
    const n2 = hid.hid_get_feature_report(this.device, buf, 32);
    if (n2 > 6) {
      this.deviceFirmware = nullTerm(
        String.fromCharCode(...buf.slice(6, 6 + Math.min(buf[1]!, n2 - 6))),
      );
    }
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
