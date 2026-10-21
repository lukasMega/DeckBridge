// Device verify wizard wire DTOs (`/api/verify/*` + the `verifyEnded` WS event). Part of
// the `web-contract` leaf: type-only, imports nothing. Design:
// .claude/plans/2026-10-21_device-verify-wizard.md ("Contracts").

export type VerifyRotate = 0 | 90 | 180 | 270;
/** One dihedral element, canonical form: rotate CW, then optional flipH (never flipV). */
export interface VerifyOrientation {
  rotate: VerifyRotate;
  flipH: boolean;
}

export type VerifyUnavailable = 'no-device' | 'virtual' | 'passthrough' | 'safe-mode' | 'busy';

export interface VerifySpec {
  dockIndex: number;
  modelId: string;
  modelName: string;
  tested: boolean;
  /** Advertised CORA grid: what the Elgato app paints (AKP05: SD+ 2×4, not the 10 physical keys). */
  rows: number;
  columns: number;
  keyCount: number;
  /** Advertised keyWidth × keyHeight: the pattern's pixel size. */
  sourceSize: { width: number; height: number };
  /** Physical keys outside the CORA grid (DeckBridge side keys, right column): not checked. */
  extraKeys: number;
  /** Dials and touch strip of the advertised profile: drawn, not checked. */
  encoders: number;
  touchStrip: boolean;
  /** P: how the app pre-orients an upright image for this profile (verify-orientation.ts). */
  frameOrientation: VerifyOrientation;
  /** Effective (registry + persisted override) image fields the wizard reads or changes. */
  image: {
    rotate: VerifyRotate;
    flipH: boolean;
    flipV: boolean;
    width: number;
    height: number;
    quality: number;
    maxBytes: number;
  };
  /** Dense CORA index → wire image id, resolved via mk2IndexToDeviceImgId; length keyCount. */
  coraToWireImage: number[];
  /** Effective splash orientation (transformOverride merged over image, as splashSpec does). */
  splash: VerifyOrientation & { flipV: boolean };
  /** LastFrames holds app frames, so the real-image check after save is possible. */
  hasAppFrames: boolean;
  appVersion: string;
}

export type VerifySpecResponse =
  | { ok: true; spec: VerifySpec }
  | { ok: false; reason: VerifyUnavailable };
export interface VerifyStartResponse {
  token: string;
  leaseMs: number;
  spec: VerifySpec;
}
export interface VerifyPaintBody {
  token: string;
  keys: { key: number; data: string /* base64 JPEG */ }[];
}
/** Image-only draft, applied live (classifyOverrideChange 'live'). Replaces the previous draft. */
export interface VerifyDraftBody {
  token: string;
  image: Partial<
    Pick<
      VerifySpec['image'],
      'rotate' | 'flipH' | 'flipV' | 'width' | 'height' | 'quality' | 'maxBytes'
    >
  >;
}
export interface VerifySaveBody {
  token: string;
  image?: VerifyDraftBody['image'];
  coraToWireImage?: number[];
  wireInputToCora?: number[];
  splash?: VerifyOrientation & { flipV: boolean };
}
export interface VerifySaveResponse {
  ok: true;
  reconnecting: boolean;
}
export interface VerifyDismissBody {
  modelId: string;
  never: boolean;
}

/** Why a session ended; a model change on the dock counts as 'detached'. */
export type VerifyEndReason = 'lease' | 'detached' | 'saved' | 'cancelled';
/** WS `verifyEnded`. */
export interface VerifyEndedMsg {
  dockIndex: number;
  reason: VerifyEndReason;
}
