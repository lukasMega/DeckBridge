// Device-tuning wire DTOs (GET /api/device-overrides): the second file of the
// web-contract leaf, split out of contract.ts for the line gate. Zero imports.

export interface TuningCropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TuningImage {
  rotate?: 0 | 90 | 180 | 270;
  flipH?: boolean;
  flipV?: boolean;
  width?: number;
  height?: number;
  quality?: number;
  maxBytes?: number;
  blur?: number;
  sharpen?: number;
  crop?: number;
  /** Partial while the form is being edited; the server rejects an incomplete rect. */
  cropRect?: Partial<TuningCropRect>;
  resizeFilter?: 'triangle' | 'nearest' | 'lanczos3';
  resizeMode?: 'resize' | 'pad' | 'crop';
  padFill?: 'black' | 'average' | 'edge';
  transform?: 'passthrough' | 'sidecar';
}

/** `effective.image`: every tunable field, plus the protocol facts the device
 *  reports but no override may set. */
export interface EffectiveTuningImage extends TuningImage {
  format?: 'jpeg' | 'bmp';
  colorMode?: 'rgb' | 'bgr';
  bmpPpm?: number;
}

export interface TuningKeyMap {
  coraToWireImage?: readonly number[];
  wireInputToCora?: readonly number[];
  inputOffset?: number;
  imageOffset?: number;
  extraKeys?: readonly number[];
}

export interface TuningCora {
  advertiseAs?: string;
  productId?: number;
}

/** Every wire field is sent; the WebUI only reads and sets this one. */
export type TuningWire = { batchImageTransfers?: boolean; [key: string]: unknown };

export interface TuningOverride {
  image?: TuningImage;
  keyMap?: TuningKeyMap;
  wire?: TuningWire;
  splash?: unknown;
  cora?: TuningCora;
}

/** A CORA emulation profile the device may re-pair as (from CORA_PROFILES). */
export interface EmulationProfile {
  id: string;
  name: string;
  productId: number;
}

/** GET /api/device-overrides payload: the registry values (`defaults`), what the
 *  user has set (`overrides`), what the device is actually running (`effective`),
 *  and the form seed (`tunable`). */
export interface DeviceOverridesView {
  modelId: string;
  modelName: string;
  defaults: TuningOverride;
  overrides: TuningOverride;
  /** True in safe mode (`--no-overrides`): `overrides` is still persisted (so
   *  Reset works) but `effective` equals the registry defaults, because that is
   *  what the device is actually running. */
  safeMode: boolean;
  /** The FULL effective spec — for display/diagnostics. Do NOT seed the form from this: it
   *  carries the non-tunable protocol facts (`format`, `colorMode`, `bmpPpm`) too, and
   *  POSTing them straight back is rejected. Seed from `tunable` instead. */
  effective: { image: EffectiveTuningImage; keyMap: TuningKeyMap } & Omit<
    TuningOverride,
    'image' | 'keyMap'
  >;
  /** `effective`, projected down to exactly the fields an override may set — so a
   *  round-trip (seed the form → Apply unchanged) is always valid. */
  tunable: TuningOverride;
  /** CORA profiles this model may re-pair as (its `cora.emulations`), with their PID. */
  profiles: EmulationProfile[];
  /** Key image size the Elgato app sends (the advertised model's key size) — what
   *  the transform fits into `effective.image` width×height. */
  sourceSize: { width: number; height: number };
}
