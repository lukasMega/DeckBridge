// WebHID copy of Akp05Driver's packet sequencing (the desktop driver stays separate
// to keep the worker lean). test/core-replay.test.ts pins both to the same fixtures.
import type { DeviceModel } from '../driver.js';
import type { DialEvent, KeyEvent, KeyState, TouchInputEvent } from '../../shared/types.js';
import { DEFAULT_BRIGHTNESS } from '../../shared/types.js';
import { parseAckReport } from '../mirabox/protocol.js';
import { jpegSize } from '../jpeg-size.js';
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
  forEachImageChunk,
  parseVersionReport,
} from '../ajazz/akp05-protocol.js';

import type { ReportSink } from './types.js';

// mirajazz's Device::keep_alive() + opendeck-akp05's keepalive_task (10 s): the
// akp05 firmware drops the host after ~15 s of silence — panel blanks and key
// reports stop until a key press partially wakes it. See docs/references.md.
export const AKP05_KEEP_ALIVE_MS = 10_000;

// Input classification. Key codes are 1-based and row-ordered (1-10). Encoder codes
// come through the same ACK report (byte 9 = code, byte 10 = stateByte) — the tables
// below are the hardware-verified values from `mise run akp05-capture`, recorded in
// devices/device-notes.json.
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
 *  as single-direction events (no coordinates). Synthesized to span the full
 *  Stream Deck + 800×100 strip. Reference: opendeck-akp05 src/inputs.rs. */
const TOUCH_SWIPE_LEFT = 0x38;
const TOUCH_SWIPE_RIGHT = 0x39;
/** Touch-strip tap codes, left-to-right: one per zone, aligned with the encoders.
 *  No coordinates and no release report, so each tap lands on its zone's centre. */
const TOUCH_TAP_CODES: readonly number[] = [0x40, 0x41, 0x42, 0x43];
const TOUCH_STRIP_WIDTH = 800;

// clearKey() images, one per slot size (keys 112×112, strip slots 176×112): baseline
// 4:2:0 black from the same jpeg-encoder the transform uses. A smaller image leaves the
// rest of the slot showing its previous content.
// Shared tables keep native blank JPEG bytes compact.
const BLACK_JPEG_HEADER =
  '/9j/4AAQSkZJRgABAgAAAQABAAD/wAARCABwAHADACIAAREBAhEB/9sAQwADAgIDAgIDAwMDBAMDBAUIBQUEBAUKBwcGCAwKDAwLCgsLDQ4SEA0OEQ4LCxAWEBETFBUVFQwPFxgWFBgSFBUU/9sAQwEDBAQFBAUJBQUJFA0LDRQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMAAAERAhEAPwD8qq';
const BLACK_JPEG_BLOCK = 'KKKACiiigAooooAK';
const BLACK_KEY_JPEG = Buffer.from(
  BLACK_JPEG_HEADER + BLACK_JPEG_BLOCK.repeat(16) + 'KKKAP/2Q==',
  'base64',
);
const BLACK_STRIP_JPEG = Buffer.from(
  BLACK_JPEG_HEADER.replace('AHAD', 'ALAD') + BLACK_JPEG_BLOCK.repeat(25) + 'KKKACiiigD/9k=',
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

export type Akp05Input =
  | { kind: 'key'; event: KeyEvent }
  | { kind: 'dial'; event: DialEvent }
  | { kind: 'touch'; event: TouchInputEvent }
  | { kind: 'firmware'; version: string }
  | { kind: 'unmapped'; code: number; stateByte: number }
  | { kind: 'unknown' };

export class Akp05Core {
  private writeScratch = Buffer.alloc(1025);
  private brightness = DEFAULT_BRIGHTNESS;
  private readonly sendScratch = (): void => this.out(this.writeScratch);

  constructor(
    private readonly model: DeviceModel,
    private readonly out: ReportSink,
  ) {}

  init(): void {
    this.write(buildVer());
    this.write(buildDis());
    this.write(buildLig(this.brightness));
    this.write(buildCle(AKP05_CLEAR_ALL));
    this.write(buildStp());
  }

  // The wake pair (DIS + LIG) is not optional on this firmware: CONNECT alone let
  // the panel stop taking image updates after the first tick (zeccola/ajazz-akp05
  // 0.10.1, reverted in 0.10.2). LIG carries the live brightness so the tick can't
  // reset it.
  keepAlive(): void {
    this.write(buildDis());
    this.write(buildLig(this.brightness));
    this.write(buildConnect());
  }

  parseInput(data: Uint8Array): Akp05Input[] {
    const parsed = parseAckReport(Buffer.from(data), 0);
    if (!parsed) {
      const version = parseVersionReport(data);
      return version ? [{ kind: 'firmware', version }] : [{ kind: 'unknown' }];
    }
    return this.classifyInput(parsed.keyIndex, parsed.stateByte);
  }

  private classifyInput(code: number, stateByte: number): Akp05Input[] {
    if (code >= KEY_CODE_MIN && code <= KEY_CODE_MAX) {
      const state: KeyState = stateByte === 0x01 ? 'down' : 'up';
      return [{ kind: 'key', event: { keyIndex: code, state } }];
    }
    const pressIndex = ENCODER_PRESS_CODES.indexOf(code);
    if (pressIndex >= 0) {
      // A release report from other firmware would double-fire the synthesized pair.
      if (stateByte !== 0x01) return [];
      return [
        { kind: 'dial', event: { index: pressIndex, kind: 'press', state: 'down' } },
        { kind: 'dial', event: { index: pressIndex, kind: 'press', state: 'up' } },
      ];
    }
    const rotate = encoderRotateDelta(code);
    if (rotate) {
      return [
        {
          kind: 'dial',
          event: {
            index: rotate.index,
            kind: 'rotate',
            delta: rotate.delta,
          },
        },
      ];
    }
    if (code === TOUCH_SWIPE_LEFT) {
      return [
        {
          kind: 'touch',
          event: {
            type: 'swipe',
            x: 750,
            y: 50,
            endX: 50,
            endY: 50,
          },
        },
      ];
    }
    if (code === TOUCH_SWIPE_RIGHT) {
      return [
        {
          kind: 'touch',
          event: {
            type: 'swipe',
            x: 50,
            y: 50,
            endX: 750,
            endY: 50,
          },
        },
      ];
    }
    const tapIndex = TOUCH_TAP_CODES.indexOf(code);
    if (tapIndex >= 0) {
      const zoneWidth = TOUCH_STRIP_WIDTH / TOUCH_TAP_CODES.length;
      return [
        {
          kind: 'touch',
          event: {
            type: 'tap',
            x: Math.round((tapIndex + 0.5) * zoneWidth),
            y: 50,
          },
        },
      ];
    }
    return [{ kind: 'unmapped', code, stateByte }];
  }

  sendImage(wireId: number, jpeg: Uint8Array): { strip: boolean; full: boolean } {
    this.write(buildBat(jpeg.length, wireId));
    forEachImageChunk(jpeg, this.writeScratch, 1, this.sendScratch);
    this.write(buildUlend());
    return {
      strip: this.isStripWire(wireId),
      full: jpegSize(jpeg)?.width === this.model.touchStripDisplay?.image.width,
    };
  }

  clearKey(wireId: number): void {
    this.sendImage(wireId, this.isStripWire(wireId) ? BLACK_STRIP_JPEG : BLACK_KEY_JPEG);
  }

  isStripWire(wireId: number): boolean {
    return this.model.widgetDisplays?.some((display) => display.wireId === wireId) ?? false;
  }

  setBrightness(level: number): void {
    this.brightness = level;
    this.write(buildLig(level));
  }

  private write(packet: Buffer): void {
    if (packet.length !== 1024)
      throw new Error(`AKP05 packet must be 1024 bytes, got ${packet.length}`);
    this.writeScratch.set(packet, 1);
    this.sendScratch();
  }
}
