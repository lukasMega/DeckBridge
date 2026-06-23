import {
  PAYLOAD_TYPE_OUTPUT_REPORT,
  PAYLOAD_TYPE_FEATURE,
  PKT_EVENT,
  EVENT_SUBTYPE_KEEPALIVE,
  EVENT_SUBTYPE_CAPABILITIES,
  FEATURE_KEEPALIVE_ACK,
  FEATURE_GET_DEVICE_INFO,
  IMG_CMD_WRITE,
  REPORT_SECONDARY_DETECT,
  REPORT_FIRMWARE_VERSION,
  REPORT_SERIAL_NUMBER,
  REPORT_DEVICE_INFO,
} from './types.js';
import { coraFlagString } from './cora-frame.js';

export function describeCoraPayload(
  payload: Buffer,
  flags: number,
  hidOp: number,
  messageId: number,
): string {
  if (payload.length < 2) return `CORA? flags=${coraFlagString(flags)} msgId=${messageId}`;
  const b0 = payload[0]!,
    b1 = payload[1]!;
  if (b0 === PAYLOAD_TYPE_FEATURE && b1 === FEATURE_KEEPALIVE_ACK)
    return `CORA keepalive ACK msgId=${messageId}`;
  if (b0 === PAYLOAD_TYPE_FEATURE && b1 === FEATURE_GET_DEVICE_INFO)
    return `CORA device-info request msgId=${messageId}`;
  if (b0 === PAYLOAD_TYPE_FEATURE)
    return `CORA feature GET 0x${b1.toString(16).padStart(2, '0')} hidOp=0x${hidOp.toString(16)} msgId=${messageId}`;
  if (b0 === PAYLOAD_TYPE_OUTPUT_REPORT && b1 === IMG_CMD_WRITE) {
    const keyIdx = payload[2],
      isLast = payload[3] === 1,
      bodyLen = payload.readUInt16LE(4);
    return `CORA image-data chunk key=${keyIdx}${isLast ? ' LAST' : ''} ${bodyLen}B msgId=${messageId}`;
  }
  return `CORA unknown 0x${b0.toString(16).padStart(2, '0')} 0x${b1.toString(16).padStart(2, '0')} flags=${coraFlagString(flags)} msgId=${messageId}`;
}

export function describeChildPayload(
  payload: Buffer,
  flags: number,
  _hidOp: number,
  messageId: number,
  productId: number,
  port: number,
): string {
  if (payload.length < 1) return `CORA empty flags=${coraFlagString(flags)} msgId=${messageId}`;
  const b0 = payload[0]!,
    b1 = payload.length > 1 ? payload[1]! : -1;
  if (b0 === PKT_EVENT && b1 === EVENT_SUBTYPE_KEEPALIVE)
    return `CORA keepalive seq=${payload[5]} msgId=${messageId}`;
  if (b0 === PKT_EVENT && b1 === EVENT_SUBTYPE_CAPABILITIES)
    return `CORA child-plug-event PID=0x${productId.toString(16).padStart(4, '0')} port=${port}`;
  if (b0 === REPORT_SECONDARY_DETECT) return `CORA secondary-detect response msgId=${messageId}`;
  if (b0 === REPORT_FIRMWARE_VERSION) return `CORA GET_REPORT 0x05 firmware msgId=${messageId}`;
  if (b0 === REPORT_SERIAL_NUMBER) return `CORA GET_REPORT 0x06 serial msgId=${messageId}`;
  if (b0 === REPORT_DEVICE_INFO) return `CORA GET_REPORT 0x0B devinfo msgId=${messageId}`;
  return `CORA child 0x${b0.toString(16).padStart(2, '0')} flags=${coraFlagString(flags)} msgId=${messageId}`;
}
