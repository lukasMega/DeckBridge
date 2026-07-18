// Collapsible section: clickable header (title + optional subtitle + arrow)
// + animated body. Used by the advanced panels (Device Config, Settings,
// Key Events) and the simple settings page (saved-settings JSON preview).
import { useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';

export function Collapsible({
  title,
  subtitle,
  class: cls,
  id,
  bodyId,
  defaultOpen = false,
  onToggle,
  children,
}: Readonly<{
  title: string;
  subtitle?: string;
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
  return (
    <div class={rootClass} id={id}>
      <h3 class={`collapse-header${open ? '' : ' collapsed'}`} onClick={toggle}>
        <span>
          {title}
          {subtitle !== undefined && <span class="cfg-subtitle-hdr"> {subtitle}</span>}
        </span>
        <span class="collapse-arrow">▼</span>
      </h3>
      <div id={bodyId} class={`collapse-body${open ? ' open' : ''}`}>
        {children}
      </div>
    </div>
  );
}
