// Shared leaf widgets — dedupe the dangerouslySetInnerHTML boilerplate.
import { ICON } from '../ui-icons.js';

/** Inline SVG/HTML in a <span>. `title` also names it for assistive tech —
 *  a native tooltip alone is not exposed reliably. */
export function Icon({
  html,
  class: cls,
  title,
}: Readonly<{ html: string; class?: string; title?: string }>): preact.JSX.Element {
  return (
    <span
      class={cls}
      title={title}
      role={title === undefined ? undefined : 'img'}
      aria-label={title}
      tabIndex={title === undefined ? undefined : 0}
      // eslint-disable-next-line @eslint-react/dom-no-dangerously-set-innerhtml -- static trusted SVG icon markup
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** The "?" help affordance used by steps and the manual-add panel. */
export function HelpButton({
  helpId,
  onHelp,
  ariaLabel,
  title,
}: Readonly<{
  helpId: string;
  onHelp: (id: string) => void;
  ariaLabel: string;
  title: string;
}>): preact.JSX.Element {
  return (
    <button
      class="step-help circle"
      type="button"
      data-help={helpId}
      aria-label={ariaLabel}
      title={title}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onHelp(helpId);
      }}
      // eslint-disable-next-line @eslint-react/dom-no-dangerously-set-innerhtml -- static trusted SVG icon markup
      dangerouslySetInnerHTML={{ __html: ICON.help }}
    />
  );
}
