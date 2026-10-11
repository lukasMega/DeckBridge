import { render } from 'preact';
import { act } from 'preact/test-utils';
import { SimpleApp } from '../src/web/client/simple/SimpleApp.js';
import { getSnapshot, patch, EMPTY_STATUS } from '../src/web/client/lib/store.js';
import type { DeckCounters, DeckStats, StatsSnapshot } from '../src/web/contract-stats.js';

type Check = (condition: boolean, message: string) => void;

const settle = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
};

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
    startedAt: 1,
    at: 8_000_000,
    uptimeMs: 8_040_000,
    totals: { ...ZERO, ...totals },
    decks,
  };
}

export async function runStatistics(check: Check): Promise<void> {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const original = globalThis.fetch;
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
  const urls: string[] = [];
  globalThis.fetch = ((url: string) => {
    urls.push(url);
    if (url === '/api/stats' && failing) return Promise.reject(new Error('offline'));
    let payload: unknown = {};
    if (url === '/api/stats') payload = current;
    else if (url === '/api/requirements') payload = [];
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(payload),
    } as Response);
  }) as typeof fetch;
  const before = getSnapshot();
  const text = (selector: string): string => root.querySelector(selector)?.textContent ?? '';
  const rows = (): string[] =>
    [...root.querySelectorAll('.settings-page .identity-list li')].map((li) => li.textContent);
  try {
    await act(() => patch({ status: { ...EMPTY_STATUS, docks: [] } }));
    await act(() => render(<SimpleApp />, root));
    await settle();
    const live = (): string | null => root.querySelector('#stage')!.getAttribute('aria-live');
    check(live() === 'polite', 'Home stage announces changes');

    await act(() => root.querySelector<HTMLButtonElement>('#statisticsBtn')!.click());
    await settle();
    check(text('.settings-page h1') === 'Statistics', 'Statistics button opens the page');
    check(
      document.activeElement === root.querySelector('.settings-page h1'),
      'Statistics heading takes focus on mount',
    );
    check(live() === 'off', 'Statistics stage is not a live region');
    check(urls.includes('/api/stats'), 'Statistics page reads /api/stats');
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
      root.querySelectorAll('svg.stats-chart rect').length === 15 &&
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

    failing = true;
    await act(() => root.querySelector<HTMLButtonElement>('.help-back')!.click());
    check(root.querySelector('.settings-page') === null, 'Back returns home');
    check(live() === 'polite', 'Home stage announces again');

    await act(() => root.querySelector<HTMLButtonElement>('#statisticsBtn')!.click());
    await settle();
    check(
      text('.settings-error') === 'Could not load statistics.',
      'A failed first load says so instead of showing zeros',
    );
    await act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    check(root.querySelector('.settings-page') === null, 'Escape returns home');
    await settle();
  } finally {
    globalThis.fetch = original;
    await act(() => render(null, root));
    root.remove();
    await act(() => patch(before));
  }
}
