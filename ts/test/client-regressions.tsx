import { render } from 'preact';
import { act } from 'preact/test-utils';
import { useLayoutEffect } from 'preact/hooks';
import { addKeyEvent, patch, setBrightness, useStore } from '../src/web/client/store.js';
import { CopyChip } from '../src/web/client/simple/controls.js';
import { LogConsolePanel } from '../src/web/client/advanced-log-panel.js';
import { DeviceTuningPanel } from '../src/web/client/simple/device-tuning.js';
import { DiagnosticsPanel } from '../src/web/client/simple/diagnostics-panel.js';
import { KeymapLearn } from '../src/web/client/simple/keymap-learn.js';
import type { DeviceOverridesView } from '../src/web/client/ui-types.js';

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
  // Cases replace navigator.clipboard; the last installs a pending writeText.
  // Restore the real descriptor before later tests.
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

  // Failed copies must restore both idle labels instead of leaving "Copy failed".
  // Render both consumers together so one shared wait covers both.
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

  await runSettingsPanels();
  await runKeymapAndDiagnosticsPanels();
}

// Device tuning + diagnostics panels (simple/device-tuning.tsx,
// simple/diagnostics-panel.tsx). Both are fetch-driven, so each case installs a
// stub `fetch` and asserts on what the panel rendered / what it posted.

// Mirrors a real GET /api/device-overrides payload: `effective` carries the full
// spec (protocol facts included), `tunable` is the projection the form seeds from.
const OVERRIDES_VIEW: DeviceOverridesView = {
  modelId: 'mirabox-293',
  modelName: 'Mirabox 293V3',
  defaults: { image: { rotate: 0, width: 112, height: 112, quality: 0.8 } },
  overrides: {},
  safeMode: false,
  effective: {
    image: {
      format: 'jpeg',
      colorMode: 'rgb',
      rotate: 180,
      width: 112,
      height: 112,
      quality: 0.8,
      resizeMode: 'resize',
    },
    keyMap: { inputOffset: 1 },
  },
  tunable: {
    image: { rotate: 180, width: 112, height: 112, quality: 0.8, resizeMode: 'resize' },
    keyMap: { inputOffset: 1 },
  },
};

const SECOND_OVERRIDES_VIEW: DeviceOverridesView = {
  ...OVERRIDES_VIEW,
  modelId: 'mirabox-293s',
  modelName: 'Mirabox 293S',
};

interface StubCall {
  url: string;
  method: string;
  body: unknown;
}

/** Install a stub fetch; returns the recorded calls and a restore function. */
function stubFetch(handler: (url: string, init?: RequestInit) => unknown): {
  calls: StubCall[];
  restore: () => void;
} {
  const calls: StubCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const result = (await handler(url, init)) as { status?: number; payload?: unknown };
    const status = result.status ?? 200;
    return {
      ok: status < 400,
      status,
      json: () => Promise.resolve(result.payload ?? {}),
      text: () => Promise.resolve(JSON.stringify(result.payload ?? {})),
    };
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

/** Let the panel's mount-time fetch chain settle before asserting. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

/** Minimum status the learn-mode grid prompts need. */
const baseStatus = { driverMode: 'real' as const, driverConnected: true, elgatoConnected: true };

async function runSettingsPanels(): Promise<void> {
  // Device tuning: renders the effective spec, not a blank form.
  {
    const stub = stubFetch(() => ({ payload: OVERRIDES_VIEW }));
    try {
      await act(() => render(<DeviceTuningPanel />, root));
      await settle();
      check(root.textContent.includes('Mirabox 293V3'), 'Device tuning names the model');
      const tuningBody = root.querySelector('#device-tuning-body')!;
      check(!tuningBody.classList.contains('open'), 'Device tuning is collapsed by default');
      await click('#device-tuning > .collapse-header');
      check(tuningBody.classList.contains('open'), 'Device tuning opens from its header');
      const rotation = root.querySelector<HTMLSelectElement>('select');
      check(rotation?.value === '180', 'Rotation seeds from the effective spec, not the default');
      check(
        root.querySelector('#tuning-apply') !== null &&
          root.querySelector('#tuning-reset') !== null,
        'Apply and Reset are both reachable',
      );
    } finally {
      stub.restore();
      await act(() => render(null, root));
    }
  }

  // A validation failure surfaces the server's error list.
  {
    const stub = stubFetch((url, init) =>
      init?.method === 'POST'
        ? { status: 400, payload: { error: 'image.rotate: must be one of 0, 90, 180, 270' } }
        : { payload: OVERRIDES_VIEW },
    );
    try {
      await act(() => render(<DeviceTuningPanel />, root));
      await settle();
      await click('#tuning-apply');
      await settle();
      check(
        root.textContent.includes('image.rotate'),
        'Validation errors from the server are shown verbatim',
      );
      const posted = stub.calls.find((c) => c.method === 'POST');
      const body = posted?.body as { overrides?: { image?: Record<string, unknown> } } | undefined;
      const postedImage = body?.overrides?.image;
      // Regression: the form used to seed from `effective`, so Apply posted the
      // protocol facts back and every save failed with "image.format: unknown field".
      check(
        postedImage !== undefined && !('format' in postedImage) && !('colorMode' in postedImage),
        'Apply posts only tunable fields, never the protocol facts',
      );
    } finally {
      stub.restore();
      await act(() => render(null, root));
    }
  }

  // Reset posts the model id — reachable even when the device looks dead.
  {
    const stub = stubFetch((url) =>
      url.includes('/reset') ? { payload: { ok: true } } : { payload: OVERRIDES_VIEW },
    );
    try {
      await act(() => render(<DeviceTuningPanel />, root));
      await settle();
      await click('#tuning-reset');
      await settle();
      const reset = stub.calls.find((c) => c.url.includes('/api/device-overrides/reset'));
      check(reset !== undefined, 'Reset posts to /api/device-overrides/reset');
      check(
        (reset?.body as { modelId?: string } | undefined)?.modelId === 'mirabox-293',
        'Reset names the model being reset',
      );
    } finally {
      stub.restore();
      await act(() => render(null, root));
    }
  }

  // Changing selected dock reloads tuning for that model. Before this regression
  // fix, the settings panel kept its mount-time primary model forever.
  {
    const docks = [
      {
        index: 0,
        modelId: OVERRIDES_VIEW.modelId,
        modelName: OVERRIDES_VIEW.modelName,
        keyCount: 15,
        columns: 5,
        rows: 3,
        primaryPort: 5325,
        primaryConnected: true,
        elgatoConnected: true,
      },
      {
        index: 1,
        modelId: SECOND_OVERRIDES_VIEW.modelId,
        modelName: SECOND_OVERRIDES_VIEW.modelName,
        keyCount: 18,
        columns: 6,
        rows: 3,
        primaryPort: 5345,
        primaryConnected: true,
        elgatoConnected: true,
      },
    ];
    const stub = stubFetch((url) => ({
      payload: url.includes(encodeURIComponent(SECOND_OVERRIDES_VIEW.modelId))
        ? SECOND_OVERRIDES_VIEW
        : OVERRIDES_VIEW,
    }));
    try {
      await act(() => patch({ status: { ...baseStatus, selectedDock: 0, docks } }));
      await act(() => render(<DeviceTuningPanel />, root));
      await settle();
      check(root.textContent.includes('Mirabox 293V3'), 'Primary tuning loads initially');

      await act(() => patch({ status: { ...baseStatus, selectedDock: 1, docks } }));
      await settle();
      check(root.textContent.includes('Mirabox 293S'), 'Tuning reloads after dock selection');
      check(
        stub.calls.some((call) => call.url.includes('modelId=mirabox-293s')),
        'Selected model id is explicit in tuning request',
      );

      await click('#tuning-apply');
      await settle();
      const posted = stub.calls.find((call) => call.method === 'POST');
      check(
        (posted?.body as { modelId?: string } | undefined)?.modelId === 'mirabox-293s',
        'Apply targets selected dock model',
      );
      check(root.textContent.includes('Saved.'), 'Apply shows selected model status');

      await act(() => patch({ status: { ...baseStatus, selectedDock: 0, docks } }));
      await settle();
      check(!root.textContent.includes('Saved.'), 'Dock selection clears stale status');
    } finally {
      stub.restore();
      await act(() => render(null, root));
    }
  }

  // A refetch started by Apply may resolve after the user selects another dock.
  // Its response must not replace the selected dock's newer view.
  {
    let primaryGets = 0;
    let resolveStale!: (value: { payload: DeviceOverridesView }) => void;
    const stale = new Promise<{ payload: DeviceOverridesView }>((resolve) => {
      resolveStale = resolve;
    });
    const docks = [
      {
        index: 0,
        modelId: OVERRIDES_VIEW.modelId,
        modelName: OVERRIDES_VIEW.modelName,
        keyCount: 15,
        columns: 5,
        rows: 3,
        primaryPort: 5325,
        primaryConnected: true,
        elgatoConnected: true,
      },
      {
        index: 1,
        modelId: SECOND_OVERRIDES_VIEW.modelId,
        modelName: SECOND_OVERRIDES_VIEW.modelName,
        keyCount: 18,
        columns: 6,
        rows: 3,
        primaryPort: 5345,
        primaryConnected: true,
        elgatoConnected: true,
      },
    ];
    const stub = stubFetch((url, init) => {
      if (init?.method === 'POST') return { payload: { ok: true } };
      if (url.includes('modelId=mirabox-293s')) return { payload: SECOND_OVERRIDES_VIEW };
      primaryGets++;
      return primaryGets === 1 ? { payload: OVERRIDES_VIEW } : stale;
    });
    try {
      await act(() => patch({ status: { ...baseStatus, selectedDock: 0, docks } }));
      await act(() => render(<DeviceTuningPanel />, root));
      await settle();
      await click('#tuning-apply');

      await act(() => patch({ status: { ...baseStatus, selectedDock: 1, docks } }));
      await settle();
      check(root.textContent.includes('Mirabox 293S'), 'New selection wins during stale reload');

      resolveStale({ payload: OVERRIDES_VIEW });
      await settle();
      check(root.textContent.includes('Mirabox 293S'), 'Stale tuning response is ignored');
    } finally {
      stub.restore();
      await act(() => render(null, root));
    }
  }
}

async function runKeymapAndDiagnosticsPanels(): Promise<void> {
  // Key-map learn mode: the derived array IS the deliverable (it gets pasted into
  // a registry PR), so drive it with real key events and assert the exact shape.
  {
    // A 2x2 grid whose wire codes are mk2 index + 1 and row-flipped — the
    // AKP153E rev. 2 shape that motivated learn mode in the first place.
    const PRESSES = [
      { wireId: 3, position: 0 },
      { wireId: 4, position: 1 },
      { wireId: 1, position: 2 },
      { wireId: 2, position: 3 },
    ];
    const stub = stubFetch(() => ({ payload: { ok: true } }));
    try {
      patch({ status: { ...baseStatus, keyCount: 4, columns: 2 }, keyEvents: [] });
      await act(() => render(<KeymapLearn view={OVERRIDES_VIEW} onSaved={noop} />, root));
      await click('#keymap-learn-start');
      check(
        elementText('#keymap-learn-prompt').includes('row 1, column 1'),
        'Learn mode prompts for the first grid position',
      );

      let ts = 1000;
      for (const press of PRESSES) {
        // down+up, as real hardware sends: only 'down' may advance a position.
        await act(() =>
          addKeyEvent({ ts: ts++, mk2Index: 0, state: 'down', wireId: press.wireId }),
        );
        await act(() => addKeyEvent({ ts: ts++, mk2Index: 0, state: 'up', wireId: press.wireId }));
      }

      const derived = JSON.parse(elementText('#keymap-learn-result')) as {
        wireInputToCora: number[];
      };
      // Indexed BY WIRE ID: index 0 was never reported, so it is -1 (ignored).
      check(
        JSON.stringify(derived.wireInputToCora) === JSON.stringify([-1, 2, 3, 0, 1]),
        `Derived map is indexed by wire id with -1 gaps (got ${JSON.stringify(derived.wireInputToCora)})`,
      );
      check(
        root.querySelector('#keymap-learn-save') !== null,
        'Save appears once every position is recorded',
      );
      check(
        root.querySelector('#keymap-learn-prompt') === null,
        'The prompt stops once the walk is complete',
      );

      await click('#keymap-learn-save');
      await settle();
      const posted = stub.calls.find((c) => c.method === 'POST');
      const postedBody = posted?.body as
        | { overrides?: { keyMap?: Record<string, unknown> } }
        | undefined;
      const keyMap = postedBody?.overrides?.keyMap;
      check(
        JSON.stringify(keyMap?.wireInputToCora) === JSON.stringify([-1, 2, 3, 0, 1]),
        'Save posts the derived map',
      );
      // The two are alternative encodings of the same direction; leaving a stale
      // offset beside an explicit map is a trap for the next reader.
      check(
        !('inputOffset' in (keyMap ?? {})),
        'Save drops inputOffset alongside the explicit map',
      );
    } finally {
      stub.restore();
      await act(() => render(null, root));
    }
  }

  // A key event with no wireId (identity-mapped model / mock) aborts rather than
  // silently recording a map derived from mk2 indices.
  {
    const stub = stubFetch(() => ({ payload: { ok: true } }));
    try {
      patch({ status: { ...baseStatus, keyCount: 4, columns: 2 }, keyEvents: [] });
      await act(() => render(<KeymapLearn view={OVERRIDES_VIEW} onSaved={noop} />, root));
      await click('#keymap-learn-start');
      await act(() => addKeyEvent({ ts: 9000, mk2Index: 2, state: 'down' }));
      check(
        root.textContent.includes('no raw wire id'),
        'A device without wire ids reports why learn mode cannot run',
      );
      check(root.querySelector('#keymap-learn-prompt') === null, 'Learn mode stopped');
    } finally {
      stub.restore();
      await act(() => render(null, root));
    }
  }

  // Diagnostics: the debug toggle reflects state and posts the opposite level.
  {
    const stub = stubFetch((url) =>
      url === '/api/state'
        ? {
            payload: {
              logLevel: 'info',
              logFilePath: '/home/u/.cache/deckbridge/logs/deckbridge.log',
            },
          }
        : { payload: { ok: true } },
    );
    try {
      await act(() => render(<DiagnosticsPanel />, root));
      await settle();
      check(
        elementText('#toggle-debug-logging').includes('off'),
        'Debug toggle reflects the current level',
      );
      check(
        root.textContent.includes('/home/u/.cache/deckbridge/logs/deckbridge.log'),
        'The log file path is shown so a reporter can find it',
      );
      await click('#toggle-debug-logging');
      await settle();
      const post = stub.calls.find((c) => c.url === '/api/log-level');
      check(
        (post?.body as { level?: string } | undefined)?.level === 'debug',
        'Toggling posts the debug level',
      );
      check(
        elementText('#toggle-debug-logging').includes('on'),
        'The toggle updates after a successful post',
      );
    } finally {
      stub.restore();
      await act(() => render(null, root));
    }
  }
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
