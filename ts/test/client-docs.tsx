import { render } from 'preact';
import { act } from 'preact/test-utils';
import { DocsLink } from '../src/web/client/components/DocsLink.js';
import { AboutPopover } from '../src/web/client/simple/overlays.js';

export async function runDocsLinks(
  root: HTMLElement,
  check: (condition: boolean, message: string) => void,
): Promise<void> {
  for (const block of [false, true]) {
    await act(() => render(<DocsLink topic="image-fit" block={block} />, root));
    const link = root.querySelector<HTMLAnchorElement>('.docs-link-group a')!;
    const trigger = root.querySelector<HTMLButtonElement>('.docs-modal-open')!;
    check(
      link.getAttribute('href') === '/go/docs/image-fit' && link.target === '_blank',
      `Docs retains new-tab navigation (${block})`,
    );
    check(root.querySelector('iframe') === null, 'Docs iframe loads only after opening');
    trigger.focus();
    await act(() => trigger.click());
    const dialog = root.querySelector<HTMLDialogElement>('.docs-modal')!;
    const frame = dialog.querySelector('iframe')!;
    check(dialog.open && dialog.matches(':modal'), 'Docs opens native modal dialog');
    check(frame.getAttribute('src') === link.getAttribute('href'), 'Docs iframe uses same topic');
    check(frame.title === 'Documentation', 'Docs iframe has accessible title');
    check(trigger.getAttribute('aria-expanded') === 'true', 'Docs trigger reflects open state');
    await act(() => dialog.querySelector<HTMLButtonElement>('.docs-modal-close')!.click());
    check(root.querySelector('iframe') === null, 'Docs close removes iframe');
    check(document.activeElement === trigger, 'Docs close restores trigger focus');
    await act(() => render(null, root));
  }

  let parentClosed = false;
  await act(() =>
    render(
      <AboutPopover
        onClose={() => {
          parentClosed = true;
        }}
      />,
      root,
    ),
  );
  const trigger = root.querySelector<HTMLButtonElement>('.docs-modal-open')!;
  await act(() => trigger.click());
  const dialog = root.querySelector<HTMLDialogElement>('.docs-modal')!;
  await act(() => {
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    dialog.requestClose();
  });
  // The native close event is queued after requestClose(), and how late it lands depends on load.
  for (let i = 0; i < 200 && root.querySelector('.docs-modal') !== null; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  check(root.querySelector('.docs-modal') === null, 'Docs dismisses through native Escape path');
  check(!parentClosed, 'Docs Escape preserves underlying About overlay');
  await act(() => trigger.click());
  const reopened = root.querySelector<HTMLDialogElement>('.docs-modal')!;
  const bounds = reopened.getBoundingClientRect();
  await act(() => {
    reopened.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        clientX: bounds.left - 1,
        clientY: bounds.top - 1,
      }),
    );
  });
  check(root.querySelector('.docs-modal') === null, 'Docs backdrop closes modal');
  check(!parentClosed, 'Docs backdrop preserves underlying About overlay');
  await act(() => trigger.click());
  await act(() => render(null, root));
  check(document.querySelector('.docs-modal') === null, 'Parent unmount cleans up docs modal');
}
