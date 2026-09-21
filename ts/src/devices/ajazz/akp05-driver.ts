import { findHidPath, isNullPtr, IS_MACOS } from '../../ffi/hidapi.js';
import { HidDeviceBase } from '../hid-connection.js';
import { debug, error, info } from '../../logger.js';
import type { DeviceModel } from '../driver.js';
import {
  buildBat,
  buildLig,
  buildUlend,
  buildVer,
  describePacket,
  imageChunks,
  parseVersionReport,
} from './akp05-protocol.js';

const BLACK_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/Aaf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/Aaf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Aqf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z',
  'base64',
);

export class Akp05Driver extends HidDeviceBase {
  hidPath: string | undefined;
  firmware: string | undefined;
  private writeScratch = Buffer.alloc(1025);

  constructor(readonly model: DeviceModel) {
    super();
  }

  async open(hidPath?: string): Promise<void> {
    const hid = this._acquireLib();
    const path = hidPath ?? this.findDevicePath();
    let device: unknown = null;
    if (path) {
      device = hid.hid_open_path(path);
      if (!isNullPtr(device)) this.hidPath = path;
      else if (IS_MACOS) {
        this._releaseLibAfterFailedOpen();
        throw new Error(`device present but hid_open_path failed (path=${path})`);
      }
    }
    if (isNullPtr(device) && !IS_MACOS && hidPath === undefined) {
      device = hid.hid_open(this.model.usbVendorId, this.model.usbProductIds[0]!, null);
    }
    if (isNullPtr(device)) {
      this._releaseLibAfterFailedOpen();
      throw new Error(
        `${this.model.name} not found (VID=0x${this.model.usbVendorId.toString(16)} PIDs=${this.model.usbProductIds.map((p) => '0x' + p.toString(16)).join(',')})`,
      );
    }

    this.device = device;
    this._startReadLoop(hid, this.model.wire.inSize, 5, (data, n) => {
      const report = Buffer.from(data.subarray(0, n));
      const firmware = parseVersionReport(report);
      if (firmware) this.firmware = firmware;
    });
    this.write(buildVer());
    info('hid', 'AKP05E opened; sent CRT VER only');
    await Promise.resolve();
  }

  close(): Promise<void> {
    this._cleanup();
    return Promise.resolve();
  }

  sendImage(keyIndex: number, jpeg: Uint8Array): void {
    const surfaceId = this.model.keyMap.coraToWireImage?.[keyIndex];
    if (surfaceId === undefined) {
      this.emit('error', new RangeError(`AKP05E key index out of range: ${keyIndex}`));
      return;
    }
    try {
      this.write(buildBat(jpeg.length, surfaceId));
      for (const chunk of imageChunks(jpeg)) this.write(chunk);
      this.write(buildUlend());
    } catch (cause) {
      this.emit('error', cause instanceof Error ? cause : new Error(String(cause)));
    }
  }

  clearKey(keyIndex: number): void {
    this.sendImage(keyIndex, BLACK_JPEG);
  }

  setBrightness(level: number): void {
    this.write(buildLig(level));
  }

  private findDevicePath(): string | null {
    for (const productId of this.model.usbProductIds) {
      const path = findHidPath(
        this.model.usbVendorId,
        this.model.usagePage!,
        this.model.usage!,
        productId,
      );
      if (path) return path;
    }
    return null;
  }

  private write(packet: Buffer): void {
    if (packet.length !== 1024)
      throw new Error(`AKP05 packet must be 1024 bytes, got ${packet.length}`);
    if (!this.device || !this.hidLib) return;
    this.writeScratch[0] = 0;
    this.writeScratch.set(packet, 1);
    const result = this._writeRaw(
      this.writeScratch,
      'hid',
      (n, detail) => `hid_write returned ${n}: ${detail}`,
    );
    if (result < 0) error('hid', `AKP05E write failed: ${describePacket(packet)}`);
  }

  protected onBeforeClose(): void {
    // AKP05E close is intentionally silent. Firmware can wedge after speculative commands.
  }

  protected _cleanup(): void {
    this._stopReadTimer();
    this._closeDevice();
    const exitResult = this._teardownLib();
    if (exitResult !== null) debug('hid', `hid_exit() → ${exitResult}`);
  }
}
