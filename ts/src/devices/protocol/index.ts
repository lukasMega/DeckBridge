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
  gen1BlankImage,
  GEN1_INFO_REPORTS,
} from './elgato-gen1.js';
import {
  gen2WriteImage,
  gen2ParseInput,
  gen2BrightnessReport,
  gen2ResetReport,
  gen2BlankImage,
  GEN2_INFO_REPORTS,
} from './elgato-gen2.js';

/** Where an ASCII device-info string sits in a 32-byte feature report. `lengthPrefixed`
 *  means byte 1 holds the length; otherwise the value runs to the end of the report. */
export interface InfoReport {
  reportId: number;
  offset: number;
  lengthPrefixed: boolean;
}

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
  /** All-black image in the device-native format. The driver keeps the result,
   *  so implementations may return a shared constant. */
  blankImage(keyWidth: number, keyHeight: number): Uint8Array;
  /** Serial/firmware feature reports, read once on open. */
  infoReports: { serial: InfoReport; firmware: InfoReport };
}

// Only protocols handled by ElgatoHidDriver need entries; mirabox uses MiraboxDriver.
export const PROTOCOL_STRATEGY: Partial<Record<DeviceProtocol, ProtocolStrategy>> = {
  'elgato-gen1': {
    writeImage: gen1WriteImage,
    parseInput: gen1ParseInput,
    brightnessReport: gen1BrightnessReport,
    resetReport: gen1ResetReport,
    blankImage: gen1BlankImage,
    infoReports: GEN1_INFO_REPORTS,
  },
  'elgato-gen2': {
    writeImage: gen2WriteImage,
    parseInput: gen2ParseInput,
    brightnessReport: gen2BrightnessReport,
    resetReport: gen2ResetReport,
    blankImage: gen2BlankImage,
    infoReports: GEN2_INFO_REPORTS,
  },
};
