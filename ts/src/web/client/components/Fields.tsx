// Labelled form controls shared by the settings-page panels (device tuning,
// diagnostics). Markup is fixed by ui-simple.css: `.tuning-field` for the
// number/select rows, `.settings-checkbox` for checkboxes.

function numberOrUndefined(raw: string): number | undefined {
  if (raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

export function NumberField({
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
