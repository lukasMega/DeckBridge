// Pure per-protocol facts, one row per wire protocol: no driver constructors, no FFI, no
// hardware defaults (those stay on the model). Imports nothing, so driver.ts can derive its
// types from here without a cycle. Adding a protocol starts here; the compiler then points
// at USB_DRIVERS (usb-drivers.ts), the one other table that must list it.

export const WIRE_OVERRIDE_KEYS = [
  'packetSize',
  'inSize',
  'heartbeatMs',
  'reportId',
  'chunkDelayMs',
  'chunkPadByte',
  'synthesizeKeyUp',
  'sendStpAfterImage',
  'batchImageTransfers',
] as const;

export type WireOverrideKey = (typeof WIRE_OVERRIDE_KEYS)[number];

/** Reader-facing grouping for generated docs, not the raw `protocol` tag. */
export type ProtocolFamily = 'elgato' | 'mirabox-v3' | 'mirabox-v1' | 'ajazz-akp05';

export interface ProtocolMeta {
  /** The wire fields this protocol's driver actually reads, so the only ones a user may
   *  tune. Elgato sizes are protocol facts: a wrong packetSize makes gen1/gen2 chunk short
   *  and the firmware drops it silently. AKP05 hardcodes its 1024-byte framing and report
   *  id 0. Lives here, not beside USB_DRIVERS, because the main thread validates overrides
   *  and must not import the FFI drivers. */
  readonly tunableWireKeys: readonly WireOverrideKey[];
  readonly family: ProtocolFamily;
  /** True when ElgatoHidDriver frames it through a PROTOCOL_STRATEGY entry. */
  readonly strategy: boolean;
}

const MIRABOX_WIRE_KEYS = [
  'packetSize',
  'inSize',
  'heartbeatMs',
  'reportId',
  'chunkDelayMs',
  'chunkPadByte',
  'synthesizeKeyUp',
  'sendStpAfterImage',
] as const satisfies readonly WireOverrideKey[];

/** Wire protocol — closed; adding a new model almost always reuses an existing one. */
export const PROTOCOLS = {
  // BMP, 16-byte header, key+1, feature 0x05/0x0B (Mini, original)
  'elgato-gen1': { tunableWireKeys: [], family: 'elgato', strategy: true },
  // JPEG, 8-byte header, feature 0x03 (MK.2, XL)
  'elgato-gen2': { tunableWireKeys: [], family: 'elgato', strategy: true },
  // v3, 1024-byte packets, press+release
  'mirabox-cora': { tunableWireKeys: MIRABOX_WIRE_KEYS, family: 'mirabox-v3', strategy: false },
  // v1, 512-byte packets, keydown-only. Only this 293S-family board batches image uploads.
  'mirabox-cora-v1': {
    tunableWireKeys: [...MIRABOX_WIRE_KEYS, 'batchImageTransfers'],
    family: 'mirabox-v1',
    strategy: false,
  },
  // 1024-byte CRT BAT uploads, ULEND commit
  'ajazz-akp05': { tunableWireKeys: ['inSize'], family: 'ajazz-akp05', strategy: false },
} as const satisfies Record<string, ProtocolMeta>;
