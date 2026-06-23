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
} from './types.js';
import type { DeviceConfig } from './elgato-types.js';

export function fwVersionBuf(version: string): Buffer {
  return Buffer.from(
    version.padEnd(FW_VERSION_FIELD_LEN, '\0').slice(0, FW_VERSION_FIELD_LEN),
    'ascii',
  );
}

// ── CORA report buffer builders ──────────────────────────────────────────────
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
