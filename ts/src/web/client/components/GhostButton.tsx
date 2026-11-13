import type { ButtonHTMLAttributes } from 'preact';

/** The `.ghostbtn` action button. A returned promise is dropped on purpose: its
 *  errors are reported through the caller's AsyncAction. */
export function GhostButton({
  onClick,
  class: cls,
  ...rest
}: Readonly<
  Omit<ButtonHTMLAttributes, 'onClick' | 'class' | 'type'> & {
    onClick: () => unknown;
    /** Extra classes beside `ghostbtn`. */
    class?: string;
  }
>): preact.JSX.Element {
  return (
    <button
      {...rest}
      class={cls === undefined ? 'ghostbtn' : `ghostbtn ${cls}`}
      type="button"
      onClick={() => void onClick()}
    />
  );
}
