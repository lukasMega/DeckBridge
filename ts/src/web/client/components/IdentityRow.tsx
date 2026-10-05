import { useState } from 'preact/hooks';

/** Blur is cosmetic (shoulder-surfing/screenshots) — the value stays in the DOM,
 *  so the hidden state says so rather than reading the value out. */
function SensitiveValue({ value }: Readonly<{ value: string }>): preact.JSX.Element {
  const [revealed, setRevealed] = useState(false);
  return (
    <button
      class={`identity-value identity-sensitive${revealed ? ' revealed' : ''}`}
      type="button"
      aria-pressed={revealed}
      aria-label={revealed ? value : 'Hidden — activate to show value'}
      title={revealed ? 'Hide sensitive value' : 'Show sensitive value'}
      onClick={() => setRevealed(!revealed)}
    >
      {value}
    </button>
  );
}

/** A labelled row: custom `children`, or a read-only `value` (blurred when `sensitive`). */
export function IdentityRow({
  label,
  value,
  sensitive,
  children,
  class: className,
}: Readonly<{
  label: string;
  value?: string | null;
  sensitive?: boolean;
  children?: preact.ComponentChildren;
  class?: string;
}>): preact.JSX.Element {
  return (
    <li class={className}>
      <span class="identity-label">{label}</span>
      {children ?? valueCell(value, sensitive === true)}
    </li>
  );
}

function valueCell(value: string | null | undefined, sensitive: boolean): preact.JSX.Element {
  if (!value) return <code class="identity-value">Unavailable</code>;
  return sensitive ? <SensitiveValue value={value} /> : <code class="identity-value">{value}</code>;
}
