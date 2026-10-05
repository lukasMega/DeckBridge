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
  disabled,
  onChange,
}: Readonly<{
  label: string;
  /** Visually drop the label where a surrounding group already names the field. */
  labelHidden?: boolean;
  value: number | undefined;
  min: number;
  max?: number;
  step?: number;
  disabled?: boolean;
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
        disabled={disabled}
        onInput={(e) => onChange(numberOrUndefined((e.target as HTMLInputElement).value))}
      />
    </label>
  );
}

export function SelectField<T extends string | number>({
  label,
  value,
  options,
  optionLabel,
  disabled,
  onChange,
}: Readonly<{
  label: string;
  value: T | undefined;
  options: readonly T[];
  /** Display text per option; defaults to the value itself. */
  optionLabel?: (v: T) => string;
  disabled?: boolean;
  onChange: (v: T) => void;
}>): preact.JSX.Element {
  return (
    <label class="tuning-field">
      <span>{label}</span>
      <select
        class="input"
        value={String(value ?? '')}
        disabled={disabled}
        onChange={(e) => {
          const raw = (e.target as HTMLSelectElement).value;
          const match = options.find((o) => String(o) === raw);
          if (match !== undefined) onChange(match);
        }}
      >
        {options.map((o) => (
          <option key={String(o)} value={String(o)}>
            {optionLabel?.(o) ?? String(o)}
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
  disabled,
  onChange,
}: Readonly<{
  id?: string;
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}>): preact.JSX.Element {
  return (
    <label class="settings-checkbox">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange((e.target as HTMLInputElement).checked)}
      />
      <span>{label}</span>
    </label>
  );
}

/** Bare `.input` text box reporting its string value. */
export function TextInput({
  onChange,
  ...rest
}: Readonly<{
  value: string;
  placeholder?: string;
  'aria-label'?: string;
  maxLength?: number;
  disabled?: boolean;
  onChange: (v: string) => void;
}>): preact.JSX.Element {
  return (
    <input
      {...rest}
      class="input"
      type="text"
      onInput={(e) => onChange((e.target as HTMLInputElement).value)}
    />
  );
}

export function ToggleRow({
  id,
  label,
  checked,
  disabled,
  onChange,
  children,
}: Readonly<{
  id?: string;
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  children?: preact.ComponentChildren;
}>): preact.JSX.Element {
  return (
    <div class="toggle-row">
      <CheckField id={id} label={label} checked={checked} disabled={disabled} onChange={onChange} />
      {children}
    </div>
  );
}
