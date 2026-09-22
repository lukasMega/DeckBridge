import { findHidPath, isNullPtr, IS_MACOS } from '../../ffi/hidapi.js';
import { HidDeviceBase } from '../hid-connection.js';
import { debug, error, info } from '../../logger.js';
import type { DeviceModel } from '../driver.js';
import type { DialEvent, KeyEvent, KeyState, TouchInputEvent } from '../../types.js';
import { DEFAULT_BRIGHTNESS } from '../../types.js';
import { parseAckReport } from '../mirabox-protocol.js';
import {
  AKP05_CLEAR_ALL,
  buildBat,
  buildCle,
  buildConnect,
  buildDis,
  buildLig,
  buildStp,
  buildUlend,
  buildVer,
  describePacket,
  forEachImageChunk,
  parseVersionReport,
} from './akp05-protocol.js';

// mirajazz's Device::keep_alive() + opendeck-akp05's keepalive_task (10 s): the
// akp05 firmware drops the host after ~15 s of silence — panel blanks and key
// reports stop until a key press partially wakes it. See docs/references.md.
const KEEP_ALIVE_INTERVAL_MS = 10_000;

// Input classification. Key codes are 1-based and row-ordered (1-10). Encoder codes
// come through the same ACK report (byte 9 = code, byte 10 = stateByte) — the tables
// below are the hardware-verified values from `mise run akp05-capture`, recorded in
// devices/device-notes.json. Touch-strip swipes are decoded; taps are not yet.
const KEY_CODE_MIN = 0x01;
const KEY_CODE_MAX = 0x0a;
/** Encoder press codes, left-to-right. stateByte 0x01 = down; the firmware sends no
 *  release report, so the driver synthesizes the up (a latched press never re-fires). */
const ENCODER_PRESS_CODES: readonly number[] = [0x37, 0x35, 0x33, 0x36];
/** Encoder rotate codes, left-to-right: [ccw, cw] per encoder. stateByte is always 0. */
const ENCODER_ROTATE_CODES: readonly (readonly [number, number])[] = [
  [0xa0, 0xa1],
  [0x50, 0x51],
  [0x90, 0x91],
  [0x70, 0x71],
];

/** Touch-strip swipe codes. The AKP05E 4-segment strip reports left/right swipes
 *  as single-direction events (no coordinates). Synthesised to span the full
 *  Stream Deck + 800×100 strip. Reference: opendeck-akp05 src/inputs.rs. */
const TOUCH_SWIPE_LEFT = 0x38;
const TOUCH_SWIPE_RIGHT = 0x39;

const BLACK_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/Aaf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/Aaf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Aqf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z',
  'base64',
);

/** The encoder index + signed delta for a rotate code, or null when `code` is not
 *  a rotate code. delta +1 = clockwise, -1 = counter-clockwise. */
function encoderRotateDelta(code: number): { index: number; delta: number } | null {
  for (let i = 0; i < ENCODER_ROTATE_CODES.length; i++) {
    const pair = ENCODER_ROTATE_CODES[i]!;
    if (code === pair[0]) return { index: i, delta: -1 };
    if (code === pair[1]) return { index: i, delta: 1 };
  }
  return null;
}

export class Akp05Driver extends HidDeviceBase {
  hidPath: string | undefined;
  firmware: string | undefined;
  private writeScratch = Buffer.alloc(1025);
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private brightness = DEFAULT_BRIGHTNESS;

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
    this._startReadLoop(hid, this.model.wire.inSize, 5, (data, n) =>
      this.parseInput(Buffer.from(data.subarray(0, n))),
    );
    this.write(buildVer());
    this.writeInitSequence();
    this.keepAliveTimer = setInterval(() => this.writeKeepAlive(), KEEP_ALIVE_INTERVAL_MS);
    info('hid', 'AKP05E opened; sent CRT VER + init sequence, keep-alive started');
    await Promise.resolve();
  }

  // DIS + LIG + CLE-all + STP. opendeck-akp05 sends this on every connect, and it
  // is what unlocks key reporting: without it the firmware never sends ACK reports.
  private writeInitSequence(): void {
    this.write(buildDis());
    this.write(buildLig(this.brightness));
    this.write(buildCle(AKP05_CLEAR_ALL));
    this.write(buildStp());
  }

  // The wake pair (DIS + LIG) is not optional on this firmware: CONNECT alone let
  // the panel stop taking image updates after the first tick (zeccola/ajazz-akp05
  // 0.10.1, reverted in 0.10.2). LIG carries the live brightness so the tick can't
  // reset it.
  private writeKeepAlive(): void {
    this.write(buildDis());
    this.write(buildLig(this.brightness));
    this.write(buildConnect());
  }

  // Input report: 'ACK' 00 00 'OK' 00 00, then [keyIndex, state] at bytes 9-10.
  // keyIndex stays the raw wire code — translator.ts maps it via keyMap.wireInputToCora.
  protected parseInput(data: Buffer): void {
    const parsed = parseAckReport(data, 0);
    if (!parsed) {
      const firmware = parseVersionReport(data);
      if (firmware) this.firmware = firmware;
      else debug('hid', `AKP05E rx: ${data.toString('hex')}`);
      return;
    }
    this.classifyInput(parsed.keyIndex, parsed.stateByte);
  }

  private classifyInput(code: number, stateByte: number): void {
    if (code >= KEY_CODE_MIN && code <= KEY_CODE_MAX) {
      const state: KeyState = stateByte === 0x01 ? 'down' : 'up';
      this.emit('key', { keyIndex: code, state } satisfies KeyEvent);
      return;
    }
    const pressIndex = ENCODER_PRESS_CODES.indexOf(code);
    if (pressIndex >= 0) {
      // A release report from other firmware would double-fire the synthesized pair.
      if (stateByte !== 0x01) return;
      this.emit('dial', { index: pressIndex, kind: 'press', state: 'down' } satisfies DialEvent);
      this.emit('dial', { index: pressIndex, kind: 'press', state: 'up' } satisfies DialEvent);
      return;
    }
    const rotate = encoderRotateDelta(code);
    if (rotate) {
      this.emit('dial', {
        index: rotate.index,
        kind: 'rotate',
        delta: rotate.delta,
      } satisfies DialEvent);
      return;
    }
    if (code === TOUCH_SWIPE_LEFT) {
      this.emit('touch', {
        type: 'swipe',
        x: 750,
        y: 50,
        endX: 50,
        endY: 50,
      } satisfies TouchInputEvent);
      return;
    }
    if (code === TOUCH_SWIPE_RIGHT) {
      this.emit('touch', {
        type: 'swipe',
        x: 50,
        y: 50,
        endX: 750,
        endY: 50,
      } satisfies TouchInputEvent);
      return;
    }
    // Touch-strip tap and any other control: framing unverified — log for capture.
    debug('hid', `AKP05E unclassified input code=0x${code.toString(16)} state=${stateByte}`);
  }

  close(): Promise<void> {
    this._cleanup();
    return Promise.resolve();
  }

  // keyIndex is already the device wire id — callers (image-render.ts,
  // splash-sender.ts) resolve model.keyMap.coraToWireImage before calling in.
  sendImage(keyIndex: number, jpeg: Uint8Array): void {
    try {
      this.write(buildBat(jpeg.length, keyIndex));
      forEachImageChunk(jpeg, this.writeScratch, 1, () => this.writeScratchOut());
      this.write(buildUlend());
    } catch (cause) {
      this.emit('error', cause instanceof Error ? cause : new Error(String(cause)));
    }
  }

  clearKey(keyIndex: number): void {
    this.sendImage(keyIndex, BLACK_JPEG);
  }

  setBrightness(level: number): void {
    this.brightness = level;
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
    this.writeScratch.set(packet, 1);
    this.writeScratchOut();
  }

  /** Send the report staged in writeScratch (report id 0 + one 1024-byte packet). */
  private writeScratchOut(): void {
    if (!this.device || !this.hidLib) return;
    this.writeScratch[0] = 0;
    const result = this._writeRaw(
      this.writeScratch,
      'hid',
      (n, detail) => `hid_write returned ${n}: ${detail}`,
    );
    if (result < 0) {
      error('hid', `AKP05E write failed: ${describePacket(this.writeScratch.subarray(1))}`);
    }
  }

  protected onBeforeClose(): void {
    // AKP05E close is intentionally silent. Firmware can wedge after speculative commands.
  }

  protected _cleanup(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
    this._stopReadTimer();
    this._closeDevice();
    const exitResult = this._teardownLib();
    if (exitResult !== null) debug('hid', `hid_exit() → ${exitResult}`);
  }
}
