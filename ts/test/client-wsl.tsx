/* eslint-disable sonarjs/no-hardcoded-ip -- fixture addresses, nothing is contacted */
// Browser regressions for the WSL checklist and the ready line.
// Called from run() in client-regressions.tsx (real Chrome via CDP, see scripts/test-client.mjs).
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { getSnapshot, patch } from '../src/web/client/lib/store.js';
import { WslReadyLine, WslRelaySteps } from '../src/web/client/simple/wsl-relay-card.js';
import { STUCK_MS } from '../src/web/client/simple/wsl-relay-steps.js';
import type { PairingRouteStatus } from '../src/web/client/ui-types.js';
import type { WslRelayStatus } from '../src/web/contract-wsl-relay.js';

type Check = (condition: boolean, message: string) => void;

function status(over: Partial<WslRelayStatus>): WslRelayStatus {
  return {
    supported: true,
    enabled: false,
    state: 'off',
    wslIp: null,
    ipChanged: false,
    distro: null,
    detail: null,
    fixCommand: null,
    ...over,
  };
}

function route(over: Partial<PairingRouteStatus>): PairingRouteStatus {
  return {
    supported: true,
    route: 'wsl',
    elgatoVersion: '7.6.1',
    relayIp: null,
    relayVersion: null,
    versionMismatch: false,
    announcedAt: null,
    paired: false,
    wizardDismissed: false,
    ...over,
  };
}

let turnedOff = 0;
const view = (): preact.JSX.Element => (
  <>
    <WslRelaySteps onTurnedOff={() => (turnedOff += 1)} />
    <WslReadyLine />
  </>
);

export async function runWslRelay(root: HTMLElement, check: Check): Promise<void> {
  const before = getSnapshot().wslRelay;
  const beforeRoute = getSnapshot().pairingRoute;
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${url} ${(init?.body as string | undefined) ?? ''}`);
    const next =
      url === '/api/pairing-route' ? route({ route: 'none' }) : status({ enabled: true });
    return Promise.resolve(new Response(JSON.stringify(next), { status: 200 }));
  }) as typeof fetch;
  try {
    patch({ wslRelay: null, pairingRoute: null });
    await act(() => render(view(), root));
    check(root.textContent === '', 'WSL relay UI is hidden without a status');

    patch({ wslRelay: status({ supported: false, enabled: true, wslIp: '172.20.1.2' }) });
    await act(() => render(view(), root));
    check(root.textContent === '', 'WSL relay UI is hidden when unsupported');

    patch({ wslRelay: status({ enabled: true, state: 'checking' }) });
    await act(() => render(view(), root));
    check(root.querySelectorAll('#wsl-relay-card li').length === 5, 'The checklist lists 5 steps');
    check(root.querySelector('#toggle-wsl-relay') === null, 'No WSL switch any more');
    await act(async () => {
      root.querySelectorAll<HTMLButtonElement>('#wsl-relay-card .ghostbtn')[0]!.click();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    check(
      calls[0] === 'POST /api/pairing-route {"route":"none"}',
      `Turn off posts route none (${calls[0]})`,
    );
    check(turnedOff === 1, 'Turn off tells the wizard');
    check(getSnapshot().pairingRoute?.route === 'none', 'The reply updates the store');

    patch({
      wslRelay: status({
        enabled: true,
        state: 'old-glibc',
        fixCommand: 'wsl --install -d Ubuntu-24.04',
      }),
    });
    await act(() => render(view(), root));
    const card = root.querySelector('#wsl-relay-card')!;
    check(card.querySelector('.wsl-err') !== null, 'A failed step is marked');
    check(card.textContent.includes('Check again'), 'A failed step offers Check again');
    check(
      card.querySelector('.addr-chip')!.getAttribute('aria-label')!.includes('Ubuntu-24.04'),
      'The fix command is a copy chip',
    );

    patch({ wslRelay: status({ enabled: true, state: 'ready', wslIp: '172.20.1.2' }) });
    await act(() => render(view(), root));
    check(!root.textContent.includes('Check again'), 'No Check again without an error');
    check(root.querySelector('.wsl-ready') === null, 'No ready line without a relay IP');
    patch({ pairingRoute: route({ relayIp: '172.20.1.2' }) });
    await act(() => render(view(), root));
    check(
      root.querySelector('.wsl-ready')!.textContent.startsWith('via relay · 172.20.1.2'),
      'Ready line shows the relay IP',
    );
    patch({ pairingRoute: route({ route: 'downgrade', relayIp: '172.20.1.2' }) });
    await act(() => render(view(), root));
    check(root.querySelector('.wsl-ready') === null, 'No ready line for a non-relay route');

    // Only the 2-minute stuck timer is captured; Preact's own timers pass through.
    const realSetTimeout = globalThis.setTimeout;
    let fireStuck: (() => void) | undefined;
    globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
      if (ms !== STUCK_MS) return realSetTimeout(fn, ms, ...rest);
      fireStuck = fn;
      return 0;
    }) as typeof setTimeout;
    try {
      patch({ wslRelay: status({ enabled: true, state: 'starting' }) });
      await act(() => render(view(), root));
      patch({ wslRelay: status({ enabled: true, state: 'ready', wslIp: '172.20.1.2' }) });
      await act(() => render(view(), root));
      check(fireStuck !== undefined, 'Ready arms the stuck timer');
      check(!root.textContent.includes('Still not paired?'), 'No hint before the timer fires');
      await act(() => fireStuck?.());
      const stuckCard = root.querySelector('#wsl-relay-card')!;
      check(
        stuckCard.textContent.includes('Still not paired?'),
        'Stuck hint shows after 2 minutes',
      );
      check(
        stuckCard.querySelector('a[href="/go/docs/wsl-relay-stuck"]') !== null,
        'Stuck hint links to the troubleshooting row',
      );
      patch({ wslRelay: status({ enabled: true, state: 'paired', wslIp: '172.20.1.2' }) });
      await act(() => render(view(), root));
      check(!root.textContent.includes('Still not paired?'), 'Another state clears the hint');
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  } finally {
    globalThis.fetch = original;
    patch({ wslRelay: before, pairingRoute: beforeRoute });
    await act(() => render(null, root));
  }
}

/** A WS `wslRelay` event that lands while hydrate()'s GET is in flight must survive its reply. */
export async function runWslHydrateRace(hydrateNow: () => void, check: Check): Promise<void> {
  const before = getSnapshot().wslRelay;
  const original = globalThis.fetch;
  globalThis.fetch = () =>
    new Promise<Response>((resolve) => {
      setTimeout(() => resolve(new Response(JSON.stringify(status({ state: 'off' })))), 20);
    });
  try {
    patch({ wslRelay: null });
    hydrateNow();
    patch({ wslRelay: status({ enabled: true, state: 'ready', wslIp: '172.20.1.2' }) });
    await new Promise((resolve) => setTimeout(resolve, 60));
    check(
      getSnapshot().wslRelay?.state === 'ready',
      'A WS wslRelay event is not overwritten by the older GET reply',
    );
    patch({ wslRelay: null });
    hydrateNow();
    await new Promise((resolve) => setTimeout(resolve, 60));
    check(getSnapshot().wslRelay?.state === 'off', 'Without a newer event the GET reply applies');
  } finally {
    globalThis.fetch = original;
    patch({ wslRelay: before });
  }
}
