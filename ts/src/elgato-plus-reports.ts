// Stream Deck + input reports the child server sends to the Elgato app. Pure
// builders: the server owns the guards (advertised geometry) and press state.
import {
  ELGATO_PKT_SIZE_TX,
  REPORT_BUTTON_STATE_INPUT,
  INPUT_SUBTYPE_TOUCH,
  INPUT_SUBTYPE_ENCODER,
} from './types.js';
import type { TouchInputEvent } from './types.js';

const ENCODER_PRESS = 0x00;
const ENCODER_ROTATE = 0x01;
const TOUCH_TYPE: Record<TouchInputEvent['type'], number> = { tap: 0x01, hold: 0x02, swipe: 0x03 };

function encoderReport(count: number, kind: number): Buffer {
  const pkt = Buffer.alloc(ELGATO_PKT_SIZE_TX);
  pkt[0] = REPORT_BUTTON_STATE_INPUT;
  pkt[1] = INPUT_SUBTYPE_ENCODER;
  pkt[2] = 1 + count; // contents type byte + one byte per encoder
  pkt[4] = kind;
  return pkt;
}

/** Encoder press: `01 03 <1+count> 00 00 <per-encoder pressed>`, bit i of `mask` = encoder i. */
export function buildEncoderPressReport(count: number, mask: number): Buffer {
  const pkt = encoderReport(count, ENCODER_PRESS);
  for (let i = 0; i < count; i++) pkt[5 + i] = (mask >> i) & 1;
  return pkt;
}

/** Encoder rotation: `01 03 <1+count> 00 01 <d0..dn>`, one INT8 delta per encoder. */
export function buildEncoderRotateReport(count: number, index: number, delta: number): Buffer {
  const pkt = encoderReport(count, ENCODER_ROTATE);
  pkt[5 + index] = Math.max(-128, Math.min(127, Math.round(delta))) & 0xff; // INT8 two's complement
  return pkt;
}

/** Touch strip: `01 02 <len> 00 <type> <fingers> x y [ex ey]`, coordinates clamped
 *  to the `width`×`height` strip. */
export function buildTouchReport(event: TouchInputEvent, width: number, height: number): Buffer {
  const clampX = (x: number): number => Math.max(0, Math.min(width - 1, Math.round(x)));
  const clampY = (y: number): number => Math.max(0, Math.min(height - 1, Math.round(y)));
  const hasEnd = event.type === 'swipe';
  const pkt = Buffer.alloc(ELGATO_PKT_SIZE_TX);
  pkt[0] = REPORT_BUTTON_STATE_INPUT;
  pkt[1] = INPUT_SUBTYPE_TOUCH;
  pkt[2] = hasEnd ? 0x0e : 0x0a; // FLICK 0x0E, TAP/PRESS 0x0A
  pkt[4] = TOUCH_TYPE[event.type];
  pkt[5] = 0; // fingers (reserved for FLICK; N/A for TAP/PRESS)
  pkt.writeUInt16LE(clampX(event.x), 6);
  pkt.writeUInt16LE(clampY(event.y), 8);
  if (hasEnd) {
    pkt.writeUInt16LE(clampX(event.endX ?? event.x), 10);
    pkt.writeUInt16LE(clampY(event.endY ?? event.y), 12);
  }
  return pkt;
}
