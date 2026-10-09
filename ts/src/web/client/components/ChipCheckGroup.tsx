import type { ChipOption } from './ChipRadioGroup.js';

export function ChipCheckGroup({
  name,
  label,
  value,
  options,
  onChange,
}: Readonly<{
  name: string;
  label: string;
  value: string[];
  options: ReadonlyArray<ChipOption<string>>;
  onChange: (value: string) => void;
}>): preact.JSX.Element {
  return (
    <div class="chip-radio-group" role="group" aria-label={label}>
      {options.map((option) => (
        <label key={option.value} class={option.disabled ? 'chip-radio is-disabled' : 'chip-radio'}>
          <input
            type="checkbox"
            name={name}
            value={option.value}
            checked={value.includes(option.value)}
            disabled={option.disabled}
            onChange={() => onChange(option.value)}
          />
          {option.label}
        </label>
      ))}
    </div>
  );
}
