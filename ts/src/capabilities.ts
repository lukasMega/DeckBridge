import {
  ELGATO_PKT_SIZE_RX,
  PKT_EVENT,
  EVENT_SUBTYPE_CAPABILITIES,
  CHILD_CAPS_VERSION,
  CHILD_CAPS_LAYOUT_TYPE,
  ELGATO_VID,
  CHILD_CAPS_SERIAL_MAX_LEN,
  MANUFACTURER_STRING,
} from './types.js';
import type { DeviceConfig } from './elgato-types.js';
import type { DeviceModel, ChildGeometry } from './devices/driver.js';

export type { ChildGeometry };

export const MK2_CHILD_GEOMETRY: ChildGeometry = {
  rows: 3,
  columns: 5,
  keyCount: 15,
  keyWidth: 72,
  keyHeight: 72,
  productName: 'Stream Deck MK.2',
};

export const MINI_CHILD_GEOMETRY: ChildGeometry = {
  rows: 2,
  columns: 3,
  keyCount: 6,
  keyWidth: 80,
  keyHeight: 80,
  productName: 'Stream Deck Mini',
};

export function modelToChildGeometry(model: DeviceModel): ChildGeometry {
  return {
    rows: model.rows,
    columns: model.columns,
    keyCount: model.keyCount,
    keyWidth: model.keyWidth,
    keyHeight: model.keyHeight,
    productName: model.name,
  };
}

export function buildCapabilitiesPacket(
  config: DeviceConfig,
  port: number,
  geometry: ChildGeometry = MK2_CHILD_GEOMETRY,
): Buffer {
  const pkt = Buffer.alloc(ELGATO_PKT_SIZE_RX);
  pkt[0] = PKT_EVENT;
  pkt[1] = EVENT_SUBTYPE_CAPABILITIES;
  pkt.writeUInt16LE(CHILD_CAPS_VERSION, 2);
  pkt[4] = CHILD_CAPS_LAYOUT_TYPE;
  pkt[5] = geometry.rows;
  pkt[6] = geometry.columns;
  pkt[7] = geometry.keyCount;
  pkt.writeUInt16LE(geometry.keyWidth, 8);
  pkt.writeUInt16LE(geometry.keyHeight, 10);
  pkt.writeUInt16LE(ELGATO_VID, 26);
  pkt.writeUInt16LE(config.productId, 28);
  Buffer.from(MANUFACTURER_STRING + '\0', 'ascii').copy(pkt, 30);
  Buffer.from(geometry.productName + '\0', 'ascii').copy(pkt, 62);
  const serial = Buffer.from(config.childSerialNumber, 'ascii');
  serial.copy(pkt, 94, 0, Math.min(serial.length, CHILD_CAPS_SERIAL_MAX_LEN));
  pkt.writeUInt16LE(port, 126);
  return pkt;
}
