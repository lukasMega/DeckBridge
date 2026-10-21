// Device verify wizard sessions: one lease-guarded session per dock holds the app's frames
// (Dock.setVerifyHold), paints the wizard's test pattern and keeps image-only drafts in
// memory until save. Contract: ../contract-verify.ts; design and decisions:
// .claude/plans/2026-10-21_device-verify-wizard.md.
import type { ControllerHost, ReqError } from './types.js';
import { isNonNegInt, nonNegIntError } from './types.js';
import type { ModelOverridesController } from './model-overrides-controller.js';
import { frameOrientation } from './verify-orientation.js';
import type { DeviceModel, DeviceModelOverride } from '../../devices/driver.js';
import { advertisedModel, findModelById } from '../../devices/registry.js';
import {
  applyModelOverrides,
  classifyOverrideChange,
  validateModelOverride,
} from '../../devices/model-overrides.js';
import { overridesDisabled } from '../../shared/cli.js';
import { mk2IndexToDeviceImgId } from '../../shared/key-map.js';
import { splashSpec } from '../../shared/splash-sender.js';
import { VIRTUAL_DOCK_INDEX } from '../../shared/types.js';
import type { DockStatus } from '../../shared/types.js';
import type {
  VerifyDraftBody,
  VerifyEndReason,
  VerifySaveBody,
  VerifyOrientation,
  VerifySaveResponse,
  VerifySpec,
  VerifySpecResponse,
  VerifyStartResponse,
  VerifyUnavailable,
} from '../contract-verify.js';

export const VERIFY_LEASE_MS = 30_000;
/** Decoded size cap per pattern key; a key JPEG is a few KB. */
const MAX_IMAGE_BYTES = 64 * 1024;
const MAX_IMAGE_BASE64 = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
const DRAFT_IMAGE_KEYS: readonly string[] = [
  'rotate',
  'flipH',
  'flipV',
  'width',
  'height',
  'quality',
  'maxBytes',
];

/** Lease timers; tests pass a fake clock. */
export interface VerifyClock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const SYSTEM_TIMERS: VerifyClock = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as number),
};

/** What only the main tier knows about a dock (main/verify-wiring.ts). */
export interface VerifyDockPort {
  hasAppFrames(dockIndex: number): boolean;
}

/** One decoded test-pattern key, for Dock.paintVerify. */
export interface VerifyPaintKey {
  key: number;
  bytes: Uint8Array;
}

/** A refused request; `reason` is set when the wizard is unavailable on that dock. */
export interface VerifyError extends ReqError {
  reason?: VerifyUnavailable;
}

/** A contract body as it arrives: its fields, each still unvalidated. */
export type VerifyRawBody<T> = { [K in keyof T]?: unknown };
export type VerifySaveInput = VerifyRawBody<VerifySaveBody>;

type DraftImage = VerifyDraftBody['image'];

interface Session {
  token: string;
  dockIndex: number;
  /** Registry entry: overrides merge onto it, never onto an effective model. */
  model: DeviceModel;
  keyCount: number;
  /** Image-only draft over the persisted override; null = none sent. */
  draft: DraftImage | null;
  lease: unknown;
}

type Resolved =
  | { ok: true; spec: VerifySpec; model: DeviceModel }
  | { ok: false; reason: VerifyUnavailable };

const ENDED: ReqError = { error: 'verify session ended', status: 410 };
const bad = (error: string): ReqError => ({ error, status: 400 });

export class VerifyController {
  /** By dock index. */
  private readonly sessions = new Map<number, Session>();
  /** "Not now" dismissals: until the next start of DeckBridge. */
  private readonly sessionDismissed = new Set<string>();
  private port: VerifyDockPort = { hasAppFrames: () => false };

  constructor(
    private readonly host: ControllerHost,
    private readonly overrides: Pick<ModelOverridesController, 'trySet'>,
    private readonly docks: () => readonly DockStatus[],
    private readonly clock: VerifyClock = SYSTEM_TIMERS,
  ) {}

  configure(port: VerifyDockPort): void {
    this.port = port;
  }

  spec(dockIndex: number): VerifySpecResponse {
    const r = this.resolve(dockIndex);
    return r.ok ? { ok: true, spec: r.spec } : { ok: false, reason: r.reason };
  }

  /** Hold the dock's app frames and start the lease. */
  start(dockIndex: unknown): VerifyStartResponse | VerifyError {
    if (!isNonNegInt(dockIndex)) return nonNegIntError('dockIndex');
    const r = this.resolve(dockIndex);
    if (!r.ok) {
      const status = r.reason === 'busy' ? 409 : 400;
      return { error: `verify wizard unavailable: ${r.reason}`, status, reason: r.reason };
    }
    const session: Session = {
      token: newToken(),
      dockIndex,
      model: r.model,
      keyCount: r.spec.keyCount,
      draft: null,
      lease: undefined,
    };
    this.sessions.set(dockIndex, session);
    this.renew(session);
    this.host.emit('verifyHold', dockIndex, true, false);
    return { token: session.token, leaseMs: VERIFY_LEASE_MS, spec: r.spec };
  }

  keepalive(token: unknown): { ok: true; leaseMs: number } | ReqError {
    const s = this.byToken(token);
    if (!s) return ENDED;
    this.renew(s);
    return { ok: true, leaseMs: VERIFY_LEASE_MS };
  }

  paint(token: unknown, rawKeys: unknown): ReqError | null {
    const s = this.byToken(token);
    if (!s) return ENDED;
    const decoded = decodeKeys(rawKeys, s.keyCount);
    if ('error' in decoded) return decoded;
    this.renew(s);
    this.host.emit('verifyPaint', s.dockIndex, decoded.keys);
    return null;
  }

  /** Validate persisted ⊕ draft, keep the draft in memory only, apply it live. */
  draft(token: unknown, rawImage: unknown): ReqError | null {
    const s = this.byToken(token);
    if (!s) return ENDED;
    const image = draftImage(rawImage);
    if ('error' in image) return image;
    const checked = validateModelOverride(this.withImage(s.model.id, image), s.model);
    if (!checked.ok) return bad(checked.errors.join('; '));
    s.draft = image;
    this.renew(s);
    this.host.emit('verifyDraft', s.model.id);
    return null;
  }

  /** Persisted ⊕ body (arrays replace wholesale), then the normal override path. */
  save(body: VerifySaveInput): VerifySaveResponse | ReqError {
    const s = this.byToken(body.token);
    if (!s) return ENDED;
    const image = draftImage(body.image ?? {});
    if ('error' in image) return image;
    const persisted = this.host.settings.overrideFor(s.model.id);
    const checked = validateModelOverride(saveOverride(persisted, s.model, image, body), s.model);
    if (!checked.ok) return bad(checked.errors.join('; '));
    // A save that changes nothing runs no live/reopen path, so this end repaints itself.
    const unchanged = classifyOverrideChange(persisted, checked.value) === 'none';
    this.finish(s, 'saved', unchanged);
    const r = this.overrides.trySet(s.model.id, checked.value);
    if ('error' in r) return r;
    this.dismissForGood(s.model.id);
    return { ok: true, reconnecting: r.kind === 'reopen' };
  }

  /** Cancel; idempotent, so an unknown or ended token is not an error. */
  end(token: unknown): void {
    const s = this.byToken(token);
    if (s) this.finish(s, 'cancelled', true);
  }

  dismiss(modelId: unknown, never: unknown): ReqError | null {
    if (typeof modelId !== 'string' || !findModelById(modelId)) {
      return bad('modelId must name a registry model');
    }
    if (typeof never !== 'boolean') return bad('never must be a boolean');
    if (never) {
      this.dismissForGood(modelId);
    } else {
      this.sessionDismissed.add(modelId);
      this.host.publishStatus();
    }
    return null;
  }

  /** Status snapshot `verifyDismissed`: persisted + this run's. */
  dismissedIds(): string[] {
    return [...new Set([...this.host.settings.verifyDismissed, ...this.sessionDismissed])];
  }

  /** DriverManager.overrideFor's draft lookup: persisted ⊕ draft while a session has one. */
  draftOverride(modelId: string): DeviceModelOverride | undefined {
    for (const s of this.sessions.values()) {
      if (s.model.id === modelId && s.draft) return this.withImage(modelId, s.draft);
    }
    return undefined;
  }

  /** Dock list changed: a session whose dock vanished or now runs another model ends. */
  syncDocks(docks: readonly DockStatus[]): void {
    for (const s of this.sessions.values()) {
      const dock = docks.find((d) => d.index === s.dockIndex);
      if (dock?.modelId !== s.model.id) this.finish(s, 'detached', true);
    }
  }

  /** Shutdown: drop the lease timers; the docks close anyway. */
  dispose(): void {
    for (const s of this.sessions.values()) this.clock.clearTimeout(s.lease);
    this.sessions.clear();
  }

  /** The one end path. `repaint` = put the app's frames back here; a save that changes
   *  the override leaves that to the live/reopen path. */
  private finish(s: Session, reason: VerifyEndReason, repaint: boolean): void {
    if (this.sessions.get(s.dockIndex) !== s) return;
    this.sessions.delete(s.dockIndex);
    this.clock.clearTimeout(s.lease);
    // The draft is gone now, so this live apply swaps the persisted override back in.
    if (repaint && s.draft) this.host.emit('verifyDraft', s.model.id);
    this.host.emit('verifyHold', s.dockIndex, false, repaint);
    this.host.broadcast('verifyEnded', { dockIndex: s.dockIndex, reason });
  }

  private renew(s: Session): void {
    this.clock.clearTimeout(s.lease);
    s.lease = this.clock.setTimeout(() => this.finish(s, 'lease', true), VERIFY_LEASE_MS);
  }

  private byToken(token: unknown): Session | undefined {
    if (typeof token !== 'string' || !token) return undefined;
    for (const s of this.sessions.values()) if (s.token === token) return s;
    return undefined;
  }

  private withImage(modelId: string, image: DraftImage): DeviceModelOverride {
    const persisted = this.host.settings.overrideFor(modelId);
    return { ...persisted, image: { ...persisted?.image, ...image } };
  }

  private dismissForGood(modelId: string): void {
    const ids = this.host.settings.verifyDismissed;
    if (!ids.includes(modelId)) this.host.settings.setVerifyDismissed([...ids, modelId]);
    this.host.publishStatus();
  }

  /** Availability (plan I4) in contract order, then the spec of what the dock runs. */
  private resolve(index: number): Resolved {
    const status = this.docks().find((d) => d.index === index);
    if (!status) return { ok: false, reason: 'no-device' };
    if (index === VIRTUAL_DOCK_INDEX || status.virtualClients !== undefined) {
      return { ok: false, reason: 'virtual' };
    }
    const model = findModelById(status.modelId);
    if (!model) return { ok: false, reason: 'no-device' };
    const safeMode = overridesDisabled();
    // Safe mode runs the registry entry, so that is what decides "passthrough".
    const persisted = safeMode ? undefined : this.host.settings.overrideFor(model.id);
    const effective = applyModelOverrides(model, persisted);
    const frame = frameOrientation(advertisedModel(effective).id);
    // Passthrough sends the app's bytes as-is: no transform to tune.
    if (effective.image.transform !== 'sidecar' || !frame)
      return { ok: false, reason: 'passthrough' };
    if (safeMode) return { ok: false, reason: 'safe-mode' };
    if (this.busy(index, model.id)) return { ok: false, reason: 'busy' };
    return { ok: true, model, spec: this.buildSpec(status, effective, frame) };
  }

  /** Drafts are keyed by model id, so two docks of one model can't verify at once. */
  private busy(index: number, modelId: string): boolean {
    for (const s of this.sessions.values()) {
      if (s.dockIndex === index || s.model.id === modelId) return true;
    }
    return false;
  }

  private buildSpec(status: DockStatus, effective: DeviceModel, frame: VerifyOrientation) {
    const advertised = advertisedModel(effective);
    const { image } = effective;
    const splash = splashSpec(effective);
    const spec: VerifySpec = {
      dockIndex: status.index,
      modelId: effective.id,
      modelName: effective.name,
      tested: status.tested ?? false,
      rows: advertised.rows,
      columns: advertised.columns,
      keyCount: advertised.keyCount,
      sourceSize: { width: advertised.keyWidth, height: advertised.keyHeight },
      extraKeys: effective.keyMap.extraKeys?.length ?? 0,
      encoders: advertised.encoderCount ?? 0,
      touchStrip: !!(advertised.touchWidth && advertised.touchHeight),
      frameOrientation: frame,
      image: {
        rotate: image.rotate,
        flipH: image.flipH,
        flipV: image.flipV,
        width: image.width,
        height: image.height,
        quality: image.quality,
        maxBytes: image.maxBytes,
      },
      coraToWireImage: Array.from({ length: advertised.keyCount }, (_, i) =>
        mk2IndexToDeviceImgId(i, effective),
      ),
      splash: { rotate: splash.rotate, flipH: splash.flipH, flipV: splash.flipV },
      hasAppFrames: this.port.hasAppFrames(status.index),
      appVersion: __VERSION__,
    };
    return spec;
  }
}

function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Only the fields the wizard tunes; the values are checked by validateModelOverride. */
function draftImage(raw: unknown): DraftImage | ReqError {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return bad('image must be an object');
  }
  const foreign = Object.keys(raw).find((key) => !DRAFT_IMAGE_KEYS.includes(key));
  return foreign ? bad(`image.${foreign}: not tunable by the verify wizard`) : raw;
}

/** Unvalidated: the caller runs validateModelOverride over the result. */
function saveOverride(
  persisted: DeviceModelOverride | undefined,
  model: DeviceModel,
  image: DraftImage,
  body: VerifySaveInput,
): unknown {
  const base = persisted ?? {};
  const keyMap = {
    ...base.keyMap,
    ...(body.coraToWireImage !== undefined ? { coraToWireImage: body.coraToWireImage } : {}),
    ...(body.wireInputToCora !== undefined ? { wireInputToCora: body.wireInputToCora } : {}),
  };
  // An override's splash section replaces the registry's whole one, so start from the effective.
  const splash =
    body.splash === undefined
      ? base.splash
      : { ...(base.splash ?? model.splash), transformOverride: body.splash };
  return {
    ...base,
    ...(Object.keys(image).length > 0 ? { image: { ...base.image, ...image } } : {}),
    ...(Object.keys(keyMap).length > 0 ? { keyMap } : {}),
    ...(splash ? { splash } : {}),
  };
}

function decodeKeys(raw: unknown, keyCount: number): { keys: VerifyPaintKey[] } | ReqError {
  if (!Array.isArray(raw) || raw.length > keyCount) {
    return bad(`keys must be an array of at most ${keyCount} entries`);
  }
  const keys: VerifyPaintKey[] = [];
  for (const entry of raw as unknown[]) {
    const { key, data } = (entry ?? {}) as { key?: unknown; data?: unknown };
    if (!isNonNegInt(key) || key >= keyCount) {
      return bad(`key must be an integer 0–${keyCount - 1}`);
    }
    const bytes = decodeJpeg(data);
    if (!bytes)
      return bad(`key ${key}: data must be a base64 JPEG of at most ${MAX_IMAGE_BYTES} B`);
    keys.push({ key, bytes });
  }
  return { keys };
}

function decodeJpeg(data: unknown): Uint8Array | null {
  if (typeof data !== 'string' || data.length > MAX_IMAGE_BASE64) return null;
  let bytes: Uint8Array;
  try {
    bytes = Buffer.from(data, 'base64');
  } catch {
    return null;
  }
  // SOI marker: anything else would only fail later, in the worker's decode.
  return bytes.length <= MAX_IMAGE_BYTES && bytes[0] === 0xff && bytes[1] === 0xd8 ? bytes : null;
}
