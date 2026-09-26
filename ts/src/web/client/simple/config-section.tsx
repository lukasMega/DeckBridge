// Ready-stage settings block (side keys, touch strip): brightness-style divider,
// live-preview-style uppercase head, then rows on the shared .xkey-grid columns.
import type { ComponentChildren } from 'preact';

export function ConfigSection({
  title,
  compact = false,
  subtitle,
  aside,
  children,
}: Readonly<{
  title: string;
  compact?: boolean;
  subtitle?: ComponentChildren;
  /** Right end of the head row (e.g. a mode select). */
  aside?: ComponentChildren;
  children?: ComponentChildren;
}>): preact.JSX.Element {
  return (
    <div class={compact ? 'xkeys xkeys-compact' : 'xkeys'} role="group" aria-label={title}>
      <div class="preview-head xkeys-head">
        <span class="preview-label">{title}</span>
        {aside}
      </div>
      {subtitle !== undefined && <p class="xkeys-sub">{subtitle}</p>}
      {children}
    </div>
  );
}

/** Column captions; `wide` spans the value + settings-button tracks. aria-hidden:
 *  every control carries its own aria-label. */
export function GridHeader({
  columns,
  class: cls,
}: Readonly<{
  columns: ReadonlyArray<{ label: string; wide?: boolean }>;
  class?: string;
}>): preact.JSX.Element {
  const rowClass = cls !== undefined ? `xkey-row xkey-grid-head ${cls}` : 'xkey-row xkey-grid-head';
  return (
    <div class={rowClass} aria-hidden="true">
      {columns.map(({ label, wide }) => (
        <span key={label} class={wide === true ? 'preview-label xkey-wide' : 'preview-label'}>
          {label}
        </span>
      ))}
    </div>
  );
}
