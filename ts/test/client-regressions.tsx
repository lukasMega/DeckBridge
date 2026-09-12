import { render } from 'preact';
import { act } from 'preact/test-utils';
import { useLayoutEffect } from 'preact/hooks';
import { patch, setBrightness, useStore } from '../src/web/client/store.js';
import { CopyChip } from '../src/web/client/simple/controls.js';
import { LogConsolePanel } from '../src/web/client/advanced-log-panel.js';

const root = document.createElement('div');
document.body.appendChild(root);
const results: string[] = [];
const noop = (): void => {};

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
  results.push(message);
}

function SelectedValue({ field }: Readonly<{ field: 'brightness' | 'imageMode' }>) {
  const value = useStore((s) => s[field]);
  return <output>{value}</output>;
}

function UpdateDuringMount() {
  useLayoutEffect(() => setBrightness(42), []);
  return null;
}

// Selector rebuilding a fresh object every call: without shallow memoization
// useSyncExternalStore never sees two Object.is-equal snapshots and loops forever.
let freshSelectorRenders = 0;
function FreshObjectSelector() {
  const { brightness } = useStore((s) => ({ brightness: s.brightness }));
  freshSelectorRenders++;
  return <output>{brightness}</output>;
}

async function click(selector: string): Promise<void> {
  const button = root.querySelector<HTMLButtonElement>(selector);
  if (!button) throw new Error(`Missing button: ${selector}`);
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
}

function elementText(selector: string): string {
  return root.querySelector(selector)?.textContent ?? '';
}

async function run(): Promise<void> {
  // Cases below replace navigator.clipboard in place; the last one installs a
  // never-resolving writeText. Restore the real descriptor at the end so anything
  // appended after that case starts from an unstubbed clipboard.
  const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  patch({ brightness: 10, imageMode: 'resize' });
  await act(() => render(<SelectedValue field="brightness" />, root));
  check(root.textContent === '10', 'Initial selector reads snapshot');
  await act(() => render(<SelectedValue field="imageMode" />, root));
  check(root.textContent === 'resize', 'Changed selector updates without store mutation');
  await act(() => patch({ imageMode: 'pad-black' }));
  check(root.textContent === 'pad-black', 'Subscription uses latest selector');
  await act(() => render(null, root));
  await act(() =>
    render(
      <>
        <SelectedValue field="brightness" />
        <UpdateDuringMount />
      </>,
      root,
    ),
  );
  check(root.textContent === '42', 'Mount-time store mutation is observed');
  await act(() => render(null, root));
  await act(() => setBrightness(99));
  check(root.textContent === '', 'Unmounted subscriber stays removed');

  await act(() => render(<FreshObjectSelector />, root));
  const rendersAfterMount = freshSelectorRenders;
  check(root.textContent === '99', 'Fresh-object selector reads snapshot');
  await act(() => setBrightness(7));
  check(root.textContent === '7', 'Fresh-object selector tracks updates');
  check(
    freshSelectorRenders - rendersAfterMount <= 2,
    `Fresh-object selector settles (${freshSelectorRenders - rendersAfterMount} renders per update)`,
  );
  await act(() => patch({ imageMode: 'resize' }));
  check(
    freshSelectorRenders - rendersAfterMount <= 2,
    'Unrelated store change does not re-render a shallow-equal selection',
  );
  await act(() => render(null, root));

  for (const advanced of [false, true]) {
    const selector = advanced ? '#copy-logs' : 'button';
    await act(() =>
      render(
        advanced ? <LogConsolePanel /> : <CopyChip label="IP" value="127.0.0.1" cls="chip" />,
        root,
      ),
    );
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    await click(selector);
    check(
      root.querySelector(selector)!.textContent.includes('Copy failed'),
      `Missing clipboard reports failure (${advanced})`,
    );
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error('denied')) },
    });
    await click(selector);
    check(
      root.querySelector(selector)!.textContent.includes('Copy failed'),
      `Denied clipboard reports failure (${advanced})`,
    );
    let written = '';
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (text: string) => {
          written = text;
          return Promise.resolve();
        },
      },
    });
    await click(selector);
    check(
      root.querySelector(selector)!.textContent.includes('Copied'),
      `Successful clipboard reports success (${advanced})`,
    );
    check(
      advanced ? written.includes('SERVER LOGS') : written === '127.0.0.1',
      `Clipboard receives intended content (${advanced})`,
    );
    await act(() => render(null, root));
  }

  // A failed copy must revert to the idle label. Both consumers *replace* their label
  // with "Copy failed" rather than adding to it, so a stuck error would permanently
  // erase the chip's "IP" caption / the button's "Copy All". Rendered together so one
  // shared wait covers both without spending the virtual-time budget twice.
  const originalSetTimeout = globalThis.setTimeout;
  const resets: Array<() => void> = [];
  // Offset the fake handles: `clearTimeout` is left real, and useCopyText's unmount
  // cleanup passes these back to it. Small ids would collide with genuine browser timer
  // ids (which also start at 1) and cancel an unrelated timer.
  const FAKE_TIMER_ID_BASE = 1_000_000;
  globalThis.setTimeout = ((handler: TimerHandler): number => {
    if (typeof handler === 'function') resets.push(handler as () => void);
    return FAKE_TIMER_ID_BASE + resets.length;
  }) as typeof setTimeout;
  try {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error('denied')) },
    });
    await act(() =>
      render(
        <>
          <CopyChip label="IP" value="127.0.0.1" cls="chip" />
          <LogConsolePanel />
        </>,
        root,
      ),
    );
    await click('button');
    await click('#copy-logs');
    check(
      elementText('button').includes('Copy failed') &&
        elementText('#copy-logs').includes('Copy failed'),
      'Both consumers show the copy failure',
    );
    await act(() => resets.forEach((reset) => reset()));
    check(elementText('button').includes('IP'), 'Chip restores its label after a copy failure');
    check(
      elementText('#copy-logs').includes('Copy All'),
      'Copy All restores its label after a failure',
    );
    await act(() => render(null, root));
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }

  let finish: () => void = noop;
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    },
  });
  await act(() => render(<CopyChip label="IP" value="127.0.0.1" cls="chip" />, root));
  await click('button');
  await act(() => render(null, root));
  await act(async () => {
    finish();
    await Promise.resolve();
  });
  check(root.textContent === '', 'Late clipboard completion respects unmount');

  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else delete (navigator as { clipboard?: unknown }).clipboard;
}

void run()
  .then(() => {
    document.body.dataset.result = 'pass';
    document.body.textContent = results.join('\n');
    return undefined;
  })
  .catch((error: unknown) => {
    document.body.dataset.result = 'fail';
    document.body.textContent = String(error);
  });
