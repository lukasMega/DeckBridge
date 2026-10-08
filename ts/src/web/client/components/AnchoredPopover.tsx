// The `.xkey-popover` shell opened from a side-key control: Escape or a press outside
// the anchor closes it, and it shifts into view when it would be clipped.
import { useRef } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { useDismiss, useKeepInApp } from '../lib/ui-hooks.js';

export function AnchoredPopover({
  anchorRef,
  onClose,
  class: cls,
  label,
  content,
  children,
}: Readonly<{
  anchorRef: { current: HTMLElement | null };
  onClose: () => void;
  class?: string;
  /** Accessible name of the popover dialog. */
  label: string;
  /** Changes when the size does, so the position is re-measured. */
  content?: unknown;
  children: ComponentChildren;
}>): preact.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  useDismiss(onClose, anchorRef);
  useKeepInApp(ref, content);
  return (
    <div
      ref={ref}
      class={
        cls === undefined ? 'xkey-popover floating-surface' : `xkey-popover floating-surface ${cls}`
      }
      role="dialog"
      aria-label={label}
    >
      {children}
    </div>
  );
}
