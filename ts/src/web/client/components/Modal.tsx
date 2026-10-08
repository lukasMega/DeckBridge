// The scrim + `.popover` dialog shell of the About, Image fit, Crop and pairing-address
// dialogs. DocsLink and side-keys help are native <dialog>s (top layer), not this shell.
import type { ComponentChildren } from 'preact';
import { useDismiss } from '../lib/ui-hooks.js';
import { ICON } from './Icon.js';

/** A click on a native <dialog>'s ::backdrop reports the dialog itself as the target, so the
 *  pointer position tells it apart from a click on its own padding. */
export function isBackdropClick(e: MouseEvent): boolean {
  if (e.target !== e.currentTarget) return false;
  const b = (e.currentTarget as HTMLElement).getBoundingClientRect();
  return e.clientX < b.left || e.clientX > b.right || e.clientY < b.top || e.clientY > b.bottom;
}

export function Modal({
  id,
  class: cls,
  title,
  titleId,
  label,
  closeId,
  closeLabel = 'Close',
  onClose,
  children,
}: Readonly<{
  id?: string;
  /** Extra classes on the surface. */
  class?: string;
  title: string;
  /** Names the dialog; omit it and pass `label` when the title is not its name. */
  titleId?: string;
  label?: string;
  closeId?: string;
  closeLabel?: string;
  /** Escape, scrim click and the close button all call this. */
  onClose: () => void;
  children: ComponentChildren;
}>): preact.JSX.Element {
  useDismiss(onClose);

  return (
    <div
      class="scrim"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        class={cls === undefined ? 'popover floating-surface' : `popover floating-surface ${cls}`}
        id={id}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-label={label}
      >
        <button
          class="pop-close circle"
          id={closeId}
          aria-label={closeLabel}
          type="button"
          onClick={onClose}
          // eslint-disable-next-line @eslint-react/dom-no-dangerously-set-innerhtml -- static trusted SVG icon markup
          dangerouslySetInnerHTML={{ __html: ICON.close }}
        />
        <h2 id={titleId}>{title}</h2>
        {children}
      </div>
    </div>
  );
}
