// Radio group rendered as bordered chips (device tuning, touch-strip mode).
// The native radio is visually hidden, so the chip carries the focus ring (ui-simple.css).
import type { ComponentChildren } from 'preact';

export interface ChipOption<T extends string | number> {
  value: T;
  label: ComponentChildren;
  title?: string;
  /** Option shown but not selectable (e.g. an image fit with no effect). */
  disabled?: boolean;
}

export function ChipRadioGroup<T extends string | number>({
  name,
  label,
  value,
  options,
  class: cls,
  onChange,
}: Readonly<{
  /** Radio `name` — e2e/regression tests select inputs by it. */
  name: string;
  /** Accessible name of the group. */
  label: string;
  value: T;
  options: ReadonlyArray<ChipOption<T>>;
  class?: string;
  onChange: (value: T) => void;
}>): preact.JSX.Element {
  return (
    <div
      class={cls !== undefined ? `chip-radio-group ${cls}` : 'chip-radio-group'}
      role="radiogroup"
      aria-label={label}
    >
      {options.map((option) => (
        <label
          key={String(option.value)}
          class={option.disabled === true ? 'chip-radio is-disabled' : 'chip-radio'}
          title={option.title}
        >
          <input
            type="radio"
            name={name}
            value={String(option.value)}
            checked={option.value === value}
            disabled={option.disabled}
            onChange={() => onChange(option.value)}
          />
          {option.label}
        </label>
      ))}
    </div>
  );
}
