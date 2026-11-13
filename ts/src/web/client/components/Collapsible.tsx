// Collapsible section: clickable header (title + optional subtitle + arrow)
// + animated body. Used by the advanced panels (Device Config, Settings,
// Key Events) and the simple settings page (saved-settings JSON preview).
import { useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';

export function Collapsible({
  title,
  subtitle,
  status,
  class: cls,
  id,
  bodyId,
  defaultOpen = false,
  onToggle,
  children,
}: Readonly<{
  title: string;
  subtitle?: string;
  /** Collapsed summary; null means still loading. */
  status?: string | boolean | null;
  class?: string;
  id?: string;
  bodyId?: string;
  defaultOpen?: boolean;
  /** Called with the new open state after a header click. */
  onToggle?: (open: boolean) => void;
  children: ComponentChildren;
}>): preact.JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  const toggle = (): void => {
    const next = !open;
    setOpen(next);
    onToggle?.(next);
  };
  const rootClass = cls !== undefined ? `collapsible ${cls}` : 'collapsible';
  const enabledText = status === true ? 'Enabled' : 'Disabled';
  const statusText = typeof status === 'boolean' ? enabledText : (status ?? 'Loading…');
  return (
    <div class={rootClass} id={id}>
      <h3 class={`collapse-header${open ? '' : ' collapsed'}`} onClick={toggle}>
        <span>
          {title}
          {subtitle !== undefined && <span class="cfg-subtitle-hdr"> {subtitle}</span>}
          {!open && status !== undefined && (
            <span class="cfg-subtitle-hdr collapse-status"> · {statusText}</span>
          )}
        </span>
        <span class="collapse-arrow">▼</span>
      </h3>
      <div id={bodyId} class={`collapse-body${open ? ' open' : ''}`}>
        {children}
      </div>
    </div>
  );
}
