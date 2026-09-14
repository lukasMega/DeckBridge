import { DEFAULT_MODEL } from '../../devices/registry.js';
import { isValidMacAddress } from './web-request-guard.js';
import {
  DEFAULT_DOCK_FIRMWARE_VERSION,
  DEFAULT_CHILD_FIRMWARE_VERSION,
  DEFAULT_DOCK_SERIAL_NUMBER,
  DEFAULT_CHILD_SERIAL_NUMBER,
  DEFAULT_MAC_ADDRESS_STRING,
  MOCK_FW_VERSION_MAX_LEN,
  MOCK_SERIAL_MAX_LEN,
  MOCK_PRODUCT_ID_MASK,
} from '../../types.js';
import type { MockDeviceConfig } from './types.js';

/** Default identity fields, shared by the mock driver config and the identity
 *  fallback shown before the first notifyDocks. */
export function defaultMockConfig(): MockDeviceConfig {
  return {
    dockFirmwareVersion: DEFAULT_DOCK_FIRMWARE_VERSION,
    childFirmwareVersion: DEFAULT_CHILD_FIRMWARE_VERSION,
    serialNumber: DEFAULT_DOCK_SERIAL_NUMBER,
    childSerialNumber: DEFAULT_CHILD_SERIAL_NUMBER,
    productId: DEFAULT_MODEL.cora.productId,
    macAddress: DEFAULT_MAC_ADDRESS_STRING,
  };
}

/** Merge validated fields of `parsed` into `config`: strings length-capped,
 *  productId masked to the CORA PID range, MAC format-checked. Invalid fields
 *  are ignored, not fatal. */
export function mergeMockConfig(config: MockDeviceConfig, parsed: Partial<MockDeviceConfig>): void {
  const stringFields: [keyof MockDeviceConfig, number][] = [
    ['dockFirmwareVersion', MOCK_FW_VERSION_MAX_LEN],
    ['childFirmwareVersion', MOCK_FW_VERSION_MAX_LEN],
    ['serialNumber', MOCK_SERIAL_MAX_LEN],
    ['childSerialNumber', MOCK_SERIAL_MAX_LEN],
  ];
  for (const [key, maxLen] of stringFields) {
    const value = parsed[key];
    if (typeof value === 'string') (config[key] as string) = value.slice(0, maxLen);
  }
  if (typeof parsed.productId === 'number' && Number.isInteger(parsed.productId)) {
    config.productId = parsed.productId & MOCK_PRODUCT_ID_MASK;
  }
  if (typeof parsed.macAddress === 'string' && isValidMacAddress(parsed.macAddress)) {
    config.macAddress = parsed.macAddress;
  }
}

/** Guard for POST /api/key/:n. Key simulation is a mock-mode affordance: with a
 *  real device attached the press must come from the hardware, or the WebUI
 *  would silently diverge from what the device reports. */
export function validateSimulatedKey(
  n: number,
  keyCount: number,
  driverMode: 'real' | 'mock',
): { error: string; status: number } | null {
  if (n < 0 || n >= keyCount) {
    return { error: `key index must be 0–${keyCount - 1}`, status: 400 };
  }
  if (driverMode !== 'mock') {
    return { error: 'key simulation only available in mock mode', status: 409 };
  }
  return null;
}
