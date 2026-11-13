import { DEFAULT_MODEL } from '../../devices/registry.js';
import {
  DEFAULT_DOCK_FIRMWARE_VERSION,
  DEFAULT_CHILD_FIRMWARE_VERSION,
  DEFAULT_DOCK_SERIAL_NUMBER,
  DEFAULT_CHILD_SERIAL_NUMBER,
  DEFAULT_MAC_ADDRESS_STRING,
} from '../../shared/types.js';
import type { MockDeviceConfig } from './types.js';

/** Identity fields shown before the first dock connects. */
export function defaultDeviceIdentityFields(): MockDeviceConfig {
  return {
    dockFirmwareVersion: DEFAULT_DOCK_FIRMWARE_VERSION,
    childFirmwareVersion: DEFAULT_CHILD_FIRMWARE_VERSION,
    serialNumber: DEFAULT_DOCK_SERIAL_NUMBER,
    childSerialNumber: DEFAULT_CHILD_SERIAL_NUMBER,
    productId: DEFAULT_MODEL.cora.productId,
    macAddress: DEFAULT_MAC_ADDRESS_STRING,
  };
}
