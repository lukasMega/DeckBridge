/* eslint-disable sonarjs/no-hardcoded-ip -- fixture addresses, nothing is contacted */
// Browser regressions for the relay details in the Settings pairing row. Called from run() in
// client-regressions.tsx (real Chrome via CDP).
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { getSnapshot, patch } from '../src/web/client/lib/store.js';
import { PairingRouteSetting } from '../src/web/client/simple/pairing-wizard/entry.js';
import type { PairingProbe, PairingRouteStatus } from '../src/web/client/ui-types.js';
import type { WslRelayStatus } from '../src/web/contract-wsl-relay.js';

type Check = (condition: boolean, message: string) => void;

function route(over: Partial<PairingRouteStatus> = {}): PairingRouteStatus {
  return {
    supported: true,
    route: 'device',
    elgatoVersion: '7.6.1',
    relayIp: '192.168.1.20',
    relayVersion: '0.22.0',
    versionMismatch: false,
    announcedAt: null,
    relay: {
      stage: 'running',
      ip: '192.168.1.20',
      platform: 'linux-arm64',
      version: '0.22.0',
      at: Date.now() - 5000,
    },
    paired: true,
    wizardDismissed: false,
    ...over,
  };
}

const PROBE: PairingProbe = {
  platform: 'Windows',
  lanIp: '192.168.1.5',
  coraPort: 5343,
  webuiPort: 3000,
  relayScriptPort: 44661,
  lanReachable: true,
  mac: null,
  wsl: { installed: true, distros: [{ name: 'Ubuntu-24.04', version: 2, isDefault: true }] },
};

const MAC_PROBE: PairingProbe = {
  ...PROBE,
  platform: 'macOS',
  mac: {
    version: '15.1',
    arch: 'arm64',
    orbstack: true,
    container: false,
    localNetworkBlocked: false,
  },
  wsl: null,
};

const WSL: WslRelayStatus = {
  supported: true,
  enabled: true,
  state: 'blocked',
  wslIp: '172.20.0.2',
  ipChanged: false,
  distro: 'Ubuntu-24.04',
  detail: 'Windows Firewall blocks the relay.',
  fixCommand: null,
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function press(el: HTMLElement | null): Promise<void> {
  await act(async () => {
    el?.click();
    await sleep(30);
  });
}

/** Lets the fetches of a freshly opened row resolve and re-render. */
const settle = (): Promise<void> => act(() => sleep(60));

interface Ctx {
  root: HTMLElement;
  check: Check;
  calls: string[];
  q: (sel: string) => HTMLElement | null;
  text: (sel: string) => string;
  /** The aria-label of the copy chip whose visible label is `label`. */
  chip: (label: string) => string | null;
  /** Fresh store and mount of the Settings row; `open` clicks the header. */
  mount: (
    over: Partial<PairingRouteStatus>,
    opts?: { open?: boolean; wsl?: WslRelayStatus | null; remote?: string | null },
  ) => Promise<void>;
  toggle: () => Promise<void>;
}

function makeCtx(root: HTMLElement, check: Check, calls: string[]): Ctx {
  const q = (sel: string): HTMLElement | null => root.querySelector<HTMLElement>(sel);
  const toggle = (): Promise<void> => press(q('.collapse-header'));
  return {
    root,
    check,
    calls,
    q,
    text: (sel) => q(sel)?.textContent ?? '',
    chip: (label) => {
      for (const b of root.querySelectorAll<HTMLElement>('button.addr-chip')) {
        if (b.querySelector('.addr-label')?.textContent === label) return b.ariaLabel ?? null;
      }
      return null;
    },
    toggle,
    mount: async (over, opts = {}) => {
      calls.length = 0;
      patch({
        pairingRoute: route(over),
        wslRelay: opts.wsl ?? null,
        status: {
          ...getSnapshot().status,
          elgatoRemoteAddr: opts.remote === undefined ? '192.168.1.20' : opts.remote,
        },
      });
      await act(() => render(null, root));
      await act(() => render(<PairingRouteSetting />, root));
      if (opts.open !== false) {
        await toggle();
        await settle();
      }
    },
  };
}

async function closedAndDevice(t: Ctx): Promise<void> {
  await t.mount({}, { open: false });
  t.check(
    !t.calls.some((c) => c.includes('/api/pairing-route/command') || c.includes('/probe')),
    'closed row: no probe or command fetch',
  );
  t.check(t.q('#pairing-route-details') === null, 'closed row: no details mounted');
  await t.toggle();
  await settle();
  const text = t.root.textContent;
  t.check(t.text('#prd-status').includes('Running'), 'details: Running chip');
  t.check(t.text('#prd-app') === 'Paired via relay', 'details: paired via relay');
  t.check(text.includes('linux-arm64 · v0.22.0'), 'details: build line');
  t.check(text.includes('192.168.1.5:5343'), 'details: target');
  t.check(t.chip('Uninstall')?.endsWith('sh -s -- --uninstall') === true, 'details: uninstall');
  t.check(t.chip('Run')?.includes('curl -fsSL') === true, 'details: curl run command');
  await press(t.q('input[name="prd-kind"][value="wget"]'));
  await settle();
  t.check(t.chip('Run')?.includes('Copy Run wget') === true, 'details: wget switches Run chip');
  await t.toggle();
  t.check(t.text('.collapse-status').includes('Running'), 'closed header shows health');
}

async function problems(t: Ctx): Promise<void> {
  const relay = route().relay;
  await t.mount({ relay: relay && { ...relay, stage: 'offline' } });
  t.check(t.text('#prd-problem').includes('Relay offline'), 'offline problem');
  await t.mount({
    versionMismatch: true,
    relayVersion: '0.1.0',
    relay: relay && { ...relay, version: '0.1.0' },
  });
  t.check(t.text('#prd-problem').includes('relay runs version 0.1.0'), 'version mismatch problem');
}

async function wslRoute(t: Ctx): Promise<void> {
  await t.mount({ route: 'wsl', relay: null, relayIp: '172.20.0.2' }, { wsl: WSL, remote: null });
  t.check(t.text('#prd-status').includes('Needs attention'), 'wsl status');
  t.check(t.text('#prd-problem') === 'Windows Firewall blocks the relay.', 'wsl detail shown');
  t.check(t.chip('Run') === null, 'wsl has no Run chip');
  t.check(t.q('#prd-ip-changed') === null, 'wsl IP unchanged: no warning');
  await t.mount({ route: 'wsl', relay: null }, { wsl: { ...WSL, ipChanged: true } });
  t.check(t.q('#prd-ip-changed') !== null, 'wsl IP changed warning');
  await t.mount({ route: 'wsl', relay: null }, { wsl: WSL });
  await press(t.q('#prd-recheck'));
  t.check(
    t.calls.some((c) => c.startsWith('POST /api/wsl-relay/recheck')),
    'wsl Check again posts recheck',
  );
}

async function otherRoutes(t: Ctx): Promise<void> {
  await t.mount({ route: 'orbstack' });
  t.check(
    t.chip('Run')?.includes("Copy Run orb -m deckbridge-relay sh -c 'curl") === true,
    'orbstack Run chip',
  );
  t.check(t.chip('Remove') === 'Copy Remove orb delete deckbridge-relay', 'orbstack Remove chip');
  await t.mount({});
  t.calls.length = 0;
  await press(t.q('#prd-recheck'));
  t.check(
    t.calls.some((c) => c === 'GET /api/pairing-route '),
    'device Check again reads the route',
  );
  await t.mount({ route: 'downgrade', relay: null });
  t.check(t.q('#pairing-route-details') === null, 'downgrade has no details');
}

export async function runPairingSettings(root: HTMLElement, check: Check): Promise<void> {
  const before = getSnapshot();
  const original = globalThis.fetch;
  const calls: string[] = [];
  let probe = PROBE;
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    const body = (init?.body as string | undefined) ?? '';
    calls.push(`${init?.method ?? 'GET'} ${url} ${body}`);
    let reply: unknown = {};
    if (url === '/api/pairing-route/probe') reply = probe;
    else if (url.startsWith('/api/pairing-route/command')) {
      reply = {
        command: `${url.endsWith('wget') ? 'wget -qO-' : 'curl -fsSL'} "http://192.168.1.5:44661/relay.sh?t=tok" | sh`,
      };
    } else if (url === '/api/pairing-route') reply = getSnapshot().pairingRoute;
    else if (url === '/api/wsl-relay/recheck') reply = { ...WSL, state: 'ready' };
    return Promise.resolve(new Response(JSON.stringify(reply), { status: 200 }));
  }) as typeof fetch;
  const t = makeCtx(root, check, calls);
  try {
    await closedAndDevice(t);
    await problems(t);
    await wslRoute(t);
    probe = MAC_PROBE;
    await otherRoutes(t);
  } finally {
    globalThis.fetch = original;
    patch({
      pairingRoute: before.pairingRoute,
      wslRelay: before.wslRelay,
      status: before.status,
    });
    await act(() => render(null, root));
  }
}
