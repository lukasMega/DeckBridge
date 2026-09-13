/** Per-protocol byte-level framing strategy table.
 *  `ElgatoHidDriver` looks up its strategy once (in the constructor) instead of
 *  branching on `model.protocol` at every call site. Adding a protocol = add one
 *  table entry; touch zero call-sites in hid-driver-base.ts. */
import type { DeviceProtocol } from '../driver.js';
import {
  gen1WriteImage,
  GEN1_PACKET_SIZE,
  gen1ParseInput,
  gen1BrightnessReport,
  gen1ResetReport,
} from './elgato-gen1.js';
import {
  gen2WriteImage,
  GEN2_PACKET_SIZE,
  gen2ParseInput,
  gen2BrightnessReport,
  gen2ResetReport,
} from './elgato-gen2.js';

export interface ProtocolStrategy {
  /** Output-report size, so the driver can size its reusable packet scratch once. */
  packetSize: number;
  /** Chunk `bytes` into output reports and hand each to `write`. `pkt` is the
   *  driver's scratch buffer, reused for every chunk — `write` must consume it
   *  synchronously (see writeChunks in framing.ts). */
  writeImage(
    keyIndex: number,
    bytes: Uint8Array,
    pkt: Uint8Array,
    write: (pkt: Uint8Array) => void,
  ): void;
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
    packetSize: GEN1_PACKET_SIZE,
    writeImage: gen1WriteImage,
    parseInput: gen1ParseInput,
    brightnessReport: gen1BrightnessReport,
    resetReport: gen1ResetReport,
  },
  'elgato-gen2': {
    packetSize: GEN2_PACKET_SIZE,
    writeImage: gen2WriteImage,
    parseInput: gen2ParseInput,
    brightnessReport: gen2BrightnessReport,
    resetReport: gen2ResetReport,
  },
};
