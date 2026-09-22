import type { ImageAssembly } from './image-assembler.js';
import { isLevelEnabled } from './logger.js';
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
  IMG_CMD_LCD,
  IMG_CMD_WINDOW,
  IMG_CMD_WINDOW_PARTIAL,
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
import { CORA_FLAG_RESULT, CORA_FLAG_REQACK, CORA_VERBATIM_RESULT } from './cora-frame.js';
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
/** The verbatim reply for `byte0`, or null when it is not a probe we answer. */
function buildVerbatimProbeReport(byte0: number, deviceConfig: DeviceConfig): Buffer | null {
  switch (byte0) {
    case REPORT_SECONDARY_DETECT: {
      const r = Buffer.alloc(SECONDARY_DETECT_RESPONSE_SIZE);
      r[0] = REPORT_SECONDARY_DETECT;
      return r;
    }
    case 0xa1:
      return buildVidPidReport(0xa1, 32, ELGATO_VID, deviceConfig.productId, 2, 4);
    case 0xa4:
      return buildFwReport(0xa4, 32, 5, deviceConfig.childFirmwareVersion);
    default:
      return null;
  }
}

export function handleChildVerbatimProbe(
  byte0: number,
  hidOp: number,
  messageId: number,
  deviceConfig: DeviceConfig,
  sendFrame: SendFrameFn,
): boolean {
  const r = buildVerbatimProbeReport(byte0, deviceConfig);
  if (!r) return false;
  sendFrame(r, CORA_VERBATIM_RESULT, hidOp, messageId);
  return true;
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

// Callers MUST guard these with isLevelEnabled('debug'): they run once per 1024B chunk
// directly ahead of the ACK Elgato paces image delivery on, and at the default `info`
// level the interpolated string would be built only to be discarded.
function traceImageChunk(
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

function traceGen1ImageChunk(
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
  handleTouchOutput: (cmd: number, pkt: Buffer) => void,
): void {
  if (byte0 !== PAYLOAD_TYPE_OUTPUT_REPORT) return;
  const tracing = isLevelEnabled('debug');
  if (byte1 === IMG_CMD_WRITE) {
    if (tracing) traceImageChunk(emitLog, payload, messageId, msSinceConnect);
    if (flags & CORA_FLAG_REQACK) sendAckNak(messageId, hidOp);
    handleImageChunk(payload, messageId);
  } else if (byte1 === GEN1_IMG_CMD) {
    if (tracing) traceGen1ImageChunk(emitLog, payload, messageId, msSinceConnect);
    if (flags & CORA_FLAG_REQACK) sendAckNak(messageId, hidOp);
    handleGen1ImageChunk(payload, messageId);
  } else if (
    byte1 === IMG_CMD_LCD ||
    byte1 === IMG_CMD_WINDOW ||
    byte1 === IMG_CMD_WINDOW_PARTIAL
  ) {
    // Stream Deck + touch/LCD surface output. ACK-pace it (the app waits for the ACK
    // before the next chunk), then hand the chunk to the child server, which decides
    // which of these (only the window strip is assembled today) it can act on.
    if (flags & CORA_FLAG_REQACK) sendAckNak(messageId, hidOp);
    handleTouchOutput(byte1, payload);
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
  imagePages: Map<number, ImageAssembly>,
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
  gen1ImagePages: Map<number, ImageAssembly>,
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
