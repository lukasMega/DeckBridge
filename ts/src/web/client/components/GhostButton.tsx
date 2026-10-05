import type { ButtonHTMLAttributes } from 'preact';

/** The `.ghostbtn` action button. A returned promise is dropped on purpose: its
 *  errors are reported through the caller's AsyncAction. */
export function GhostButton({
  onClick,
  ...rest
}: Readonly<
  Omit<ButtonHTMLAttributes, 'onClick' | 'class' | 'type'> & {
    onClick: () => unknown;
  }
>): preact.JSX.Element {
  return <button {...rest} class="ghostbtn" type="button" onClick={() => void onClick()} />;
}
