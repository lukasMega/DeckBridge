// Shared leaf widgets — dedupe the dangerouslySetInnerHTML boilerplate.
import { ICON } from '../ui-icons.js';

/** Inline SVG/HTML in a <span>. */
export function Icon({
  html,
  class: cls,
}: Readonly<{ html: string; class?: string }>): preact.JSX.Element {
  // eslint-disable-next-line @eslint-react/dom-no-dangerously-set-innerhtml -- static trusted SVG icon markup
  return <span class={cls} dangerouslySetInnerHTML={{ __html: html }} />;
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
