// The `.xkey-popover` shell opened from a side-key control: Escape or a press outside
// the anchor closes it.
import { useRef } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { useDismiss, useKeepInApp } from '../lib/ui-hooks.js';

export function AnchoredPopover({
  anchorRef,
  onClose,
  class: cls,
  label,
  keepInApp = false,
  content,
  children,
}: Readonly<{
  anchorRef: { current: HTMLElement | null };
  onClose: () => void;
  class?: string;
  /** Names the popover; without it the popover is a plain, unannounced box. */
  label?: string;
  /** Shift into view when it would be clipped. */
  keepInApp?: boolean;
  /** Changes when the size does, so the position is re-measured. */
  content?: unknown;
  children: ComponentChildren;
}>): preact.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  useDismiss(onClose, anchorRef);
  useKeepInApp(ref, content, keepInApp);
  return (
    <div
      ref={ref}
      class={
        cls === undefined ? 'xkey-popover floating-surface' : `xkey-popover floating-surface ${cls}`
      }
      role={label === undefined ? undefined : 'dialog'}
      aria-label={label}
    >
      {children}
    </div>
  );
}
