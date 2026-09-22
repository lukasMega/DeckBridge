// The device-tuning (model override) HTTP surface. Mirrors
// settings-identity-controller.ts: validation + persistence glue around
// PersistedSettings, with the pure merge/validate living in devices/model-overrides.ts.
import type { ControllerHost, ReqError } from './types.js';
import type { DeviceModel, DeviceModelOverride } from '../../devices/driver.js';
import { findModelById, CORA_PROFILES } from '../../devices/registry.js';
import {
  applyModelOverrides,
  classifyOverrideChange,
  tunableDefaults,
  validateModelOverride,
} from '../../devices/model-overrides.js';
import type { OverrideChangeKind } from '../../devices/model-overrides.js';
import { overridesDisabled } from '../../cli.js';

/** GET /api/device-overrides payload: the registry values (`defaults`), what the
 *  user has set (`overrides`), what the device is actually running (`effective`),
 *  and the form seed (`tunable`). */
export interface DeviceOverridesView {
  modelId: string;
  modelName: string;
  defaults: DeviceModelOverride;
  overrides: DeviceModelOverride;
  /** True in safe mode (`--no-overrides`): `overrides` is still persisted (so
   *  Reset works) but `effective` equals the registry defaults, because that is
   *  what the device is actually running. */
  safeMode: boolean;
  /** The FULL effective spec — for display/diagnostics. Do NOT seed the form from this: it
   *  carries the non-tunable protocol facts (`format`, `colorMode`, `bmpPpm`) too, and
   *  POSTing them straight back is rejected by validateModelOverride. Seed from `tunable` instead. */
  effective: Pick<DeviceModel, 'image' | 'keyMap' | 'wire' | 'splash' | 'cora'>;
  /** `effective`, projected down to exactly the fields an override may set — so a
   *  round-trip (seed the form → Apply unchanged) is always valid. */
  tunable: DeviceModelOverride;
  /** Emulation profiles a device may re-pair as (id → advertised productId). */
  profiles: Array<{ id: string; name: string; productId: number }>;
}

export class ModelOverridesController {
  constructor(
    private readonly host: ControllerHost,
    /** Model id of the currently selected dock — the default target when a
     *  request omits `modelId`. */
    private readonly selectedModelId: () => string,
  ) {}

  overrideFor(modelId: string): DeviceModelOverride | undefined {
    return this.host.settings.overrideFor(modelId);
  }

  all(): Record<string, DeviceModelOverride> {
    return this.host.settings.allModelOverrides();
  }

  /** Registry defaults + persisted override + the resulting effective spec.
   *  404-shaped error when the id names no registry model. */
  view(modelId?: unknown): DeviceOverridesView | ReqError {
    if (modelId !== undefined && typeof modelId !== 'string') {
      return { error: 'modelId must be a string', status: 400 };
    }
    const id = modelId ?? this.selectedModelId();
    const model = findModelById(id);
    if (!model) return { error: `unknown modelId '${id}'`, status: 404 };
    const overrides = this.host.settings.overrideFor(id) ?? {};
    // Safe mode: report what the device is RUNNING, not what is stored — the one
    // time a user is looking at this panel is when a bad override made the device
    // look dead, and a view that disagreed with the hardware would mislead them.
    const safeMode = overridesDisabled();
    const effective = applyModelOverrides(model, safeMode ? undefined : overrides);
    return {
      modelId: id,
      modelName: model.name,
      defaults: tunableDefaults(model),
      overrides,
      safeMode,
      effective: {
        image: effective.image,
        keyMap: effective.keyMap,
        wire: effective.wire,
        ...(effective.splash ? { splash: effective.splash } : {}),
        cora: effective.cora,
      },
      tunable: tunableDefaults(effective),
      profiles: CORA_PROFILES.map((p) => ({
        id: p.id,
        name: p.name,
        productId: p.cora.productId,
      })),
    };
  }

  /** Validate + persist one model's override, then tell the device layer how to
   *  apply it: an image-only change swaps live, anything else (keyMap/wire/
   *  splash) must be in force from the next open(), so the session reopens. */
  trySet(modelId: unknown, overrides: unknown): ReqError | { kind: OverrideChangeKind } {
    if (typeof modelId !== 'string' || !modelId) {
      return { error: 'modelId must be a non-empty string', status: 400 };
    }
    const model = findModelById(modelId);
    if (!model) return { error: `unknown modelId '${modelId}'`, status: 404 };
    const result = validateModelOverride(overrides, model);
    if (!result.ok) return { error: result.errors.join('; '), status: 400 };
    const kind = this.changeKind(modelId, result.value);
    this.host.settings.setModelOverride(modelId, result.value);
    this.host.emit('modelOverridesChanged', modelId, kind);
    return { kind };
  }

  /** Back to registry defaults for this model. Reachable without a working
   *  device — a bad keyMap can make the panel look dead, and this is the way
   *  back short of `--no-overrides`. */
  tryReset(modelId: unknown): ReqError | { kind: OverrideChangeKind } {
    if (typeof modelId !== 'string' || !modelId) {
      return { error: 'modelId must be a non-empty string', status: 400 };
    }
    const kind = this.changeKind(modelId, undefined);
    this.host.settings.setModelOverride(modelId, undefined);
    this.host.emit('modelOverridesChanged', modelId, kind);
    return { kind };
  }

  /** In safe mode the device is running registry defaults and must keep running
   *  them until the next start, so a persisted change touches no session. */
  private changeKind(modelId: string, next: DeviceModelOverride | undefined): OverrideChangeKind {
    if (overridesDisabled()) return 'none';
    return classifyOverrideChange(this.host.settings.overrideFor(modelId), next);
  }
}
