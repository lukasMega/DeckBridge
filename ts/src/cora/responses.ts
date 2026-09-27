// Every CORA reply DeckBridge builds from the emulated device's identity: primary
// feature responses, the child's capabilities packet, verbatim probes and GET_REPORT
// specs. Pure builders only; the servers own dispatch and sending.
import {
  FW_VERSION_FIELD_LEN,
  CORA_FW_VERSION_OFFSET,
  CORA_SERIAL_LEN_OFFSET,
  CORA_SERIAL_DATA_OFFSET,
  FEATURE_GET_DOCK_FW,
  FEATURE_GET_QUICK_PROBE,
  FEATURE_GET_CHILD_FW,
  FEATURE_GET_DOCK_SERIAL,
  FEATURE_GET_FW_LEGACY,
  FEATURE_GET_SERIAL_LEGACY,
  FEATURE_GET_MAC,
  PAYLOAD_TYPE_FEATURE,
  REPORT_FIRMWARE_VERSION,
  REPORT_SERIAL_NUMBER,
  REPORT_DEVICE_INFO,
  REPORT_SECONDARY_DETECT,
  SECONDARY_DETECT_RESPONSE_SIZE,
  ELGATO_VID,
  SERIAL_REPORT_SIZE,
  FIRMWARE_REPORT_SIZE,
  DEVICE_INFO_REPORT_SIZE,
  DEVICE_INFO_VID_OFFSET,
  DEVICE_INFO_PID_OFFSET,
  ELGATO_PKT_SIZE_RX,
  PKT_EVENT,
  EVENT_SUBTYPE_CAPABILITIES,
  CHILD_CAPS_VERSION,
  CHILD_CAPS_LAYOUT_TYPE,
  CHILD_CAPS_SERIAL_MAX_LEN,
  MANUFACTURER_STRING,
} from '../shared/types.js';
import type { ChildGeometry } from '../devices/driver.js';
import type { DeviceConfig, LogFn } from './types.js';

export function fwVersionBuf(version: string): Buffer {
  return Buffer.from(
    version.padEnd(FW_VERSION_FIELD_LEN, '\0').slice(0, FW_VERSION_FIELD_LEN),
    'ascii',
  );
}

// CORA report buffer builders
// Small pure helpers capturing the repeated "alloc N, set byte0, fill field"
// shapes used by the child server's verbatim probe / GET_REPORT responses.

// alloc `size`, byte0 = reportId, optional fixed prefix bytes starting at r[1],
// then the 8-byte firmware version at `fwOffset`.
export function buildFwReport(
  reportId: number,
  size: number,
  fwOffset: number,
  version: string,
  prefix?: readonly number[],
): Buffer {
  const r = Buffer.alloc(size);
  r[0] = reportId;
  if (prefix) for (let i = 0; i < prefix.length; i++) r[1 + i] = prefix[i]!;
  fwVersionBuf(version).copy(r, fwOffset);
  return r;
}

// alloc `size`, byte0 = reportId, VID at `vidOffset`, PID at `pidOffset` (LE).
export function buildVidPidReport(
  reportId: number,
  size: number,
  vid: number,
  pid: number,
  vidOffset: number,
  pidOffset: number,
): Buffer {
  const r = Buffer.alloc(size);
  r[0] = reportId;
  r.writeUInt16LE(vid, vidOffset);
  r.writeUInt16LE(pid, pidOffset);
  return r;
}

// alloc `size`, byte0 = reportId, optional fixed prefix bytes starting at r[1],
// then ASCII `serial` copied at `serialOffset`.
export function buildSerialReport(
  reportId: number,
  size: number,
  serialOffset: number,
  serial: string,
  prefix?: readonly number[],
): Buffer {
  const r = Buffer.alloc(size);
  r[0] = reportId;
  if (prefix) for (let i = 0; i < prefix.length; i++) r[1 + i] = prefix[i]!;
  Buffer.from(serial, 'ascii').copy(r, serialOffset);
  return r;
}

export function buildFeatureResponse(
  reportId: number,
  config: DeviceConfig,
  packetSize: number,
): Buffer {
  const pkt = Buffer.alloc(packetSize);
  pkt[0] = PAYLOAD_TYPE_FEATURE;
  pkt[1] = reportId;

  switch (reportId) {
    case FEATURE_GET_DOCK_FW:
    case FEATURE_GET_QUICK_PROBE:
      fwVersionBuf(config.dockFirmwareVersion).copy(pkt, CORA_FW_VERSION_OFFSET);
      break;
    case FEATURE_GET_CHILD_FW:
      fwVersionBuf(config.childFirmwareVersion).copy(pkt, CORA_FW_VERSION_OFFSET);
      break;
    case FEATURE_GET_DOCK_SERIAL: {
      const serial = Buffer.from(config.serialNumber, 'ascii');
      pkt[CORA_SERIAL_LEN_OFFSET] = serial.length;
      serial.copy(pkt, CORA_SERIAL_DATA_OFFSET);
      break;
    }
    case FEATURE_GET_FW_LEGACY:
      fwVersionBuf(config.dockFirmwareVersion).copy(pkt, 2);
      break;
    case FEATURE_GET_SERIAL_LEGACY:
      Buffer.from(config.serialNumber, 'ascii').copy(pkt, 2);
      break;
    case FEATURE_GET_MAC: {
      const mac = Buffer.from(config.macAddress);
      if (mac.length === 6) mac.copy(pkt, 4);
      break;
    }
  }
  return pkt;
}

export function buildCapabilitiesPacket(
  config: DeviceConfig,
  port: number,
  geometry: ChildGeometry,
): Buffer {
  const pkt = Buffer.alloc(ELGATO_PKT_SIZE_RX);
  pkt[0] = PKT_EVENT;
  pkt[1] = EVENT_SUBTYPE_CAPABILITIES;
  pkt.writeUInt16LE(CHILD_CAPS_VERSION, 2);
  // grid-type byte. Haukcode reads grid-type/cols/rows from bytes 5..7; byte 4 is
  // observed 0x02 for the MK.2/Mini layouts. The Plus grid (4×2) shares that value
  // — the model distinction rides on the PID + firmware, not this byte.
  pkt[4] = CHILD_CAPS_LAYOUT_TYPE;
  pkt[5] = geometry.rows;
  pkt[6] = geometry.columns;
  pkt[7] = geometry.keyCount;
  pkt.writeUInt16LE(geometry.keyWidth, 8);
  pkt.writeUInt16LE(geometry.keyHeight, 10);
  // Touch-strip dims (Stream Deck +: 800×100). Offsets UNVERIFIED — keyed here so a
  // verified capture is a one-line fix (see plan CORA section).
  pkt.writeUInt16LE(geometry.touchWidth ?? 0, 12);
  pkt.writeUInt16LE(geometry.touchHeight ?? 0, 14);
  pkt.writeUInt16LE(ELGATO_VID, 26);
  pkt.writeUInt16LE(config.productId, 28);
  Buffer.from(MANUFACTURER_STRING + '\0', 'ascii').copy(pkt, 30);
  Buffer.from(geometry.productName + '\0', 'ascii').copy(pkt, 62);
  const serial = Buffer.from(config.childSerialNumber, 'ascii');
  serial.copy(pkt, 94, 0, Math.min(serial.length, CHILD_CAPS_SERIAL_MAX_LEN));
  pkt.writeUInt16LE(port, 126);
  return pkt;
}

// gen1 (Mini) probes — sent by desktop when PID identifies a gen1 device.
// 0xa1 = device-info probe; 0xa4 = firmware-version probe (0xa0 + USB HID report id).
/** The verbatim reply for `byte0`, or null when it is not a probe we answer. */
export function buildVerbatimProbeReport(byte0: number, deviceConfig: DeviceConfig): Buffer | null {
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

/** Per-report differences; everything else (build → trace → verbatim send) is shared. */
export interface ReportSpec {
  build: (cfg: DeviceConfig, reportId: number) => Buffer;
  /** Extra debug tracing, emitted after the response is built and before it is sent. */
  trace?: (emitLog: LogFn, messageId: number, payload: Buffer, response: Buffer) => void;
  /** Comm-log description; omitted where the reply carried none. */
  desc?: (cfg: DeviceConfig, messageId: number) => string;
}

const childDeviceId = (cfg: DeviceConfig): string => cfg.childSerialNumber.slice(0, 12);

const fwFieldReport = (reportId: number, cfg: DeviceConfig): Buffer =>
  buildFwReport(reportId, 32, 6, cfg.childFirmwareVersion, [FW_VERSION_FIELD_LEN]);

export const CHILD_REPORT_SPECS: ReadonlyMap<number, ReportSpec> = new Map<number, ReportSpec>([
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
