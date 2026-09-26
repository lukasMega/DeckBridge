import { render } from 'preact';
import { act } from 'preact/test-utils';
import { useLayoutEffect } from 'preact/hooks';
import {
  addKeyEvent,
  getSnapshot,
  patch,
  useStore,
  TOUCH_STRIP_REPAINT_DEFAULT_MS,
} from '../src/web/client/store.js';
import { hydrate } from '../src/web/client/hydrate.js';
import { CopyChip } from '../src/web/client/simple/controls.js';
import { LogConsolePanel } from '../src/web/client/advanced-log-panel.js';
import { DeviceTuningPanel } from '../src/web/client/simple/device-tuning.js';
import { DiagnosticsPanel } from '../src/web/client/simple/diagnostics-panel.js';
import { MultiDeckPanel } from '../src/web/client/simple/multi-deck-panel.js';
import { KeymapLearn } from '../src/web/client/simple/keymap-learn.js';
import { DockList } from '../src/web/client/simple/dock-cards.js';
import { showDeviceAction } from '../src/web/client/device-test-mode.js';
import { ExtraKeysPanel } from '../src/web/client/simple/extra-keys-panel.js';
import { ChipRadioGroup } from '../src/web/client/components/ChipRadioGroup.js';
import { updateBadgeVersion } from '../src/web/client/ui-helpers.js';
import { KeyGridPreview } from '../src/web/client/components/KeyGridPreview.js';
import { applyTouchImage, resetTouchStrip } from '../src/web/client/touch-strip-preview.js';
import type { DeviceOverridesView, DockUi, UpdateInfo } from '../src/web/client/ui-types.js';

const root = document.createElement('div');
document.body.appendChild(root);
const results: string[] = [];
const noop = (): void => {};

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
  results.push(message);
}

function SelectedValue({ field }: Readonly<{ field: 'brightness' | 'touchStripRepaintMs' }>) {
  const value = useStore((s) => s[field]);
  return <output>{value}</output>;
}

function UpdateDuringMount() {
  useLayoutEffect(() => patch({ brightness: 42 }), []);
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
  patch({ brightness: 10, touchStripRepaintMs: 1234 });
  await act(() => render(<SelectedValue field="brightness" />, root));
  check(root.textContent === '10', 'Initial selector reads snapshot');
  await act(() => render(<SelectedValue field="touchStripRepaintMs" />, root));
  check(root.textContent === '1234', 'Changed selector updates without store mutation');
  await act(() => patch({ touchStripRepaintMs: 4321 }));
  check(root.textContent === '4321', 'Subscription uses latest selector');
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
  await act(() => patch({ brightness: 99 }));
  check(root.textContent === '', 'Unmounted subscriber stays removed');

  await act(() => render(<FreshObjectSelector />, root));
  const rendersAfterMount = freshSelectorRenders;
  check(root.textContent === '99', 'Fresh-object selector reads snapshot');
  await act(() => patch({ brightness: 7 }));
  check(root.textContent === '7', 'Fresh-object selector tracks updates');
  check(
    freshSelectorRenders - rendersAfterMount <= 2,
    `Fresh-object selector settles (${freshSelectorRenders - rendersAfterMount} renders per update)`,
  );
  await act(() => patch({ touchStripRepaintMs: 999 }));
  check(
    freshSelectorRenders - rendersAfterMount <= 2,
    'Unrelated store change does not re-render a shallow-equal selection',
  );
  // Restore the default so later cases (e.g. runSideKeysPanel) that read the
  // repaint interval without setting it first see the documented default.
  patch({ touchStripRepaintMs: TOUCH_STRIP_REPAINT_DEFAULT_MS });
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
  await runMultiDockCards();
  await runSideKeysPanel();
  await runChipRadioGroup();
  await runTouchStripPreview();
  runUpdateBadge();
  runHydrateRegression();
}

// B4: WS reconnect used to re-apply only images, leaving extraKeys/encoders/
// touchStripMode/brightnessOverride/updateInfo stale after an app restart.
// hydrate() is now the single entry point for both first load and reconnect.
function runHydrateRegression(): void {
  patch({
    extraKeys: {},
    touchStripMode: 'elgato',
    brightnessOverride: true,
    updateInfo: undefined,
  });
  hydrate({
    driverMode: 'real',
    driverConnected: true,
    elgatoConnected: true,
    docks: [],
    stats: { uptimeMs: 1, elgatoRxPkts: 0, elgatoTxPkts: 0, imagesSent: 0 },
    images: {},
    extraKeys: { '11': { widget: 'command', param: 'date' } },
    touchStripMode: 'deckbridge-repaint',
    brightnessOverride: false,
    updateInfo: { enabled: true, current: '0.14.1', updateAvailable: true, latest: '0.15.0' },
  });
  const snap = getSnapshot();
  check(
    JSON.stringify(snap.extraKeys) ===
      JSON.stringify({ '11': { widget: 'command', param: 'date' } }),
    'hydrate() re-applies extraKeys',
  );
  check(snap.touchStripMode === 'deckbridge-repaint', 'hydrate() re-applies touchStripMode');
  check(!snap.brightnessOverride, 'hydrate() re-applies brightnessOverride');
  check(snap.updateInfo?.latest === '0.15.0', 'hydrate() re-applies updateInfo');
  patch({
    extraKeys: {},
    touchStripMode: 'elgato',
    brightnessOverride: true,
    updateInfo: undefined,
  });
}

/** Base64 JPEG body of a solid w×h block. */
function solidJpeg(w: number, h: number, color: string): string {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, w, h);
  return c.toDataURL('image/jpeg', 1).split(',')[1]!;
}

/** Red channel at (x, y) once the async paint chain has drawn it. */
async function stripRed(x: number, y: number, want: (r: number) => boolean): Promise<number> {
  let r = -1;
  for (let i = 0; i < 50; i++) {
    const canvas = root.querySelector<HTMLCanvasElement>('canvas.touch-strip-preview');
    r = canvas?.getContext('2d')?.getImageData(x, y, 1, 1).data[0] ?? -1;
    if (want(r)) return r;
    await new Promise((res) => setTimeout(res, 10));
  }
  return r;
}

async function runTouchStripPreview(): Promise<void> {
  await act(() => render(<KeyGridPreview keyCount={8} columns={4} dimmed={false} />, root));
  check(!root.querySelector('canvas.touch-strip-preview'), 'No strip canvas without a strip');

  applyTouchImage({ data: solidJpeg(40, 10, '#ff0000') });
  await act(() =>
    render(
      <KeyGridPreview
        keyCount={8}
        columns={4}
        dimmed={false}
        touchStrip={{ width: 40, height: 10 }}
      />,
      root,
    ),
  );
  const canvas = root.querySelector<HTMLCanvasElement>('canvas.touch-strip-preview');
  check(canvas?.width === 40 && canvas.height === 10, 'Strip canvas uses the advertised size');
  check((await stripRed(5, 5, (r) => r > 200)) > 200, 'A frame seen before mount is painted');

  applyTouchImage({ data: solidJpeg(20, 10, '#0000ff'), region: { x: 20, y: 0, w: 20, h: 10 } });
  check((await stripRed(30, 5, (r) => r < 50)) < 50, 'A partial window lands at its region');
  check((await stripRed(5, 5, (r) => r > 200)) > 200, 'A partial window leaves the rest');

  resetTouchStrip();
  const alpha = canvas!.getContext('2d')!.getImageData(5, 5, 1, 1).data[3];
  check(alpha === 0, 'Dock switch clears the strip');
  await act(() => render(null, root));
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
  defaults: { ...OVERRIDES_VIEW.defaults, wire: { batchImageTransfers: true } },
  tunable: { ...OVERRIDES_VIEW.tunable, wire: { batchImageTransfers: true } },
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
const baseStatus = {
  driverMode: 'real' as const,
  driverConnected: true,
  elgatoConnected: true,
  docks: [] as DockUi[],
};

async function checkBatchImageTransferTuning(): Promise<void> {
  for (const [modelId, enabled] of [
    ['mirabox-293s', true],
    ['ajazz-akp153', false],
  ] as const) {
    const view: DeviceOverridesView = {
      ...SECOND_OVERRIDES_VIEW,
      modelId,
      tunable: { ...SECOND_OVERRIDES_VIEW.tunable, wire: { batchImageTransfers: enabled } },
      overrides: { wire: { chunkDelayMs: 2 } },
    };
    const stub = stubFetch((_url, init) => ({
      payload: init?.method === 'POST' ? { reconnecting: true } : view,
    }));
    try {
      await act(() => patch({ status: { ...baseStatus, modelId } }));
      await act(() => render(<DeviceTuningPanel />, root));
      await settle();
      const checkbox = root.querySelector<HTMLInputElement>('#tuning-batch-image-transfers');
      check(
        checkbox !== null && checkbox.checked === enabled,
        `${modelId} batching toggle seeds correctly`,
      );
      await act(() => checkbox!.click());
      await click('#tuning-apply');
      await settle();
      const posted = stub.calls.find((call) => call.method === 'POST')?.body as {
        modelId: string;
        overrides: { wire: Record<string, unknown> };
      };
      check(
        posted.modelId === modelId && posted.overrides.wire.batchImageTransfers === !enabled,
        `${modelId} batching toggle posts edited value`,
      );
      check(
        posted.overrides.wire.chunkDelayMs === 2,
        'Batch toggle preserves other wire overrides',
      );
    } finally {
      stub.restore();
      await act(() => render(null, root));
      await act(() => patch({ status: baseStatus }));
    }
  }
}

// Picking an emulation profile must not post the old grid's image draft: an explicit
// image override wins over the profile's transform (it undid the Plus 180° rotation).
async function checkEmulationProfileSwitch(): Promise<void> {
  const view: DeviceOverridesView = {
    ...OVERRIDES_VIEW,
    modelId: 'ajazz-akp05e',
    modelName: 'AJAZZ AKP05E',
    overrides: { image: { quality: 0.7 } },
    tunable: { image: { rotate: 0, width: 112, height: 112 }, cora: { productId: 0x80 } },
    profiles: [{ id: 'stream-deck-plus', name: 'Stream Deck +', productId: 0x84 }],
  };
  const stub = stubFetch((_url, init) => ({
    payload: init?.method === 'POST' ? { reconnecting: true } : view,
  }));
  try {
    await act(() => patch({ status: { ...baseStatus, modelId: 'ajazz-akp05e' } }));
    await act(() => render(<DeviceTuningPanel />, root));
    await settle();
    const select = root.querySelector<HTMLSelectElement>('#tuning-emulation-profile');
    check(select !== null && select.value === '', 'Emulation profile seeds as native');
    await act(() => {
      select!.value = 'stream-deck-plus';
      select!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await click('#tuning-apply');
    await settle();
    const posted = stub.calls.find((call) => call.method === 'POST')?.body as {
      overrides: Record<string, unknown>;
    };
    check(
      JSON.stringify(posted.overrides.cora) ===
        JSON.stringify({ advertiseAs: 'stream-deck-plus', productId: 0x84 }),
      'Profile switch posts the cora target',
    );
    check(
      !('image' in posted.overrides) && !('keyMap' in posted.overrides),
      'Profile switch drops the previous grid image/keyMap overrides',
    );
  } finally {
    stub.restore();
    await act(() => render(null, root));
    await act(() => patch({ status: baseStatus }));
  }
}

async function checkImageFitApplicability(): Promise<void> {
  const view: DeviceOverridesView = {
    ...OVERRIDES_VIEW,
    modelId: 'ajazz-akp05e',
    modelName: 'AJAZZ AKP05E',
    sourceSize: { width: 120, height: 120 },
  };
  const stub = stubFetch(() => ({ payload: view }));
  const chip = (name: string, value: string): HTMLInputElement | null =>
    root.querySelector<HTMLInputElement>(`input[name="${name}"][value="${value}"]`);
  try {
    await act(() => patch({ status: { ...baseStatus, modelId: 'ajazz-akp05e' } }));
    await act(() => render(<DeviceTuningPanel />, root));
    await settle();
    check(chip('image-fit', 'pad')?.disabled === true, '120→112: pad disabled (no effect)');
    check(chip('image-fit', 'crop')?.disabled === false, '120→112: crop enabled');
    check(chip('pad-fill', 'edge')?.disabled === true, 'resize mode: pad fill disabled');
    await click('#image-fit-help-btn');
    check(
      root.querySelector('#image-fit-source')?.textContent === '120×120 px' &&
        root.querySelector('#image-fit-target')?.textContent === '112×112 px',
      'Image fit help shows source and key sizes',
    );
    await act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    check(root.querySelector('#image-fit-help') === null, 'Escape closes image fit help');
  } finally {
    stub.restore();
    await act(() => render(null, root));
    await act(() => patch({ status: baseStatus }));
  }
}

async function runSettingsPanels(): Promise<void> {
  // Device tuning: renders the effective spec, not a blank form.
  {
    const stub = stubFetch(() => ({ payload: OVERRIDES_VIEW }));
    try {
      await act(() => render(<DeviceTuningPanel />, root));
      await settle();
      check(root.textContent.includes('Mirabox 293V3'), 'Device tuning names the model');
      check(
        root.querySelector('#tuning-batch-image-transfers') === null,
        'Batching control is absent on unsupported models',
      );
      const tuningBody = root.querySelector('#device-tuning-body')!;
      check(!tuningBody.classList.contains('open'), 'Device tuning is collapsed by default');
      await click('#device-tuning > .collapse-header');
      check(tuningBody.classList.contains('open'), 'Device tuning opens from its header');
      const rotation = root.querySelector<HTMLInputElement>('input[name="rotation"]:checked');
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

  await checkBatchImageTransferTuning();
  await checkEmulationProfileSwitch();
  await checkImageFitApplicability();

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
        brightness: 100,
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
        brightness: 100,
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
      check(
        root.textContent.includes('Applied to the device.'),
        'Apply shows selected model status',
      );

      await act(() => patch({ status: { ...baseStatus, selectedDock: 0, docks } }));
      await settle();
      check(
        !root.textContent.includes('Applied to the device.'),
        'Dock selection clears stale status',
      );
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
        brightness: 100,
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
        brightness: 100,
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
    // DiagnosticsPanel takes logLevel/logFilePath as props — SettingsPage owns the
    // single /api/state read and drills them down, so there is no fetch to stub here.
    const stub = stubFetch(() => ({ payload: { ok: true } }));
    try {
      await act(() =>
        render(
          <DiagnosticsPanel
            logLevel="info"
            logFilePath="/home/u/.cache/deckbridge/logs/deckbridge.log"
          />,
          root,
        ),
      );
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

  // Multi-deck: the opt-in toggle reflects state and posts the opposite value.
  {
    const stub = stubFetch(() => ({ payload: { ok: true } }));
    try {
      await act(() => render(<MultiDeckPanel enabled={false} />, root));
      await settle();
      const box = (): HTMLInputElement | null => root.querySelector('#toggle-multi-deck');
      check(box()?.checked === false, 'Multi-deck toggle starts off (the default)');

      await click('#toggle-multi-deck');
      await settle();
      const post = stub.calls.find((c) => c.url === '/api/multi-deck');
      check(
        (post?.body as { enabled?: boolean } | undefined)?.enabled === true,
        'Enabling posts enabled:true',
      );
      check(box()?.checked === true, 'The toggle updates after a successful post');
    } finally {
      stub.restore();
      await act(() => render(null, root));
    }
  }
}

// Multi-dock cards (simple/dock-cards.tsx). Mock mode only ever produces one
// dock, so this is the only CI coverage of the selected/unselected branch — the
// branch that shipped B1 (missing `compact` class) and nearly shipped B4 (empty
// grid after selection).
const DOCKS: DockUi[] = [
  {
    index: 0,
    modelId: 'mirabox-293s',
    modelName: 'Mirabox 293S',
    keyCount: 15,
    columns: 5,
    rows: 3,
    primaryPort: 5343,
    primaryConnected: true,
    elgatoConnected: true,
    brightness: 100,
  },
  {
    index: 1,
    modelId: 'fifine-d6',
    modelName: 'Fifine D6',
    keyCount: 6,
    columns: 3,
    rows: 2,
    primaryPort: 5345,
    primaryConnected: true,
    elgatoConnected: true,
    brightness: 100,
  },
];

function dockCard(index: number): HTMLElement {
  const card = root.querySelectorAll<HTMLElement>('.dock-card')[index];
  if (!card) throw new Error(`Missing dock card ${index}`);
  return card;
}

/** Live grids are built by KeyPreview (`<button class="key-cell">`); the static
 *  branch renders plain `<div class="key-cell">`. */
function cellCounts(card: HTMLElement): { live: number; inert: number } {
  return {
    live: card.querySelectorAll('button.key-cell').length,
    inert: card.querySelectorAll('div.key-cell').length,
  };
}

function baseUpdateInfo(): UpdateInfo {
  return { enabled: true, current: '0.14.1', updateAvailable: false };
}

function runUpdateBadge(): void {
  check(updateBadgeVersion(undefined) === null, 'Update badge: no state yet renders nothing');
  check(
    updateBadgeVersion({ ...baseUpdateInfo(), updateAvailable: false, latest: '0.15.0' }) === null,
    'Update badge: hidden when no update is available',
  );
  check(
    updateBadgeVersion({ ...baseUpdateInfo(), updateAvailable: true, latest: '0.15.0' }) ===
      '0.15.0',
    'Update badge: shown when an update is available',
  );
  check(
    updateBadgeVersion({
      ...baseUpdateInfo(),
      updateAvailable: true,
      latest: '0.15.0',
      dismissedVersion: '0.15.0',
    }) === null,
    'Update badge: hidden once the current latest version was dismissed',
  );
  check(
    updateBadgeVersion({
      ...baseUpdateInfo(),
      updateAvailable: true,
      latest: '0.16.0',
      dismissedVersion: '0.15.0',
    }) === '0.16.0',
    'Update badge: reappears for a newer version than the one dismissed',
  );
}

async function runMultiDockCards(): Promise<void> {
  const stub = stubFetch(() => ({ payload: { ok: true } }));
  try {
    await act(() => patch({ status: { ...baseStatus, docks: DOCKS, selectedDock: 0 } }));
    await act(() => render(<DockList docks={DOCKS} onHelp={noop} />, root));
    await settle();
    check(root.querySelectorAll('.dock-card').length === 2, 'Both dock cards render');
    check(
      cellCounts(dockCard(0)).live === 15 && cellCounts(dockCard(0)).inert === 0,
      'The selected dock card renders a live grid',
    );
    check(
      cellCounts(dockCard(1)).inert === 6 && cellCounts(dockCard(1)).live === 0,
      'An unselected dock card renders the static grid',
    );
    // B1: the 6-key compact class must be computed for the static branch too.
    check(
      dockCard(1).querySelector('.preview')?.classList.contains('compact') === true,
      'An unselected 6-key dock card is sized compact',
    );

    await act(() => dockCard(1).click());
    await settle();
    const post = stub.calls.find((c) => c.url === '/api/select-dock');
    check(
      (post?.body as { index?: number } | undefined)?.index === 1,
      'Clicking an unselected dock card posts its index',
    );

    // B4: both branches are the same component type and KeyPreview is built in a
    // mount-only effect, so the grid is populated only if selection remounts it.
    await act(() => patch({ status: { ...baseStatus, docks: DOCKS, selectedDock: 1 } }));
    await settle();
    check(
      cellCounts(dockCard(1)).live === 6,
      'Selecting a previously-unselected dock card rebuilds its live grid',
    );
    check(
      cellCounts(dockCard(0)).inert === 15 && cellCounts(dockCard(0)).live === 0,
      'Deselecting a dock card falls back to the static grid',
    );
  } finally {
    stub.restore();
    await act(() => render(null, root));
  }
}

// Side keys + touch strip (simple/extra-keys-panel.tsx): every row sits on the
// shared grid, and the strip's rows/knobs follow the selected mode.
const AKP05E_DOCK: DockUi = {
  index: 0,
  modelId: 'ajazz-akp05e',
  modelName: 'AJAZZ AKP05E',
  keyCount: 8,
  columns: 5,
  rows: 2,
  primaryPort: 5343,
  primaryConnected: true,
  elgatoConnected: true,
  brightness: 100,
  extraKeys: [15, 10],
  pressableExtraKeys: [15, 10],
  widgetDisplays: [20, 21, 22, 23].map((wireId, i) => ({ wireId, label: `Zone ${i + 1}` })),
  encoderCount: 4,
};

async function checkSideKeysHelp(): Promise<void> {
  await click('button[aria-label="Side keys help"]');
  await settle();
  const help = root.querySelector<HTMLDialogElement>('dialog.side-keys-help');
  check(help?.open === true, 'Side keys help opens modal dialog');
  check(
    help?.querySelectorAll('.side-keys-device-grid .side-keys-device-key').length === 8 &&
      help.querySelectorAll('.side-keys-device-column .side-keys-device-key').length === 2,
    'Help diagram uses selected dock grid and side keys',
  );
  check(
    [...help!.querySelectorAll('.side-keys-device-grid .side-keys-device-key')]
      .map((key) => key.textContent)
      .join(',') === '1,2,3,4,6,7,8,9',
    'Plus mode highlights only physical keys controlled by Elgato',
  );
  check(
    [...help!.querySelectorAll('.side-keys-device-column .side-keys-device-key')]
      .map((key) => key.textContent)
      .join(',') === 'Top,Bottom' &&
      help!.querySelector('.side-keys-sankey')?.textContent.includes('4 × 2 keys') === true,
    'Plus mode labels physical side keys and correct Sankey grid size',
  );
  await click('button[aria-label="Close side keys help"]');
  check(root.querySelector('dialog.side-keys-help') === null, 'Side keys help closes');
}

async function checkDeviceTestMode(): Promise<void> {
  const toast = document.createElement('div');
  toast.id = 'toast';
  document.body.appendChild(toast);
  const input = root.querySelector<HTMLInputElement>('.device-test-option input')!;
  check(!input.checked, 'Device test mode defaults off');
  showDeviceAction({ dockIndex: 0, message: 'Key 1 pressed' });
  check(toast.textContent === '', 'Disabled test mode stays quiet');
  await act(() => input.click());
  check(getSnapshot().deviceTestMode, 'Test checkbox enables local observer');
  showDeviceAction({ dockIndex: 1, message: 'Other dock action' });
  check(toast.textContent === '', 'Test mode ignores other docks');
  showDeviceAction({ dockIndex: 0, message: 'Knob 1 touch tap (100, 50)' });
  check(
    toast.textContent === 'Knob 1 touch tap (100, 50)' && toast.classList.contains('show'),
    'Selected device action shows notification',
  );
  showDeviceAction({ dockIndex: 0, message: 'Knob 1 turned right (1)' });
  check(toast.textContent === 'Knob 1 turned right (1)', 'Repeated actions update notification');
  await act(() => input.click());
  showDeviceAction({ dockIndex: 0, message: 'Key 2 pressed' });
  check(
    toast.textContent === 'Knob 1 turned right (1)',
    'Disabling observer stops new notifications',
  );
  toast.remove();
}

const PREVIEW_SIZES = ['fit', -2, -1, 0, 1, 2] as const;

type Stub = ReturnType<typeof stubFetch>;
const lastPost = (stub: Stub, url: string): Record<string, unknown> | undefined =>
  stub.calls.findLast((c) => c.url === url)?.body as Record<string, unknown> | undefined;

async function checkTextSize(stub: Stub): Promise<void> {
  const cards = [...root.querySelectorAll('.xkey-card')];
  const size = (label: string): HTMLButtonElement =>
    cards[1]!.querySelector<HTMLButtonElement>(`.xkey-size button[aria-label="${label}"]`)!;
  check(
    cards[0]!.querySelector('.xkey-size') === null &&
      cards[1]!.querySelector('.xkey-size') !== null,
    'Text size control shows only on keys with a widget',
  );
  await act(() =>
    patch({ extraKeys: { '10': { widget: 'command', param: 'date', textSize: 2 } } }),
  );
  check(size('Larger text').disabled && !size('Smaller text').disabled, 'A+ disabled at +2');
  await act(() => size('Smaller text').click());
  check(
    JSON.stringify(lastPost(stub, '/api/extra-key')) ===
      JSON.stringify({ wireId: 10, widget: 'command', param: 'date', textSize: 1 }),
    'A− posts one step smaller with the rest of the widget config',
  );
  await act(() => size('Fit text').click());
  check(lastPost(stub, '/api/extra-key')?.textSize === 'fit', 'Fit posts fit');
  await act(() => size('Default text size').click());
  check(
    lastPost(stub, '/api/extra-key') !== undefined &&
      !('textSize' in lastPost(stub, '/api/extra-key')!),
    'A posts the default size (omitted)',
  );

  await act(() =>
    patch({ extraKeys: { '10': { widget: 'command', param: 'date', textSize: -1 } } }),
  );
  await click('button[aria-label="Bottom side key command settings"]');
  const interval = root.querySelector<HTMLInputElement>('.xkey-popover input')!;
  interval.value = '30';
  await act(() => {
    interval.dispatchEvent(new Event('change'));
  });
  check(
    lastPost(stub, '/api/extra-key')?.intervalMs === 30_000 &&
      lastPost(stub, '/api/extra-key')?.textSize === -1,
    'Changing another widget setting keeps the text size',
  );
  await click('button[aria-label="Bottom side key command settings"]');
  await checkTextSizePicker(stub, cards[1]!);
  await checkWrapSelect(stub, cards[1]!);
}

async function checkWrapSelect(stub: Stub, card: Element): Promise<void> {
  await act(() =>
    patch({ extraKeys: { '10': { widget: 'command', param: 'date', textSize: 1 } } }),
  );
  const select = card.querySelector<HTMLSelectElement>(
    'select[aria-label="Bottom line wrapping"]',
  )!;
  check(select.value === 'off', 'Wrap select defaults to off on a free-text widget');
  select.value = 'chars';
  await act(() => {
    select.dispatchEvent(new Event('change'));
  });
  check(
    JSON.stringify(lastPost(stub, '/api/extra-key')) ===
      JSON.stringify({ wireId: 10, widget: 'command', param: 'date', textSize: 1, wrap: 'chars' }),
    'Wrap select posts the mode with the text size',
  );
  await act(() =>
    patch({ extraKeys: { '10': { widget: 'command', param: 'date', wrap: 'words' } } }),
  );
  await act(() =>
    card.querySelector<HTMLButtonElement>('button[aria-label="Larger text"]')!.click(),
  );
  check(lastPost(stub, '/api/extra-key')?.wrap === 'words', 'Size buttons keep the wrap mode');
  await act(() => patch({ extraKeys: { '10': { widget: 'clock', wrap: 'words' } } }));
  check(
    card.querySelector('select[aria-label="Bottom line wrapping"]') === null,
    'No wrap select on clock/date/weather',
  );
  await act(() => patch({ extraKeys: { '10': { widget: 'command', param: 'date' } } }));
}

async function checkTextSizePicker(stub: Stub, card: Element): Promise<void> {
  const size = (label: string): HTMLButtonElement =>
    card.querySelector<HTMLButtonElement>(`.xkey-size button[aria-label="${label}"]`)!;
  check(card.querySelector('.xkey-clipped') === null, 'No clipped badge by default');
  await act(() => patch({ extraKeyClipped: { '10': true } }));
  check(card.querySelector('.xkey-tile .xkey-clipped') !== null, 'Clipped badge on the tile');
  await act(() => patch({ extraKeyClipped: {} }));

  await act(() => size('Bottom text size previews').click());
  await settle();
  const thumbs = [...card.querySelectorAll<HTMLButtonElement>('.xkey-size-thumb')];
  check(
    lastPost(stub, '/api/extra-key/preview')?.wireId === 10 &&
      thumbs.length === 6 &&
      thumbs[1]!.getAttribute('aria-pressed') === 'false' &&
      thumbs[2]!.getAttribute('aria-pressed') === 'true' &&
      thumbs[5]!.textContent.includes('clipped'),
    'Size picker shows a thumbnail per size, marks the current one and clipped ones',
  );
  await act(() => thumbs[4]!.click());
  check(
    lastPost(stub, '/api/extra-key')?.textSize === 1 &&
      card.querySelector('.xkey-size-picker') === null,
    'Picking a thumbnail posts that size and closes the picker',
  );
  await act(() => patch({ extraKeys: { '10': { widget: 'command', param: 'date' } } }));
}

async function runSideKeysPanel(): Promise<void> {
  const stub = stubFetch((url) =>
    url === '/api/extra-key/preview'
      ? {
          payload: {
            wireId: 10,
            previews: PREVIEW_SIZES.map((textSize) => ({
              textSize,
              data: 'Qk0=',
              clipped: textSize === 2,
            })),
          },
        }
      : { payload: { dir: '', files: [], status: {} } },
  );
  const section = (title: string): Element =>
    root.querySelector(`[role="group"][aria-label="${title}"]`)!;
  const rows = (title: string, extra = ''): Element[] => [
    ...section(title).querySelectorAll(`.xkey-row:not(.xkey-grid-head)${extra}`),
  ];
  try {
    await act(() =>
      patch({
        status: { ...baseStatus, docks: [AKP05E_DOCK], selectedDock: 0 },
        extraKeys: { '10': { widget: 'command', param: 'date' } },
        touchStripMode: 'elgato',
        encoders: { connectToApp: true },
      }),
    );
    await act(() => render(<ExtraKeysPanel />, root));
    await settle();

    await checkSideKeysHelp();
    await checkDeviceTestMode();
    await checkTextSize(stub);

    const cards = [...section('Side keys').querySelectorAll('.xkey-card')];
    check(
      cards.length === 2 &&
        cards.every(
          (card) =>
            card.querySelector('.xkey-tile') !== null &&
            card.querySelector('.xkey-press-label:last-of-type')?.textContent === 'On press',
        ),
      'Every side-key card has a preview tile and an on-press line',
    );
    check(
      cards[0]!.querySelector('.xkey-value') === null &&
        cards[1]!.querySelector('.xkey-value:not(.xkey-wide)') !== null &&
        cards[1]!.querySelector('.xkey-config-btn') !== null,
      'Value line shows only for widgets with a value, beside its settings button',
    );
    check(
      section('Side keys').querySelector('.xkey-grid-head') === null &&
        cards.map((card) => card.querySelector('.xkey-tile-empty')?.textContent).join(',') ===
          'Top,Bottom',
      'Empty preview tiles show the key position',
    );
    await act(() => patch({ extraKeyImages: { '10': 'Qk0=' } }));
    check(
      cards[1]!.querySelector<HTMLImageElement>('.xkey-tile img')?.src ===
        'data:image/bmp;base64,Qk0=' && cards[0]!.querySelector('.xkey-tile img') === null,
      'Side-key tile shows the live widget image',
    );
    await act(() => patch({ extraKeyImages: {} }));
    check(
      rows('Touch strip').length === 0 &&
        section('Touch strip').textContent.includes('DeckBridge widgets are off') &&
        section('Touch strip').querySelector('.xkeys-option') === null,
      'Elgato strip mode hides zone rows, the repaint interval, and says why',
    );

    const modeSelect = root.querySelector<HTMLSelectElement>(
      'select[aria-label="Touch strip mode"]',
    )!;
    modeSelect.value = 'deckbridge-repaint';
    await act(() => {
      modeSelect.dispatchEvent(new Event('change'));
    });
    await settle();
    const modePost = stub.calls.find((c) => c.url === '/api/touch-strip-mode');
    check(
      (modePost?.body as { mode?: string } | undefined)?.mode === 'deckbridge-repaint',
      'Touch strip mode select posts the picked mode',
    );

    await act(() => patch({ touchStripMode: 'deckbridge-repaint' }));
    const repaintInput =
      section('Touch strip').querySelector<HTMLInputElement>('.xkeys-option input');
    check(repaintInput?.value === '5', 'Repaint mode shows the repaint interval, default 5 s');
    repaintInput!.value = '2';
    await act(() => {
      repaintInput!.dispatchEvent(new Event('change'));
    });
    await settle();
    const repaintPost = stub.calls.find((c) => c.url === '/api/touch-strip-repaint');
    check(
      (repaintPost?.body as { ms?: number } | undefined)?.ms === 2000,
      'Repaint interval posts milliseconds',
    );
    check(
      rows('Touch strip', ':not(.xkey-knob-row)').length === 4 &&
        rows('Touch strip', '.xkey-knob-row').length === 0,
      'Override mode shows zone rows; connected knobs show no command grid',
    );
    await act(() => patch({ encoders: { connectToApp: false } }));
    check(
      rows('Touch strip', '.xkey-knob-row').length === 4 &&
        rows('Touch strip', '.xkey-knob-row').every(
          (row) => row.querySelectorAll('input').length === 3,
        ),
      'Disconnected knobs show one press/right/left row per knob',
    );
  } finally {
    stub.restore();
    await act(() => render(null, root));
    await act(() => patch({ status: baseStatus, extraKeys: {}, touchStripMode: 'elgato' }));
  }
}

async function runChipRadioGroup(): Promise<void> {
  let picked: number | undefined;
  await act(() =>
    render(
      <ChipRadioGroup
        name="chip-test"
        label="Chip test"
        value={0}
        options={[0, 90].map((value) => ({ value, label: String(value) }))}
        onChange={(value) => (picked = value)}
      />,
      root,
    ),
  );
  check(
    root.querySelector<HTMLInputElement>('input[name="chip-test"]:checked')?.value === '0',
    'ChipRadioGroup checks the current value',
  );
  await act(() => root.querySelector<HTMLInputElement>('input[value="90"]')!.click());
  check(picked === 90, 'ChipRadioGroup reports the typed option value');
  await act(() => render(null, root));
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
