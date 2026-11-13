import { render } from 'preact';
import { act } from 'preact/test-utils';
import { useRef } from 'preact/hooks';
import { AnchoredPopover } from '../src/web/client/components/AnchoredPopover.js';
import { Modal } from '../src/web/client/components/Modal.js';

function press(target: EventTarget, type: string, init: EventInit & { key?: string }): void {
  target.dispatchEvent(type === 'keydown' ? new KeyboardEvent(type, init) : new Event(type, init));
}

function pressEscape(): void {
  press(window, 'keydown', { key: 'Escape' });
}

function Anchored({
  onClose,
  label,
}: Readonly<{ onClose: () => void; label: string }>): preact.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  return (
    <div id="anchor" ref={ref}>
      <AnchoredPopover anchorRef={ref} onClose={onClose} class="extra" label={label}>
        <span id="pop-body">body</span>
      </AnchoredPopover>
    </div>
  );
}

export async function runModalShells(
  root: HTMLElement,
  check: (condition: boolean, message: string) => void,
): Promise<void> {
  let closed = 0;
  const onClose = (): void => {
    closed++;
  };

  await act(() =>
    render(
      <Modal id="m" class="extra" title="Title" titleId="m-title" onClose={onClose}>
        <p id="m-body">text</p>
      </Modal>,
      root,
    ),
  );
  const scrim = root.querySelector<HTMLElement>('.scrim')!;
  const surface = root.querySelector<HTMLElement>('#m')!;
  const close = root.querySelector<HTMLButtonElement>('.pop-close')!;
  check(scrim.className === 'scrim', 'Modal scrim is the plain scrim');
  check(surface.className === 'popover floating-surface extra', 'Modal surface takes its class');
  check(
    surface.getAttribute('role') === 'dialog' &&
      surface.getAttribute('aria-modal') === 'true' &&
      surface.getAttribute('aria-labelledby') === 'm-title' &&
      !surface.hasAttribute('aria-label'),
    'Modal is a modal dialog named by its title',
  );
  check(root.querySelector('#m-title')?.textContent === 'Title', 'Modal renders the title');
  check(
    close.getAttribute('aria-label') === 'Close' && close.querySelector('svg') !== null,
    'Modal close button defaults to the labelled icon',
  );
  check(root.querySelector('#m-body') !== null, 'Modal renders its children');

  await act(() => surface.click());
  check(closed === 0, 'A click inside the surface keeps the Modal open');
  await act(() => scrim.click());
  check(closed === 1, 'A scrim click closes the Modal');
  await act(() => close.click());
  check(closed === 2, 'The close button closes the Modal');
  await act(() => press(window, 'keydown', { key: 'a' }));
  check(closed === 2, 'Other keys keep the Modal open');
  await act(pressEscape);
  check(closed === 3, 'Escape closes the Modal');

  await act(() =>
    render(
      <Modal
        title="Need"
        label="Named"
        closeId="named-close"
        closeLabel="Close named"
        onClose={onClose}
      >
        <p>text</p>
      </Modal>,
      root,
    ),
  );
  const named = root.querySelector<HTMLElement>('[role="dialog"]')!;
  const glyph = root.querySelector<HTMLButtonElement>('#named-close')!;
  check(
    named.getAttribute('aria-label') === 'Named' && !named.hasAttribute('aria-labelledby'),
    'Modal without a title id is named by its label',
  );
  check(
    glyph.querySelector('svg') !== null && glyph.getAttribute('aria-label') === 'Close named',
    'Modal close button takes its own label',
  );

  await act(() => render(null, root));
  await act(pressEscape);
  check(closed === 3, 'An unmounted Modal stops listening for Escape');

  let popClosed = 0;
  const onPopClose = (): void => {
    popClosed++;
  };
  await act(() => render(<Anchored onClose={onPopClose} label="Named popover" />, root));
  const pop = root.querySelector<HTMLElement>('.xkey-popover')!;
  check(
    pop.className === 'xkey-popover floating-surface extra' &&
      pop.getAttribute('role') === 'dialog' &&
      pop.getAttribute('aria-label') === 'Named popover',
    'A labelled AnchoredPopover is a named dialog',
  );
  await act(() => press(root.querySelector('#pop-body')!, 'pointerdown', { bubbles: true }));
  check(popClosed === 0, 'A press inside the anchor keeps the popover open');
  await act(() => press(document.body, 'pointerdown', { bubbles: true }));
  check(popClosed === 1, 'A press outside the anchor closes the popover');
  await act(pressEscape);
  check(popClosed === 2, 'Escape closes the popover');

  await act(() => render(null, root));
}
