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
import { CORA_VERBATIM_RESULT } from './cora-frame.js';
import { buildFwReport, buildVidPidReport, buildSerialReport } from './feature-response.js';
import type { DeviceConfig } from './elgato-types.js';
import type { SendFrameFn, LogFn } from './elgato-child-payload.js';

export type GetReportHandler = (messageId: number, payload: Buffer) => void;

/** Per-report differences; everything else (build → trace → verbatim send) is shared. */
interface ReportSpec {
  build: (cfg: DeviceConfig, reportId: number) => Buffer;
  /** Extra debug tracing, emitted after the response is built and before it is sent. */
  trace?: (emitLog: LogFn, messageId: number, payload: Buffer, response: Buffer) => void;
  /** Comm-log description; omitted where the reply carried none. */
  desc?: (cfg: DeviceConfig, messageId: number) => string;
}

const childDeviceId = (cfg: DeviceConfig): string => cfg.childSerialNumber.slice(0, 12);

const fwFieldReport = (reportId: number, cfg: DeviceConfig): Buffer =>
  buildFwReport(reportId, 32, 6, cfg.childFirmwareVersion, [FW_VERSION_FIELD_LEN]);

const REPORT_SPECS: ReadonlyMap<number, ReportSpec> = new Map<number, ReportSpec>([
  // gen1 serial number: ASCII at offset 5, null-terminated
  [0x03, { build: (c) => buildSerialReport(0x03, SERIAL_REPORT_SIZE, 5, c.childSerialNumber) }],
  // gen1 firmware version: ASCII at offset 5, null-terminated
  [0x04, { build: (c) => buildFwReport(0x04, FIRMWARE_REPORT_SIZE, 5, c.childFirmwareVersion) }],
  [
    REPORT_FIRMWARE_VERSION,
    {
      build: (c) =>
        buildFwReport(
          REPORT_FIRMWARE_VERSION,
          FIRMWARE_REPORT_SIZE,
          6,
          c.childFirmwareVersion,
          [0x0c, 0xf4, 0x5f, 0xed, 0xa6],
        ),
      trace: (emitLog, messageId, payload, r) => {
        emitLog(
          'debug',
          `child rx: 0x05 raw payload (${(payload.subarray(0, 20) as Buffer).toString('hex')}) msgId=${messageId}`,
        );
        emitLog(
          'debug',
          `child tx: 0x05 raw response (${(r.subarray(0, 14) as Buffer).toString('hex')}) msgId=${messageId}`,
        );
      },
    },
  ],
  [
    REPORT_SERIAL_NUMBER,
    {
      build: (c) =>
        buildSerialReport(REPORT_SERIAL_NUMBER, SERIAL_REPORT_SIZE, 2, childDeviceId(c), [0x0c]),
      trace: (emitLog, _messageId, payload) => {
        if (payload.length > 1 && payload[1] !== 0) {
          const written = (payload.subarray(2, 2 + payload[1]!) as Buffer).toString('hex');
          emitLog(
            'debug',
            `child rx: 0x06 write ignored (len=${payload[1]} data=${written}), returning device id`,
          );
        }
      },
      desc: (c, messageId) => `CORA GET_REPORT 0x06 id=${childDeviceId(c)} msgId=${messageId}`,
    },
  ],
  [
    REPORT_DEVICE_INFO,
    {
      build: (c) =>
        buildVidPidReport(
          REPORT_DEVICE_INFO,
          DEVICE_INFO_REPORT_SIZE,
          ELGATO_VID,
          c.productId,
          DEVICE_INFO_VID_OFFSET,
          DEVICE_INFO_PID_OFFSET,
        ),
    },
  ],
  [0x11, { build: (c, id) => fwFieldReport(id, c) }],
  [0x13, { build: (c, id) => fwFieldReport(id, c) }],
]);

export function createGetReportHandlers(
  deviceConfig: DeviceConfig,
  sendFrame: SendFrameFn,
  emitLog: LogFn,
): Map<number, GetReportHandler> {
  const handlers = new Map<number, GetReportHandler>();
  for (const [reportId, spec] of REPORT_SPECS) {
    handlers.set(reportId, (messageId, payload) => {
      const r = spec.build(deviceConfig, reportId);
      spec.trace?.(emitLog, messageId, payload, r);
      sendFrame(r, CORA_VERBATIM_RESULT, 0, messageId, spec.desc?.(deviceConfig, messageId));
    });
  }
  return handlers;
}
