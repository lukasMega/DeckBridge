// Status chip: tinted pill with a leading dot/icon/spinner + label.
// Used by the simple dock cards (via DockChip) and the advanced header pills.
// Styling rides the existing .dock-chip classes in ui-simple.css.
import type { ComponentChildren } from 'preact';
import { Icon } from '../simple/Icon.js';

export type StatusChipVariant = 'ok' | 'wait' | 'accent' | 'dim';

const VARIANT_CLASS: Record<StatusChipVariant, string> = {
  ok: 'dock-chip--paired',
  wait: 'dock-chip--waiting',
  accent: 'dock-chip--pairing',
  dim: 'dock-chip--dim',
};

export function StatusChip({
  variant,
  icon,
  spin,
  id,
  children,
}: Readonly<{
  variant: StatusChipVariant;
  /** Inline SVG markup for the leading icon; omit for a plain dot. */
  icon?: string;
  /** Spinner instead of dot/icon. */
  spin?: boolean;
  id?: string;
  children: ComponentChildren;
}>): preact.JSX.Element {
  let lead = <span class="chip-dot" />;
  if (spin) lead = <span class="ico-spin" />;
  else if (icon !== undefined) lead = <Icon html={icon} />;
  return (
    <span id={id} class={`dock-chip ${VARIANT_CLASS[variant]}`}>
      {lead}
      {children}
    </span>
  );
}
