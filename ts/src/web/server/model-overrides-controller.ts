// The device-tuning (model override) HTTP surface. Mirrors
// settings-identity-controller.ts: validation + persistence glue around
// PersistedSettings, with the pure merge/validate living in devices/model-overrides.ts.
import type { ControllerHost, OverrideChange, ReqError } from './types.js';
import type { DeviceModelOverride } from '../../devices/driver.js';
import { advertisedModel, findModelById } from '../../devices/registry.js';
import {
  applyModelOverrides,
  classifyOverrideChange,
  emulationProfiles,
  tunableDefaults,
  validateModelOverride,
} from '../../devices/model-overrides.js';
import type { OverrideChangeKind } from '../../devices/model-overrides.js';
import { overridesDisabled } from '../../shared/cli.js';
import type { DeviceOverridesView } from '../contract.js';

export class ModelOverridesController {
  constructor(
    private readonly host: ControllerHost,
    /** Model id of the currently selected dock — the default target when a
     *  request omits `modelId`. */
    private readonly selectedModelId: () => string,
  ) {}

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
    const advertised = advertisedModel(effective);
    return {
      modelId: id,
      modelName: model.name,
      defaults: tunableDefaults(model),
      overrides,
      safeMode,
      effective: {
        image: effective.image,
        keyMap: effective.keyMap,
        wire: { ...effective.wire },
        ...(effective.splash ? { splash: effective.splash } : {}),
        cora: effective.cora,
      },
      tunable: tunableDefaults(effective),
      profiles: emulationProfiles(model).map((p) => ({
        id: p.id,
        name: p.name,
        productId: p.cora.productId,
      })),
      sourceSize: { width: advertised.keyWidth, height: advertised.keyHeight },
    };
  }

  /** Validate + persist one model's override, then tell the device layer how to
   *  apply it: an image-only change swaps live, anything else (keyMap/wire/
   *  splash) must be in force from the next open(), so the session reopens. */
  trySet(modelId: unknown, overrides: unknown): ReqError | OverrideChange {
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
  tryReset(modelId: unknown): ReqError | OverrideChange {
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
