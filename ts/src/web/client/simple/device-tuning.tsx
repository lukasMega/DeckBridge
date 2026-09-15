// "Device tuning" — the Settings-page form over POST /api/device-overrides.
//
// Exists so the person holding an untested board can find its correct rotation /
// flip / size / quality WITHOUT a build-per-guess loop, then copy the working
// values into a registry PR. The key-map editor lives in keymap-learn.tsx (both
// to keep this file under the 500-line check-loc gate and because it is a wizard,
// not a form).
import { useCallback, useEffect, useState } from 'preact/hooks';
import { Collapsible } from '../components/Collapsible.js';
import { copyLabel, useCopyText } from '../use-copy-text.js';
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

function numberOrUndefined(raw: string): number | undefined {
  if (raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function NumberField({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: Readonly<{
  label: string;
  value: number | undefined;
  min: number;
  max?: number;
  step?: number;
  onChange: (v: number | undefined) => void;
}>): preact.JSX.Element {
  return (
    <label class="tuning-field">
      <span>{label}</span>
      <input
        class="input"
        type="number"
        min={min}
        max={max}
        step={step ?? 1}
        value={value ?? ''}
        onInput={(e) => onChange(numberOrUndefined((e.target as HTMLInputElement).value))}
      />
    </label>
  );
}

function SelectField<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: Readonly<{
  label: string;
  value: T | undefined;
  options: readonly T[];
  onChange: (v: T) => void;
}>): preact.JSX.Element {
  return (
    <label class="tuning-field">
      <span>{label}</span>
      <select
        class="input"
        value={String(value ?? '')}
        onChange={(e) => {
          const raw = (e.target as HTMLSelectElement).value;
          const match = options.find((o) => String(o) === raw);
          if (match !== undefined) onChange(match);
        }}
      >
        {options.map((o) => (
          <option key={String(o)} value={String(o)}>
            {String(o)}
          </option>
        ))}
      </select>
    </label>
  );
}

function CheckField({
  label,
  checked,
  onChange,
}: Readonly<{
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}>): preact.JSX.Element {
  return (
    <label class="settings-checkbox">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange((e.target as HTMLInputElement).checked)}
      />
      <span>{label}</span>
    </label>
  );
}

export function DeviceTuningPanel(): preact.JSX.Element {
  const [view, setView] = useState<DeviceOverridesView | null>(null);
  const [image, setImage] = useState<DeviceImageOverride>({});
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const copy = useCopyText();

  const load = useCallback(async (signal?: AbortSignal): Promise<void> => {
    const r = await fetch('/api/device-overrides', signal ? { signal } : {});
    if (!r.ok) throw new Error(`Could not load device tuning (${r.status})`);
    const data = (await r.json()) as DeviceOverridesView;
    setView(data);
    // Seed from `tunable` (the effective spec projected down to the settable
    // fields), not from the (usually empty) override and NOT from `effective`:
    // every control starts at what the device is actually using, and Apply posts
    // back a shape the server accepts. `effective` also carries protocol facts
    // like `format`/`colorMode`, which validateModelOverride rejects outright.
    setImage({ ...data.tunable.image });
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal).catch(() => setView(null));
    return () => ctrl.abort();
  }, [load]);

  async function apply(): Promise<void> {
    if (!view) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const r = await fetch('/api/device-overrides', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelId: view.modelId,
          overrides: { ...view.overrides, image },
        }),
      });
      const parsed = (await r.json()) as { error?: string; reconnecting?: boolean };
      if (!r.ok) throw new Error(parsed.error ?? `Save failed (${r.status})`);
      setStatus(parsed.reconnecting ? 'Reapplying — the device reconnects…' : 'Saved.');
      await load();
    } catch (e) {
      setError((e as Error).message || 'Save failed.');
    } finally {
      setBusy(false);
    }
  }

  async function reset(): Promise<void> {
    if (!view) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const r = await fetch('/api/device-overrides/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId: view.modelId }),
      });
      if (!r.ok) throw new Error(`Reset failed (${r.status})`);
      setStatus('Reset to the built-in defaults — the device reconnects…');
      await load();
    } catch (e) {
      setError((e as Error).message || 'Reset failed.');
    } finally {
      setBusy(false);
    }
  }

  if (!view) {
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

  const patch = (p: Partial<DeviceImageOverride>): void => setImage({ ...image, ...p });
  const basic = NUMBER_FIELDS.filter((f) => !f.advanced);
  const advanced = NUMBER_FIELDS.filter((f) => f.advanced);

  return (
    <Collapsible
      title={`Device tuning — ${view.modelName}`}
      class="tuning-section"
      id="device-tuning"
      bodyId="device-tuning-body"
    >
      <p class="help-lead">
        Adjust how images are sent to this model. Changes apply to every unit of{' '}
        <code>{view.modelId}</code> and take effect on reconnect. If the panel goes dark, press
        Reset, or restart with <code>--no-overrides</code>.
      </p>

      {view.safeMode === true && (
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
          disabled={busy}
          onClick={() => void apply()}
        >
          Apply
        </button>
        <button
          id="tuning-reset"
          class="ghostbtn"
          type="button"
          disabled={busy}
          onClick={() => void reset()}
        >
          Reset to defaults
        </button>
        <button
          id="tuning-copy"
          class="ghostbtn"
          type="button"
          onClick={() =>
            void copy.copy(JSON.stringify({ [view.modelId]: view.overrides }, null, 2))
          }
        >
          {copyLabel(copy.status, 'Copy overrides as JSON')}
        </button>
      </div>
      {error && <p class="settings-error">{error}</p>}
      {status && !error && <p class="settings-status">{status}</p>}

      <KeymapLearn view={view} onSaved={() => void load()} />
    </Collapsible>
  );
}
