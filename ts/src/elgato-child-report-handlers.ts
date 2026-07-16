// GET_REPORT dispatch table for the child (MK.2/Mini) CORA server — one
// entry per reportId, building the matching feature-response buffer. Split
// out of elgato-child-server.ts (pure extraction, no behavior change).
import {
  REPORT_FIRMWARE_VERSION,
  REPORT_SERIAL_NUMBER,
  REPORT_DEVICE_INFO,
  ELGATO_VID,
  SERIAL_REPORT_SIZE,
  FIRMWARE_REPORT_SIZE,
  DEVICE_INFO_REPORT_SIZE,
  DEVICE_INFO_VID_OFFSET,
  DEVICE_INFO_PID_OFFSET,
  FW_VERSION_FIELD_LEN,
} from './types.js';
import { CORA_FLAG_RESULT, CORA_FLAG_VERBATIM } from './cora-frame.js';
import { buildFwReport, buildVidPidReport, buildSerialReport } from './feature-response.js';
import type { DeviceConfig } from './elgato-types.js';
import type { SendFrameFn, LogFn } from './elgato-child-payload.js';

export type GetReportHandler = (messageId: number, payload: Buffer) => void;

export function createGetReportHandlers(
  deviceConfig: DeviceConfig,
  sendFrame: SendFrameFn,
  emitLog: LogFn,
): Map<number, GetReportHandler> {
  const sendFwFieldReport = (reportId: number, messageId: number): void => {
    const r = buildFwReport(reportId, 32, 6, deviceConfig.childFirmwareVersion, [
      FW_VERSION_FIELD_LEN,
    ]);
    sendFrame(r, CORA_FLAG_RESULT | CORA_FLAG_VERBATIM, 0, messageId);
  };

  return new Map<number, GetReportHandler>([
    // gen1 serial number: ASCII at offset 5, null-terminated
    [
      0x03,
      (messageId: number) => {
        const r = buildSerialReport(0x03, SERIAL_REPORT_SIZE, 5, deviceConfig.childSerialNumber);
        sendFrame(r, CORA_FLAG_RESULT | CORA_FLAG_VERBATIM, 0, messageId);
      },
    ],
    // gen1 firmware version: ASCII at offset 5, null-terminated
    [
      0x04,
      (messageId: number) => {
        const r = buildFwReport(0x04, FIRMWARE_REPORT_SIZE, 5, deviceConfig.childFirmwareVersion);
        sendFrame(r, CORA_FLAG_RESULT | CORA_FLAG_VERBATIM, 0, messageId);
      },
    ],
    [
      REPORT_FIRMWARE_VERSION,
      (messageId: number, payload: Buffer) => {
        const r = buildFwReport(
          REPORT_FIRMWARE_VERSION,
          FIRMWARE_REPORT_SIZE,
          6,
          deviceConfig.childFirmwareVersion,
          [0x0c, 0xf4, 0x5f, 0xed, 0xa6],
        );
        emitLog(
          'debug',
          `child rx: 0x05 raw payload (${(payload.subarray(0, 20) as Buffer).toString('hex')}) msgId=${messageId}`,
        );
        emitLog(
          'debug',
          `child tx: 0x05 raw response (${(r.subarray(0, 14) as Buffer).toString('hex')}) msgId=${messageId}`,
        );
        sendFrame(r, CORA_FLAG_RESULT | CORA_FLAG_VERBATIM, 0, messageId);
      },
    ],
    [
      REPORT_SERIAL_NUMBER,
      (messageId: number, payload: Buffer) => {
        const id = deviceConfig.childSerialNumber.slice(0, 12);
        const r = buildSerialReport(REPORT_SERIAL_NUMBER, SERIAL_REPORT_SIZE, 2, id, [0x0c]);
        if (payload.length > 1 && payload[1] !== 0) {
          const written = (payload.subarray(2, 2 + payload[1]!) as Buffer).toString('hex');
          emitLog(
            'debug',
            `child rx: 0x06 write ignored (len=${payload[1]} data=${written}), returning device id`,
          );
        }
        sendFrame(
          r,
          CORA_FLAG_RESULT | CORA_FLAG_VERBATIM,
          0,
          messageId,
          `CORA GET_REPORT 0x06 id=${id} msgId=${messageId}`,
        );
      },
    ],
    [
      REPORT_DEVICE_INFO,
      (messageId: number) => {
        const r = buildVidPidReport(
          REPORT_DEVICE_INFO,
          DEVICE_INFO_REPORT_SIZE,
          ELGATO_VID,
          deviceConfig.productId,
          DEVICE_INFO_VID_OFFSET,
          DEVICE_INFO_PID_OFFSET,
        );
        sendFrame(r, CORA_FLAG_RESULT | CORA_FLAG_VERBATIM, 0, messageId);
      },
    ],
    [0x11, (messageId: number) => sendFwFieldReport(0x11, messageId)],
    [0x13, (messageId: number) => sendFwFieldReport(0x13, messageId)],
  ]);
}
