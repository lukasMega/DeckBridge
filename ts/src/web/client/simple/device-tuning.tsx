// Settings-page device tuning over POST /api/device-overrides.
// Supports runtime calibration before copying values into a registry PR.
// Key-map wizard lives in keymap-learn.tsx.
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { Collapsible } from '../components/Collapsible.js';
import { CheckField, NumberField, SelectField } from '../components/Fields.js';
import { useStore } from '../store.js';
import type { StoreState } from '../store.js';
import { copyLabel, useCopyText } from '../use-copy-text.js';
import { postJson } from '../ui-api.js';
import { Feedback, useAsyncAction } from '../ui-async.js';
import { KeymapLearn } from './keymap-learn.js';
import type { DeviceImageOverride, DeviceOverridesView } from '../ui-types.js';

const ROTATIONS = [0, 90, 180, 270] as const;
const RESIZE_FILTERS = ['triangle', 'nearest', 'lanczos3'] as const;
const RESIZE_MODES = ['resize', 'pad'] as const;
const PAD_FILLS = ['black', 'average', 'edge'] as const;

/** Numeric fields rendered as a plain number input, with their bounds. Bounds
 *  mirror devices/model-overrides.ts — the server re-validates regardless. */
const NUMBER_FIELDS: ReadonlyArray<{
  key: keyof DeviceImageOverride;
  label: string;
  min: number;
  max?: number;
  step?: number;
  advanced?: boolean;
}> = [
  { key: 'width', label: 'Width (px)', min: 8, max: 1024 },
  { key: 'height', label: 'Height (px)', min: 8, max: 1024 },
  { key: 'quality', label: 'JPEG quality (0.05–1)', min: 0.05, max: 1, step: 0.05 },
  { key: 'maxBytes', label: 'Max image bytes (0 = no cap)', min: 0 },
  { key: 'sharpen', label: 'Sharpen sigma', min: 0, step: 0.1, advanced: true },
  { key: 'blur', label: 'Blur sigma', min: 0, step: 0.1, advanced: true },
  { key: 'crop', label: 'Crop (px per side)', min: 0, advanced: true },
];

function selectedModel(state: StoreState): string | undefined {
  const selectedDock = state.status.selectedDock ?? 0;
  return (
    state.status.docks?.find((dock) => dock.index === selectedDock)?.modelId ?? state.status.modelId
  );
}

function matchingView(
  view: DeviceOverridesView | null,
  selectedModelId: string | undefined,
): DeviceOverridesView | null {
  return view && (!selectedModelId || view.modelId === selectedModelId) ? view : null;
}

function EmptyDeviceTuningPanel(): preact.JSX.Element {
  return (
    <Collapsible
      title="Device tuning"
      class="tuning-section"
      id="device-tuning"
      bodyId="device-tuning-body"
    >
      <p class="help-lead">No device model available yet.</p>
    </Collapsible>
  );
}

export function DeviceTuningPanel(): preact.JSX.Element {
  const selectedModelId = useStore(selectedModel);
  const selectedModelIdRef = useRef(selectedModelId);
  selectedModelIdRef.current = selectedModelId;
  const loadSeqRef = useRef(0);
  const [view, setView] = useState<DeviceOverridesView | null>(null);
  const [image, setImage] = useState<DeviceImageOverride>({});
  const action = useAsyncAction();
  const resetFeedback = action.reset;
  const copy = useCopyText();

  const load = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      const requested = selectedModelId;
      // Calls retained by an earlier Apply/Reset/learn callback must not start
      // another request after selection changes.
      if (requested !== selectedModelIdRef.current) return;
      const seq = ++loadSeqRef.current;
      const query = selectedModelId ? `?modelId=${encodeURIComponent(selectedModelId)}` : '';
      const r = await fetch(`/api/device-overrides${query}`, signal ? { signal } : {});
      if (!r.ok) throw new Error(`Could not load device tuning (${r.status})`);
      const data = (await r.json()) as DeviceOverridesView;
      if (seq !== loadSeqRef.current || requested !== selectedModelIdRef.current) return;
      setView(data);
      // `tunable` mirrors active settable values without rejected protocol facts.
      // Reloading intentionally discards drafts so edits never follow another dock.
      setImage({ ...data.tunable.image });
    },
    [selectedModelId],
  );

  useEffect(
    function loadSelectedModel() {
      const ctrl = new AbortController();
      // Selection boundary: feedback for the previous model must disappear before
      // the next request finishes, and must never describe the newly selected one.
      resetFeedback();
      void load(ctrl.signal).catch(function handleLoadError() {
        if (!ctrl.signal.aborted) setView(null);
      });
      return function abortSelectedModelLoad() {
        ctrl.abort();
      };
    },
    [load, resetFeedback],
  );

  // Never leave previous dock's controls actionable while its replacement view
  // is loading after a selection change.
  const activeView = matchingView(view, selectedModelId);

  // Both actions report via setStatus and only then reload: a status published
  // after the reload could outlive the selection it describes.
  const apply = (): Promise<void> =>
    action.run(async () => {
      if (!activeView) return;
      const parsed = await postJson<{ reconnecting?: boolean }>(
        '/api/device-overrides',
        { modelId: activeView.modelId, overrides: { ...activeView.overrides, image } },
        'Save failed',
      );
      action.setStatus(parsed.reconnecting ? 'Reapplying — the device reconnects…' : 'Saved.');
      await load();
    }, 'Save failed.');

  const resetDefaults = (): Promise<void> =>
    action.run(async () => {
      if (!activeView) return;
      await postJson(
        '/api/device-overrides/reset',
        { modelId: activeView.modelId },
        'Reset failed',
      );
      action.setStatus('Reset to the built-in defaults — the device reconnects…');
      await load();
    }, 'Reset failed.');

  if (!activeView) return <EmptyDeviceTuningPanel />;

  const patch = (p: Partial<DeviceImageOverride>): void => setImage({ ...image, ...p });
  const basic = NUMBER_FIELDS.filter((f) => !f.advanced);
  const advanced = NUMBER_FIELDS.filter((f) => f.advanced);

  return (
    <Collapsible
      title={`Device tuning — ${activeView.modelName}`}
      class="tuning-section"
      id="device-tuning"
      bodyId="device-tuning-body"
    >
      <p class="help-lead">
        Adjust how images are sent to this model. Changes apply to every unit of{' '}
        <code>{activeView.modelId}</code> and take effect on reconnect. If the panel goes dark,
        press Reset, or restart with <code>--no-overrides</code>.
      </p>

      {activeView.safeMode === true && (
        <p class="settings-error" id="tuning-safe-mode">
          Safe mode (<code>--no-overrides</code>): saved tuning is ignored this session, so the
          device is running the built-in defaults. Restart without the flag to apply it again.
        </p>
      )}

      <div class="tuning-grid">
        <SelectField
          label="Rotation"
          value={image.rotate ?? 0}
          options={ROTATIONS}
          onChange={(rotate) => patch({ rotate })}
        />
        <SelectField
          label="Image fit"
          value={image.resizeMode ?? 'resize'}
          options={RESIZE_MODES}
          onChange={(resizeMode) => patch({ resizeMode })}
        />
        <SelectField
          label="Pad fill (fit = pad)"
          value={image.padFill ?? 'edge'}
          options={PAD_FILLS}
          onChange={(padFill) => patch({ padFill })}
        />
        {basic.map((f) => (
          <NumberField
            key={f.key}
            label={f.label}
            value={image[f.key] as number | undefined}
            min={f.min}
            max={f.max}
            step={f.step}
            onChange={(v) => patch({ [f.key]: v })}
          />
        ))}
      </div>
      <CheckField
        label="Flip horizontally"
        checked={image.flipH ?? false}
        onChange={(flipH) => patch({ flipH })}
      />
      <CheckField
        label="Flip vertically"
        checked={image.flipV ?? false}
        onChange={(flipV) => patch({ flipV })}
      />

      <Collapsible title="Advanced">
        <div class="tuning-grid">
          {advanced.map((f) => (
            <NumberField
              key={f.key}
              label={f.label}
              value={image[f.key] as number | undefined}
              min={f.min}
              max={f.max}
              step={f.step}
              onChange={(v) => patch({ [f.key]: v })}
            />
          ))}
          <SelectField
            label="Resize filter"
            value={image.resizeFilter ?? 'triangle'}
            options={RESIZE_FILTERS}
            onChange={(resizeFilter) => patch({ resizeFilter })}
          />
        </div>
      </Collapsible>

      <div class="settings-actions">
        <button
          id="tuning-apply"
          class="ghostbtn"
          type="button"
          disabled={action.busy}
          onClick={() => void apply()}
        >
          Apply
        </button>
        <button
          id="tuning-reset"
          class="ghostbtn"
          type="button"
          disabled={action.busy}
          onClick={() => void resetDefaults()}
        >
          Reset to defaults
        </button>
        <button
          id="tuning-copy"
          class="ghostbtn"
          type="button"
          onClick={() =>
            void copy.copy(JSON.stringify({ [activeView.modelId]: activeView.overrides }, null, 2))
          }
        >
          {copyLabel(copy.status, 'Copy overrides as JSON')}
        </button>
      </div>
      <Feedback error={action.error} status={action.status} />

      <KeymapLearn view={activeView} onSaved={() => void load()} />
    </Collapsible>
  );
}
