// Pure helpers for the child-server (MK.2/Mini) payload hot path: chunk tracing,
// brightness parsing and the out-of-range key guard. Dispatch stays in
// ElgatoChildServer so each ACK-paced chunk goes straight to the assembler.
import { PAYLOAD_TYPE_FEATURE, GEN1_IMAGE_KEY_OFFSET, GEN1_IMAGE_LAST_OFFSET } from './protocol.js';
import type { LogFn } from './types.js';

// Callers MUST guard these with isLevelEnabled('debug'): they run once per 1024B chunk
// directly ahead of the ACK Elgato paces image delivery on, and at the default `info`
// level the interpolated string would be built only to be discarded.
export function traceImageChunk(
  emitLog: LogFn,
  payload: Buffer,
  messageId: number,
  msSinceConnect: number,
): void {
  const last = payload[3] === 1 ? ' LAST' : '';
  emitLog(
    'debug',
    `child rx: image-data chunk key=${payload[2]}${last} ${payload.readUInt16LE(4)}B msgId=${messageId} (+${msSinceConnect}ms)`,
  );
}

export function traceGen1ImageChunk(
  emitLog: LogFn,
  payload: Buffer,
  messageId: number,
  msSinceConnect: number,
): void {
  const last = payload[GEN1_IMAGE_LAST_OFFSET] === 1 ? ' LAST' : '';
  emitLog(
    'debug',
    `child rx: gen1 image chunk key=${payload[GEN1_IMAGE_KEY_OFFSET]! - 1}${last} msgId=${messageId} (+${msSinceConnect}ms)`,
  );
}

/** Brightness level carried by a set-report payload, or undefined when it carries none. */
export function parseChildBrightness(payload: Buffer): number | undefined {
  if (payload[0] === PAYLOAD_TYPE_FEATURE && [0x02, 0x05, 0x08, 0x0d].includes(payload[1]!)) {
    return payload[2];
  }
  // gen1 brightness: [0x05, 0x55, 0xaa, 0xd1, 0x01, percentage]
  if (
    payload.length >= 6 &&
    payload[0] === 0x05 &&
    payload[1] === 0x55 &&
    payload[2] === 0xaa &&
    payload[3] === 0xd1
  ) {
    return payload[5];
  }
  return undefined;
}

export function isValidChildImageKey(
  keyIndex: number,
  keyCount: number,
  warnedOobKeys: Set<number>,
  emitLog: LogFn,
): boolean {
  if (keyIndex >= 0 && keyIndex < keyCount) return true;
  if (!warnedOobKeys.has(keyIndex)) {
    warnedOobKeys.add(keyIndex);
    emitLog('warn', `dropping image chunk for out-of-range key ${keyIndex} (keyCount=${keyCount})`);
  }
  return false;
}
