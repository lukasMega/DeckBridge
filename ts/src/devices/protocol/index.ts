/** Per-protocol byte-level framing strategy table.
 *  `ElgatoHidDriver` looks up its strategy once (in the constructor) instead of
 *  branching on `model.protocol` at every call site. Adding a protocol = add one
 *  table entry; touch zero call-sites in hid-driver-base.ts. */
import type { DeviceProtocol } from '../driver.js';
import {
  gen1PackImage,
  gen1ParseInput,
  gen1BrightnessReport,
  gen1ResetReport,
} from './elgato-gen1.js';
import {
  gen2PackImage,
  gen2ParseInput,
  gen2BrightnessReport,
  gen2ResetReport,
} from './elgato-gen2.js';

export interface ProtocolStrategy {
  packImage(keyIndex: number, bytes: Uint8Array): Uint8Array[];
  parseInput(
    data: Uint8Array,
    keyCount: number,
  ): Array<{ keyIndex: number; pressed: boolean }> | null;
  brightnessReport(pct: number): Uint8Array;
  resetReport(): Uint8Array;
}

// Only protocols handled by ElgatoHidDriver need entries; mirabox uses MiraboxDriver.
export const PROTOCOL_STRATEGY: Partial<Record<DeviceProtocol, ProtocolStrategy>> = {
  'elgato-gen1': {
    packImage: gen1PackImage,
    parseInput: gen1ParseInput,
    brightnessReport: gen1BrightnessReport,
    resetReport: gen1ResetReport,
  },
  'elgato-gen2': {
    packImage: gen2PackImage,
    parseInput: gen2ParseInput,
    brightnessReport: gen2BrightnessReport,
    resetReport: gen2ResetReport,
  },
};
