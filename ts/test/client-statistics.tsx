import { render } from 'preact';
import { act } from 'preact/test-utils';
import { SimpleApp } from '../src/web/client/simple/SimpleApp.js';
import { ExtensionPage } from '../src/web/client/simple/extension-page.js';
import { ExtensionsPanel } from '../src/web/client/simple/extensions-panel.js';
import { getSnapshot, patch, EMPTY_STATUS } from '../src/web/client/lib/store.js';
import type { ExtensionInfo, ExtensionsView } from '../src/web/contract-extensions.js';
import * as statisticsUi from '../src/extensions/statistics/ui.js';
import type {
  DeckCounters,
  DeckStats,
  StatsSnapshot,
} from '../src/extensions/statistics/contract.js';

type Check = (condition: boolean, message: string) => void;

const settle = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
};

/** Real time passes inside act(): a module import or a mount outside act() needs it. */
async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 40 && !cond(); i++) {
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 50)));
  }
}

const ZERO: DeckCounters = {
  keyPresses: 0,
  dialPresses: 0,
  dialDetents: 0,
  imagesProcessed: 0,
  cacheHits: 0,
  reconnects: 0,
  activity: Array.from({ length: 15 }, () => 0),
};

function deck(over: Partial<DeckStats>): DeckStats {
  return {
    ...ZERO,
    deviceKey: 'k',
    modelName: 'Deck',
    source: 'usb',
    hasEncoders: false,
    keys: [],
    ...over,
  };
}

function snapshot(decks: DeckStats[], totals: Partial<DeckCounters>): StatsSnapshot {
  return {
    startedAt: 2_000,
    appStartedAt: 1_000,
    at: 8_000_000,
    uptimeMs: 8_040_000,
    totals: { ...ZERO, ...totals },
    decks,
  };
}

const STATS: ExtensionInfo = {
  id: 'statistics',
  name: 'Statistics',
  version: '1.0.0',
  enabled: true,
  state: 'running',
  page: { title: 'Statistics', icon: '<svg id="statsIcon"></svg>' },
  rev: 1,
};

type FetchStub = (url: string, init?: RequestInit) => unknown;

function stubFetch(answer: FetchStub): { urls: string[]; bodies: unknown[]; restore: () => void } {
  const original = globalThis.fetch;
  const urls: string[] = [];
  const bodies: unknown[] = [];
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    urls.push(url);
    if (typeof init?.body === 'string') bodies.push(JSON.parse(init.body));
    let payload: unknown;
    try {
      payload = answer(url, init);
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(payload ?? {}),
    } as Response);
  }) as typeof fetch;
  return { urls, bodies, restore: () => (globalThis.fetch = original) };
}

/** The app shell: topbar button from the manifest, page chrome, fallback when ui.js fails. */
async function runShell(check: Check): Promise<void> {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const fetches = stubFetch((url) => (url === '/api/requirements' ? [] : {}));
  const before = getSnapshot();
  const live = (): string | null => root.querySelector('#stage')!.getAttribute('aria-live');
  try {
    await act(() =>
      patch({
        status: { ...EMPTY_STATUS, docks: [] },
        extensions: {
          dir: '/x',
          extensions: [STATS, { ...STATS, id: 'off', state: 'disabled', enabled: false }],
        },
      }),
    );
    await act(() => render(<SimpleApp />, root));
    await settle();
    const button = root.querySelector<HTMLButtonElement>('#ext-statistics');
    check(button?.getAttribute('aria-label') === 'Statistics', 'A running extension gets a button');
    check(root.querySelector('#statsIcon') !== null, 'The button shows the manifest icon');
    check(root.querySelector('#ext-off') === null, 'A disabled extension gets none');
    check(live() === 'polite', 'Home stage announces changes');

    await act(() => button!.click());
    await settle();
    const heading = root.querySelector('.settings-page h1');
    check(heading?.textContent === 'Statistics', 'The page title comes from the manifest');
    check(document.activeElement === heading, 'The page heading takes focus');
    check(live() === 'off', 'An extension page is not a live region');
    // file:// has no /ext/…/ui.js, so the import fails like a broken extension would.
    await waitFor(() => root.querySelector('.settings-error') !== null);
    check(
      root.querySelector('.settings-error')?.textContent === 'Could not load Statistics.',
      'A ui.js that fails to load says so',
    );

    await act(() =>
      patch({ extensions: { dir: '/x', extensions: [{ ...STATS, state: 'error' }] } }),
    );
    check(root.querySelector('.settings-page') === null, 'A stopped extension closes its page');
    check(root.querySelector('#ext-statistics') === null, 'and loses its button');
  } finally {
    fetches.restore();
    await act(() => render(null, root));
    root.remove();
    await act(() => patch(before));
  }
}

/** The Statistics ui.js itself, mounted by ExtensionPage with the host API. */
async function runStatisticsUi(check: Check): Promise<void> {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const activity = Array.from({ length: 15 }, () => 0);
  activity[14] = 3;
  activity[13] = 1;
  const usb = deck({
    deviceKey: 'a',
    modelName: 'AJAZZ AKP05E',
    hasEncoders: true,
    keyPresses: 4,
    dialPresses: 2,
    dialDetents: 7,
    imagesProcessed: 10,
    cacheHits: 5,
    reconnects: 1,
    activity,
    keys: [
      { label: 'R1 C1', count: 3 },
      { label: 'Extra 1', count: 1 },
    ],
  });
  const mock = deck({
    deviceKey: 'b',
    modelName: 'Mock deck',
    source: 'mock',
    keyPresses: 2,
    keys: [{ label: 'R1 C2', count: 2 }],
  });
  let failing = false;
  const current = snapshot([usb, mock], {
    keyPresses: 6,
    dialPresses: 2,
    dialDetents: 7,
    imagesProcessed: 10,
    cacheHits: 5,
    activity,
  });
  const fetches = stubFetch((url) => {
    if (url !== '/api/ext/statistics/snapshot') return {};
    if (failing) throw new Error('offline');
    return current;
  });
  const before = getSnapshot();
  const text = (selector: string): string => root.querySelector(selector)?.textContent ?? '';
  const rows = (): string[] =>
    [...root.querySelectorAll('.settings-page .identity-list li')].map((li) => li.textContent);
  let backs = 0;
  const page = (): preact.JSX.Element => (
    <ExtensionPage ext={STATS} onBack={() => backs++} load={() => Promise.resolve(statisticsUi)} />
  );
  try {
    await act(() => patch({ status: { ...EMPTY_STATUS, docks: [] } }));
    await act(() => render(page(), root));
    await waitFor(() => root.querySelector('.help-lead')?.textContent.includes('2h') === true);
    check(
      fetches.urls.includes('/api/ext/statistics/snapshot'),
      'Statistics reads its snapshot route',
    );
    check(text('.help-lead').includes('Since DeckBridge started'), 'Counting began with the app');
    check(text('.help-lead').includes('2h 14m'), 'Uptime is formatted');
    check(text('.help-lead').includes('Simulated'), 'A mock deck shows the Simulated badge');
    check(
      root.querySelectorAll('input[name="statsDeck"]').length === 3,
      'Deck picker offers All decks plus each deck',
    );
    const all = rows();
    check(all.includes('Key presses6'), 'All decks sums key presses');
    check(all.includes('Dial presses / detents2 / 7'), 'Dial row shows presses and detents');
    check(all.includes('Cache hit rate50%'), 'Cache hit rate is hits over images');
    check(all.includes('R1 C1 · AJAZZ AKP05E3'), 'Top keys name the deck on All decks');
    check(
      root.querySelectorAll('svg[role="img"] rect').length === 15 &&
        root.querySelectorAll('.visually-hidden > table tbody tr').length === 15,
      'Chart has 15 bars and a matching hidden table',
    );
    check(
      text('.visually-hidden > table > caption') === 'Key presses per minute',
      'Chart caption is inside the clipped wrapper for Firefox',
    );

    await act(() =>
      root.querySelector<HTMLInputElement>('input[name="statsDeck"][value="b"]')!.click(),
    );
    const mocked = rows();
    check(mocked.includes('Key presses2'), 'Deck picker narrows the counters');
    check(
      mocked.includes('Key images processed—') && mocked.includes('Cache hit rate—'),
      'Decks without a worker show a dash for images and cache',
    );
    check(!mocked.some((r) => r.startsWith('Dial presses')), 'Dial row is hidden without encoders');
    check(mocked.includes('R1 C22'), 'Top keys drop the deck name for one deck');

    await act(() =>
      root.querySelector<HTMLInputElement>('input[name="statsDeck"][value="a"]')!.click(),
    );
    check(rows().includes('Reconnects1'), 'Reconnects are shown');

    await act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    check(backs === 1, 'Escape asks the app to go back');

    failing = true;
    await act(() => render(null, root));
    await act(() => render(page(), root));
    await waitFor(() => root.querySelector('.settings-error') !== null);
    check(
      text('.settings-error') === 'Could not load statistics.',
      'A failed first load says so instead of showing zeros',
    );
  } finally {
    fetches.restore();
    await act(() => render(null, root));
    root.remove();
    await act(() => patch(before));
  }
}

/** Settings > Extensions: switches, problems, Rescan. */
async function runPanel(check: Check): Promise<void> {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const broken: ExtensionInfo = {
    id: 'broken',
    name: 'Broken',
    version: '0.1.0',
    enabled: false,
    state: 'invalid',
    error: 'server.js is missing',
    rev: 0,
  };
  const off: ExtensionsView = {
    dir: '/cache/extensions',
    extensions: [{ ...STATS, enabled: false, state: 'disabled' }, broken],
  };
  const on: ExtensionsView = { ...off, extensions: [STATS, broken] };
  const fetches = stubFetch((url) => (url.startsWith('/api/extensions') ? on : {}));
  const before = getSnapshot();
  try {
    await act(() => patch({ extensions: off }));
    await act(() => render(<ExtensionsPanel />, root));
    root.querySelector<HTMLElement>('.collapsible-header, .collapsible button')?.click();
    await settle();
    check(root.textContent.includes('/cache/extensions'), 'The panel names the folder');
    check(
      root.querySelector<HTMLInputElement>('#toggle-ext-broken')?.disabled === true,
      'An invalid extension cannot be switched on',
    );
    check(root.textContent.includes('Cannot run: server.js is missing'), 'and says why');
    await act(() => root.querySelector<HTMLInputElement>('#toggle-ext-statistics')!.click());
    await settle();
    check(
      fetches.urls.includes('/api/extensions/enabled') &&
        JSON.stringify(fetches.bodies.at(-1)) === '{"id":"statistics","enabled":true}',
      'The switch posts id and state',
    );
    check(getSnapshot().extensions === on, 'The reply updates the store');
    const rescan = [...root.querySelectorAll('button')].find((b) => b.textContent === 'Rescan');
    await act(() => rescan!.click());
    await settle();
    check(fetches.urls.includes('/api/extensions/rescan'), 'Rescan asks the server');
  } finally {
    fetches.restore();
    await act(() => render(null, root));
    root.remove();
    await act(() => patch(before));
  }
}

export async function runStatistics(check: Check): Promise<void> {
  await runShell(check);
  await runStatisticsUi(check);
  await runPanel(check);
}
