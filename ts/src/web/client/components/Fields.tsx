// Labelled form controls shared by the settings-page panels (device tuning,
// diagnostics, widget popovers, touch strip). Markup is fixed by ui-simple.css:
// `.tuning-field` for the number/select rows, `.settings-checkbox` for checkboxes.

function numberOrUndefined(raw: string): number | undefined {
  if (raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** Seconds input that posts milliseconds. Out-of-range values are ignored rather
 *  than clamped — the number spinner would otherwise fight the user mid-typing. */
export function SecondsField({
  class: cls = 'xkey-popover-field',
  label,
  min,
  max,
  value,
  onCommit,
}: Readonly<{
  class?: string;
  label: string;
  min: number;
  max: number;
  value: number;
  onCommit: (ms: number) => void;
}>): preact.JSX.Element {
  const handleChange = (e: Event): void => {
    const s = Number((e.target as HTMLInputElement).value);
    if (!Number.isFinite(s) || s < min || s > max) return;
    onCommit(Math.round(s * 1000));
  };

  return (
    <label class={cls}>
      <span>{label}</span>
      <input
        class="input"
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={handleChange}
      />
    </label>
  );
}

export function NumberField({
  label,
  labelHidden,
  value,
  min,
  max,
  step,
  onChange,
}: Readonly<{
  label: string;
  /** Visually drop the label where a surrounding group already names the field. */
  labelHidden?: boolean;
  value: number | undefined;
  min: number;
  max?: number;
  step?: number;
  onChange: (v: number | undefined) => void;
}>): preact.JSX.Element {
  return (
    <label class="tuning-field">
      {labelHidden === true ? <span class="visually-hidden">{label}</span> : <span>{label}</span>}
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

export function SelectField<T extends string | number>({
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

export function CheckField({
  id,
  label,
  checked,
  onChange,
}: Readonly<{
  id?: string;
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}>): preact.JSX.Element {
  return (
    <label class="settings-checkbox">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange((e.target as HTMLInputElement).checked)}
      />
      <span>{label}</span>
    </label>
  );
}

export function ToggleRow({
  id,
  label,
  checked,
  onChange,
  children,
}: Readonly<{
  id?: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  children?: preact.ComponentChildren;
}>): preact.JSX.Element {
  return (
    <div class="toggle-row">
      <CheckField id={id} label={label} checked={checked} onChange={onChange} />
      {children}
    </div>
  );
}
