/** Per-protocol byte-level framing strategy table. `ElgatoHidDriver` looks its strategy
 *  up once in the constructor instead of branching on `model.protocol` per call site, so
 *  adding a protocol touches no call sites in hid-driver-base.ts. Framing algorithms
 *  only — packet/input-report SIZES live on the model (`wire.packetSize`/`wire.inSize`). */
import type { DeviceProtocol } from '../driver.js';
import {
  gen1WriteImage,
  gen1ParseInput,
  gen1BrightnessReport,
  gen1ResetReport,
} from './elgato-gen1.js';
import {
  gen2WriteImage,
  gen2ParseInput,
  gen2BrightnessReport,
  gen2ResetReport,
} from './elgato-gen2.js';

export interface ProtocolStrategy {
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
    writeImage: gen1WriteImage,
    parseInput: gen1ParseInput,
    brightnessReport: gen1BrightnessReport,
    resetReport: gen1ResetReport,
  },
  'elgato-gen2': {
    writeImage: gen2WriteImage,
    parseInput: gen2ParseInput,
    brightnessReport: gen2BrightnessReport,
    resetReport: gen2ResetReport,
  },
};
