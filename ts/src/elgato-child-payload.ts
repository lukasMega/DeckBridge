// Child-server (MK.2/Mini) CORA payload handling: verbatim probes, feature
// requests, output-report dispatch, brightness extraction, and image-chunk
// assembly. Split out of elgato-child-server.ts (pure extraction, no
// behavior change) — these are plain functions taking their dependencies as
// parameters so the ElgatoChildServer class can keep calling them on the
// ACK-paced hot path without an extra object/indirection layer.
import {
  ELGATO_VID,
  PAYLOAD_TYPE_OUTPUT_REPORT,
  PAYLOAD_TYPE_FEATURE,
  IMG_CMD_WRITE,
  GEN1_IMG_CMD,
  IMAGE_CHUNK_KEY_OFFSET,
  GEN1_IMAGE_KEY_OFFSET,
  GEN1_IMAGE_LAST_OFFSET,
  FEATURE_KEEPALIVE_ACK,
  FEATURE_GET_CAPABILITIES,
  FEATURE_GET_DEVICE_INFO,
  REPORT_SECONDARY_DETECT,
  SECONDARY_DETECT_RESPONSE_SIZE,
} from './types.js';
import type { ImageEvent } from './types.js';
import { CORA_FLAG_RESULT, CORA_FLAG_VERBATIM, CORA_FLAG_REQACK } from './cora-frame.js';
import { assembleImageChunk, assembleGen1ImageChunk } from './image-assembler.js';
import type { DeviceConfig } from './elgato-types.js';
import { buildFwReport, buildVidPidReport } from './feature-response.js';

export type SendFrameFn = (
  payload: Buffer,
  flags: number,
  hidOp: number,
  messageId: number,
  description?: string,
) => void;

export type LogFn = (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;

// gen1 (Mini) probes — sent by desktop when PID identifies a gen1 device.
// 0xa1 = device-info probe; 0xa4 = firmware-version probe (0xa0 + USB HID report id).
export function handleChildVerbatimProbe(
  byte0: number,
  hidOp: number,
  messageId: number,
  deviceConfig: DeviceConfig,
  sendFrame: SendFrameFn,
): boolean {
  switch (byte0) {
    case REPORT_SECONDARY_DETECT: {
      const r = Buffer.alloc(SECONDARY_DETECT_RESPONSE_SIZE);
      r[0] = REPORT_SECONDARY_DETECT;
      sendFrame(r, CORA_FLAG_RESULT | CORA_FLAG_VERBATIM, hidOp, messageId);
      return true;
    }
    case 0xa1: {
      const r = buildVidPidReport(0xa1, 32, ELGATO_VID, deviceConfig.productId, 2, 4);
      sendFrame(r, CORA_FLAG_RESULT | CORA_FLAG_VERBATIM, hidOp, messageId);
      return true;
    }
    case 0xa4: {
      const r = buildFwReport(0xa4, 32, 5, deviceConfig.childFirmwareVersion);
      sendFrame(r, CORA_FLAG_RESULT | CORA_FLAG_VERBATIM, hidOp, messageId);
      return true;
    }
    default:
      return false;
  }
}

export function handleChildFeatureRequest(
  byte1: number,
  hidOp: number,
  messageId: number,
  buildSelfDeviceInfo: () => Buffer,
  sendFrame: SendFrameFn,
): boolean {
  switch (byte1) {
    case FEATURE_KEEPALIVE_ACK:
    case FEATURE_GET_DEVICE_INFO:
      return true;
    case FEATURE_GET_CAPABILITIES: {
      const r = buildSelfDeviceInfo();
      sendFrame(r, CORA_FLAG_RESULT, hidOp, messageId);
      return true;
    }
    default:
      return false;
  }
}

export function handleChildOutputReportPacket(
  byte0: number,
  byte1: number,
  flags: number,
  hidOp: number,
  messageId: number,
  payload: Buffer,
  msSinceConnect: number,
  emitLog: LogFn,
  sendAckNak: (messageId: number, hidOp?: number) => void,
  handleImageChunk: (pkt: Buffer, messageId: number) => void,
  handleGen1ImageChunk: (pkt: Buffer, messageId: number) => void,
): void {
  if (byte0 !== PAYLOAD_TYPE_OUTPUT_REPORT) return;
  if (byte1 === IMG_CMD_WRITE) {
    emitLog(
      'debug',
      `child rx: image-data chunk key=${payload[2]}${payload[3] === 1 ? ' LAST' : ''} ${payload.readUInt16LE(4)}B msgId=${messageId} (+${msSinceConnect}ms)`,
    );
    if (flags & CORA_FLAG_REQACK) sendAckNak(messageId, hidOp);
    handleImageChunk(payload, messageId);
  } else if (byte1 === GEN1_IMG_CMD) {
    emitLog(
      'debug',
      `child rx: gen1 image chunk key=${payload[GEN1_IMAGE_KEY_OFFSET]! - 1}` +
        `${payload[GEN1_IMAGE_LAST_OFFSET] === 1 ? ' LAST' : ''} msgId=${messageId} (+${msSinceConnect}ms)`,
    );
    if (flags & CORA_FLAG_REQACK) sendAckNak(messageId, hidOp);
    handleGen1ImageChunk(payload, messageId);
  }
}

// Returns true when payload carried a brightness command (emitted + ACKed).
export function extractChildBrightness(
  payload: Buffer,
  flags: number,
  messageId: number,
  emitBrightness: (level: number) => void,
  sendAckNak: (messageId: number, hidOp?: number) => void,
): boolean {
  let level: number | undefined;
  if (payload[0] === PAYLOAD_TYPE_FEATURE && [0x02, 0x05, 0x08, 0x0d].includes(payload[1]!)) {
    level = payload[2];
  } else if (
    // gen1 brightness: [0x05, 0x55, 0xaa, 0xd1, 0x01, percentage]
    payload.length >= 6 &&
    payload[0] === 0x05 &&
    payload[1] === 0x55 &&
    payload[2] === 0xaa &&
    payload[3] === 0xd1
  ) {
    level = payload[5];
  }
  if (level === undefined) return false;
  emitBrightness(level);
  if (flags & CORA_FLAG_REQACK) {
    sendAckNak(messageId);
  }
  return true;
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

export function assembleChildImageChunk(
  pkt: Buffer,
  imagePages: Map<number, Buffer[]>,
  keyCount: number,
  warnedOobKeys: Set<number>,
  emitLog: LogFn,
  emitImage: (event: ImageEvent) => void,
): void {
  if (!isValidChildImageKey(pkt[IMAGE_CHUNK_KEY_OFFSET]!, keyCount, warnedOobKeys, emitLog)) return;
  const event = assembleImageChunk(imagePages, pkt);
  if (event) emitImage(event);
}

export function assembleChildGen1ImageChunk(
  pkt: Buffer,
  gen1ImagePages: Map<number, Buffer[]>,
  keyCount: number,
  warnedOobKeys: Set<number>,
  emitLog: LogFn,
  emitImage: (event: ImageEvent) => void,
): void {
  if (!isValidChildImageKey(pkt[GEN1_IMAGE_KEY_OFFSET]! - 1, keyCount, warnedOobKeys, emitLog))
    return;
  const event = assembleGen1ImageChunk(gen1ImagePages, pkt);
  if (event) emitImage(event);
}
