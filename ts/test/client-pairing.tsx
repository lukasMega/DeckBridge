// Browser regressions for boot/stale-connection feedback and the compact pairing flow.
// Called from run() in client-regressions.tsx (real Chrome via CDP, see scripts/test-client.mjs).
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { DOCK_IDENTITY } from './helpers/dock-fixture.js';
import { EMPTY_PAGE_STATE, EMPTY_STATUS, getSnapshot, patch } from '../src/web/client/lib/store.js';
import { connectWS } from '../src/web/client/lib/ui-ws.js';
import { BootScreen } from '../src/web/client/simple/boot-screen.js';
import { ConnectionPath } from '../src/web/client/components/ConnectionPath.js';
import { SimpleApp } from '../src/web/client/simple/SimpleApp.js';
import { DockList } from '../src/web/client/simple/dock-cards.js';
import { StageConflict, StageDeviceNoElgato, StageReady } from '../src/web/client/simple/stages.js';
import type { DockUi } from '../src/web/client/ui-types.js';

type Check = (condition: boolean, message: string) => void;

const settle = (): Promise<void> =>
  act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });

async function refreshAppStatus(): Promise<void> {
  await act(() => {
    window.dispatchEvent(new Event('focus'));
  });
  await settle();
}

const sockets: FakeWs[] = [];

class FakeWs {
  closed = 0;
  private readonly handlers = new Map<string, Array<(e: unknown) => void>>();
  constructor() {
    sockets.push(this);
  }
  addEventListener(type: string, fn: (e: unknown) => void): void {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]);
  }
  close(): void {
    this.closed++;
  }
  emit(type: string): void {
    for (const fn of this.handlers.get(type) ?? []) fn({});
  }
}

const STATE = {
  ...EMPTY_STATUS,
  driverConnected: true,
  stats: { uptimeMs: 0, elgatoRxPkts: 0, elgatoTxPkts: 0, imagesSent: 0 },
  brightness: 50,
  brightnessOverride: true,
  deviceModels: [],
  extraKeys: {},
  pages: [],
  pageState: EMPTY_PAGE_STATE,
  touchStripMode: 'elgato',
  touchStripRepaintMs: 0,
  encoders: {},
  keyPressEnabled: false,
  keyEvents: [],
  logs: [],
  commLogs: [],
};

async function runBootAndStale(root: HTMLElement, check: Check): Promise<void> {
  let retries = 0;
  const retry = (): void => {
    retries++;
  };
  await act(() => render(<BootScreen failed={false} onRetry={retry} />, root));
  check(root.textContent.includes('Connecting to DeckBridge'), 'Boot: loading state is visible');
  check(root.querySelector('button') === null, 'Boot: no retry button while loading');
  await act(() => render(<BootScreen failed onRetry={retry} />, root));
  check(root.textContent.includes('Cannot reach DeckBridge'), 'Boot: failure state is visible');
  await act(() => root.querySelector<HTMLButtonElement>('button')!.click());
  check(retries === 1, 'Boot: Retry connection re-runs the boot request');

  const storeBefore = getSnapshot(); // hydrate() overwrites most of the store
  const original = {
    fetch: globalThis.fetch,
    ws: globalThis.WebSocket,
    timeout: globalThis.setTimeout,
  };
  let stateStatus = 200;
  globalThis.fetch = (() =>
    Promise.resolve({
      ok: stateStatus < 400,
      status: stateStatus,
      json: () => Promise.resolve(STATE),
    })) as unknown as typeof fetch;
  globalThis.WebSocket = FakeWs as unknown as typeof WebSocket;
  // The close handler schedules a reconnect; keep it from opening real sockets.
  globalThis.setTimeout = () => 0;
  try {
    await act(() =>
      patch({ status: { ...EMPTY_STATUS, driverConnected: true, elgatoConnected: true } }),
    );
    await act(() => render(<SimpleApp />, root));
    check(root.querySelector('#connBanner') === null, 'Stale: no banner while connected');
    check(!root.querySelector('#stage')!.hasAttribute('inert'), 'Stale: stage is interactive');

    connectWS();
    const ws = sockets.at(-1)!;
    ws.emit('open');
    await settle();
    check(getSnapshot().connection === 'live', 'Stale: first open needs no rehydrate');

    await act(() => ws.emit('close'));
    check(root.querySelector('#connBanner') !== null, 'Stale: closing the socket shows the banner');
    check(root.querySelector('#stage')!.hasAttribute('inert'), 'Stale: stage controls are inert');

    stateStatus = 500;
    connectWS();
    const retried = sockets.at(-1)!;
    check(retried !== ws, 'Stale: reconnect opens a new socket');
    retried.emit('open');
    await settle();
    check(
      getSnapshot().connection === 'stale' && retried.closed === 1,
      'Stale: a failed rehydrate stays stale and drops the socket to retry',
    );

    stateStatus = 200;
    connectWS();
    sockets.at(-1)!.emit('open');
    await settle();
    check(getSnapshot().connection === 'live', 'Stale: a fresh snapshot clears the stale marker');
    check(root.querySelector('#connBanner') === null, 'Stale: banner disappears after rehydrate');
    check(
      !root.querySelector('#stage')!.hasAttribute('inert'),
      'Stale: stage is interactive again',
    );
  } finally {
    globalThis.fetch = original.fetch;
    globalThis.WebSocket = original.ws;
    globalThis.setTimeout = original.timeout;
    await act(() => render(null, root));
    await act(() => patch(storeBefore));
  }
}

async function runConnectionPath(root: HTMLElement, check: Check): Promise<void> {
  await act(() =>
    render(<ConnectionPath device="done" app="active" deviceName="Mirabox 293S" />, root),
  );
  const nodes = [...root.querySelectorAll('.conn-node')];
  check(nodes.length === 3, 'Path: device, bridge and app nodes render');
  check(
    nodes[0]!.textContent.includes('Mirabox 293S: connected'),
    'Path: device node names its state',
  );
  check(nodes[2]!.querySelector('.ico-spin') !== null, 'Path: waiting app node shows a spinner');
  check(nodes[2]!.textContent.includes('waiting'), 'Path: state is also available as text');
  await act(() => render(<ConnectionPath device="active" app="pending" />, root));
  check(
    root.querySelectorAll('.conn-node')[2]!.querySelector('.ico-pending') !== null,
    'Path: pending node shows a ring',
  );
  await act(() => render(null, root));
}

async function runConflictStage(root: HTMLElement, check: Check): Promise<void> {
  await act(() => render(<StageConflict />, root));
  const diagram = root.querySelector('.own-diagram');
  check(diagram?.getAttribute('role') === 'img', 'Conflict: ownership diagram is a named image');
  check(
    diagram?.getAttribute('aria-label')?.includes('DeckBridge') === true,
    'Conflict: diagram label states the outcome in text',
  );
  check(
    root.querySelectorAll('.own-link:not(.own-new)').length === 1 &&
      root.querySelectorAll('.own-new[stroke-dasharray]').length === 1,
    'Conflict: held link is solid, pending link is dashed',
  );
  await act(() => render(null, root));
}

/** Single-device preview must honour click-to-press like the dock cards do. */
async function runSinglePress(root: HTMLElement, check: Check): Promise<void> {
  const urls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string) => {
    urls.push(url);
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
  }) as unknown as typeof fetch;
  try {
    await act(() => patch({ keyPressEnabled: true }));
    await settle();
    const cell = root.querySelector<HTMLElement>('.key-cell[data-key="0"]')!;
    check(cell.classList.contains('clickable'), 'Press: enabled + paired marks keys clickable');
    cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    cell.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
    check(
      urls.filter((u) => u === '/api/key/0').length === 2,
      'Press: double-click and Enter each send a key request',
    );
    await act(() => patch({ keyPressEnabled: false }));
    await settle();
    check(
      !root.querySelector('.key-cell[data-key="0"]')!.classList.contains('clickable'),
      'Press: disabling the setting makes keys inert again',
    );
  } finally {
    globalThis.fetch = original;
  }
}

async function runReadyStage(root: HTMLElement, check: Check): Promise<void> {
  const storeBefore = getSnapshot();
  await act(() => {
    patch({
      status: {
        ...STATE,
        modelName: 'Mirabox 293S',
        keyCount: 15,
        columns: 5,
        elgatoConnected: true,
        clientApp: 'elgato',
      },
    });
    render(<StageReady />, root);
  });
  check(
    root.querySelector('.stage-title')?.textContent === 'Connected to the Elgato app',
    'Ready: one status line names the app',
  );
  check(
    root.querySelector('.ready-status-device')?.textContent === 'Mirabox 293S',
    'Ready: compact summary identifies the connected device',
  );
  check(root.querySelector('.hero') === null, 'Ready: no hero block');
  await runSinglePress(root, check);
  await act(() => render(null, root));
  await act(() => patch(storeBefore));
}

const pending = (index: number): DockUi => ({
  index,
  ...DOCK_IDENTITY,
  modelId: 'mirabox-293s',
  modelName: `Deck ${index}`,
  keyCount: 15,
  columns: 5,
  rows: 3,
  primaryPort: 5343 + index,
  primaryConnected: false,
  elgatoConnected: false,
  brightness: 100,
});

async function runPairingDockCards(root: HTMLElement, check: Check): Promise<void> {
  const docks = [pending(0), pending(1)];
  const posts: Array<{ url: string; body: unknown }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    posts.push({ url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
      text: () => Promise.resolve('{}'),
    });
  }) as unknown as typeof fetch;
  try {
    await act(() =>
      patch({ status: { ...EMPTY_STATUS, driverConnected: true, docks, selectedDock: 0 } }),
    );
    await act(() => render(<DockList docks={docks} onHelp={() => {}} />, root));
    await settle();
    const cards = root.querySelectorAll<HTMLElement>('.dock-card');
    check(
      cards[0]!.querySelector('.pairing-flow') !== null,
      'Dock pairing: the selected card shows the pairing choice',
    );
    check(
      cards[1]!.querySelector('.pairing-flow') === null,
      'Dock pairing: other pending cards do not repeat it',
    );
    check(
      cards[0]!.querySelector('.dock-card-name')!.getAttribute('aria-pressed') === 'true' &&
        cards[1]!.querySelector('.dock-card-name')!.getAttribute('aria-pressed') === 'false',
      'Dock pairing: the name button exposes the selection',
    );
    check(
      cards[0]!.getAttribute('role') === null,
      'Dock pairing: the card is not a button wrapping buttons',
    );

    await act(() =>
      cards[0]!.querySelectorAll<HTMLButtonElement>('.pairing-answers button')[1]!.click(),
    );
    check(
      cards[0]!.querySelector<HTMLDetailsElement>('.manual-add')?.open === true,
      'Dock pairing: No opens manual pairing on the selected dock',
    );
    check(
      cards[0]!.textContent.includes('5343'),
      'Dock pairing: manual pairing uses this dock’s port',
    );

    const chip = cards[0]!.querySelector<HTMLButtonElement>('.addr-port-chip')!;
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    chip.dispatchEvent(enter);
    check(!enter.defaultPrevented, 'Dock pairing: Enter on a copy chip keeps its own activation');
    await act(() => chip.click());
    check(
      posts.every((p) => p.url !== '/api/select-dock'),
      'Dock pairing: a nested control click does not select',
    );

    await act(() => cards[1]!.querySelector<HTMLButtonElement>('.dock-card-name')!.click());
    check(
      posts.some((p) => p.url === '/api/select-dock' && (p.body as { index: number }).index === 1),
      'Dock pairing: the name button selects its dock',
    );
  } finally {
    globalThis.fetch = original;
    await act(() => render(null, root));
    await act(() => patch({ status: EMPTY_STATUS }));
  }
}

async function runPairingChoices(root: HTMLElement, check: Check): Promise<void> {
  const original = globalThis.fetch;
  const storeBefore = getSnapshot();
  const requests: Array<{ url: string; method: string }> = [];
  let running = false;
  let supported = true;
  let statusCode = 200;
  let restartOk = true;
  let finishAction: (() => void) | undefined;
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    requests.push({ url, method: init?.method ?? 'GET' });
    if (url === '/api/elgato-app/restart') {
      return new Promise((resolve) => {
        finishAction = () => {
          running = true;
          resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ ok: restartOk, reason: 'launch-failed' }),
          });
        };
      });
    }
    return Promise.resolve({
      ok: statusCode === 200,
      status: statusCode,
      json: () => Promise.resolve({ running, supported }),
    });
  }) as unknown as typeof fetch;
  const choose = async (yes: boolean): Promise<void> => {
    await act(() =>
      root.querySelectorAll<HTMLButtonElement>('.pairing-answers button')[yes ? 0 : 1]!.click(),
    );
    await settle();
  };
  try {
    await act(() => {
      patch({ status: { ...EMPTY_STATUS, driverConnected: true, localIp: '127.0.0.1' } });
      render(<StageDeviceNoElgato onHelp={() => {}} />, root);
    });
    check(root.textContent.includes('Already paired?'), 'Pairing: starts with Already paired?');
    check(requests.length === 0, 'Pairing: choosing Yes or No never launches the app');
    check(
      root.querySelector('.manual-add, .pairing-action') === null,
      'Pairing: no branch before choosing',
    );
    await choose(false);
    check(
      root.querySelector<HTMLDetailsElement>('.manual-add')?.open === true,
      'Pairing: No opens manual instructions',
    );
    check(
      root.querySelector('.addr-chip .addr-text')?.textContent === '127.0.0.1',
      'Pairing: manual instructions show the IP',
    );
    check(
      root.querySelectorAll('[aria-pressed="true"]').length === 1,
      'Pairing: only No is selected',
    );
    await act(() => root.querySelector<HTMLElement>('.manual-add > summary')!.click());
    check(
      root.querySelector<HTMLDetailsElement>('.manual-add')?.open === false,
      'Pairing: manual instructions still collapse',
    );
    await choose(true);
    check(root.querySelector('.manual-add') === null, 'Pairing: Yes hides manual instructions');
    check(
      root.querySelector('.pairing-action')?.textContent === 'Open Elgato app',
      'Pairing: stopped process shows Open',
    );
    check(
      requests.every((r) => r.method === 'GET'),
      'Pairing: Yes only reads process status',
    );
    const open = root.querySelector<HTMLButtonElement>('.pairing-action')!;
    await act(() => open.click());
    await act(() => open.click());
    check(open.disabled, 'Pairing: action is disabled while launching');
    check(
      requests.filter((r) => r.method === 'POST').length === 1,
      'Pairing: repeated activation sends one action',
    );
    await act(() => finishAction!());
    await settle();
    check(
      root.querySelector('.pairing-action')?.textContent === 'Restart Elgato app',
      'Pairing: running process shows Restart after launch',
    );
    check(root.textContent.includes('Elgato app opened.'), 'Pairing: launch completion is visible');
    running = false;
    await refreshAppStatus();
    check(
      root.querySelector('.pairing-action')?.textContent === 'Open Elgato app',
      'Pairing: focus refresh detects an app that quit',
    );
    running = true;
    await choose(false);
    await choose(true);
    check(
      root.querySelector('.pairing-action')?.textContent === 'Restart Elgato app',
      'Pairing: Yes detects an already running app',
    );
    restartOk = false;
    await act(() => root.querySelector<HTMLButtonElement>('.pairing-action')!.click());
    await act(() => finishAction!());
    await settle();
    check(
      root.querySelector('.settings-error')?.textContent.includes('launch-failed') === true,
      'Pairing: failed app control shows the server reason',
    );
    check(
      !root.querySelector<HTMLButtonElement>('.pairing-action')!.disabled,
      'Pairing: failed action can be retried',
    );
    statusCode = 500;
    await refreshAppStatus();
    check(
      root.querySelector('.pairing-action') === null,
      'Pairing: failed detection never guesses an action',
    );
    check(
      root.textContent.includes('Cannot check Elgato app.'),
      'Pairing: failed status read is visible',
    );
    statusCode = 200;
    await act(() =>
      [...root.querySelectorAll<HTMLButtonElement>('button')]
        .find((b) => b.textContent === 'Retry')!
        .click(),
    );
    await settle();
    check(
      root.querySelector('.pairing-action')?.textContent === 'Restart Elgato app',
      'Pairing: Retry restores process detection',
    );
    supported = false;
    await refreshAppStatus();
    check(
      root.querySelector('.pairing-action') === null &&
        root.textContent.includes('on its computer'),
      'Pairing: unsupported hosts guide users to the app’s computer',
    );
    await act(() => render(null, root));
    const before = requests.length;
    await refreshAppStatus();
    check(requests.length === before, 'Pairing: leaving the branch removes the focus listener');
    check(
      requests.filter((r) => r.method === 'POST').every((r) => r.url === '/api/elgato-app/restart'),
      'Pairing: app actions use the existing server controller',
    );
  } finally {
    await act(() => render(null, root));
    globalThis.fetch = original;
    await act(() => patch(storeBefore));
  }
}

export async function runPairingFlow(root: HTMLElement, check: Check): Promise<void> {
  await runBootAndStale(root, check);
  await runConnectionPath(root, check);
  await runConflictStage(root, check);
  await runReadyStage(root, check);
  await runPairingChoices(root, check);
  await runPairingDockCards(root, check);
}
