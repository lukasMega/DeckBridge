/* eslint-disable sonarjs/no-hardcoded-ip -- fixture addresses, nothing is contacted */
// Browser regressions for the "Fix pairing" wizard: auto-open, screen flow, route POST and
// the version banner. Called from run() in client-regressions.tsx (real Chrome via CDP).
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { getSnapshot, patch } from '../src/web/client/lib/store.js';
import {
  ElgatoVersionBanner,
  PairingWizardHost,
  useAutoOpen,
} from '../src/web/client/simple/pairing-wizard/entry.js';
import type { PairingProbe, PairingRouteStatus } from '../src/web/client/ui-types.js';
import type { WslRelayStatus } from '../src/web/contract-wsl-relay.js';

type Check = (condition: boolean, message: string) => void;

function route(over: Partial<PairingRouteStatus> = {}): PairingRouteStatus {
  return {
    supported: true,
    route: 'none',
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

const WSL: WslRelayStatus = {
  supported: true,
  enabled: true,
  state: 'checking',
  wslIp: null,
  ipChanged: false,
  distro: null,
  detail: null,
  fixCommand: null,
};

/** The pairing stage: what StageDeviceNoElgato mounts. */
function Stage(): preact.JSX.Element {
  useAutoOpen(true);
  return <PairingWizardHost onHelp={() => undefined} />;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function press(el: HTMLElement | null): Promise<void> {
  await act(async () => {
    el?.click();
    await sleep(30);
  });
}

/** Shared helpers of one run: DOM queries over `root` and the recorded fetch calls. */
interface Ctx {
  root: HTMLElement;
  check: Check;
  calls: string[];
  q: (sel: string) => HTMLElement | null;
  choice: (text: string) => HTMLElement | null;
  next: () => Promise<void>;
  open: () => boolean;
  /** Fresh store + a fresh mount of the pairing stage. */
  mount: (over?: Partial<PairingRouteStatus>) => Promise<void>;
}

function makeCtx(root: HTMLElement, check: Check, calls: string[]): Ctx {
  const q = (sel: string): HTMLElement | null => root.querySelector<HTMLElement>(sel);
  return {
    root,
    check,
    calls,
    q,
    choice: (text) =>
      [...root.querySelectorAll<HTMLElement>('.pairing-choice')].find((b) =>
        b.textContent.includes(text),
      ) ?? null,
    next: () => press(q('#pw-next')),
    open: () => q('#pairing-wizard') !== null,
    mount: async (over = {}) => {
      patch({
        pairingRoute: route(over),
        pairingWizardOpen: false,
        pairingWizardRestart: false,
        wslRelay: WSL,
      });
      calls.length = 0;
      await act(() => render(null, root));
      await act(() => render(<Stage />, root));
    },
  };
}

async function autoOpen(t: Ctx): Promise<void> {
  await t.mount();
  t.check(t.open(), 'The wizard auto-opens for an affected, unset install');
  await press(t.q('#pw-cancel'));
  t.check(!t.open(), 'Cancel closes the wizard');
  t.check(
    t.calls.includes('POST /api/pairing-route/dismiss '),
    'Closing with no route posts the dismiss',
  );
  t.check(getSnapshot().pairingRoute?.wizardDismissed === true, 'The dismiss is applied at once');
  await act(() => render(null, t.root));
  await act(() => render(<Stage />, t.root));
  t.check(!t.open(), 'A dismissed wizard does not auto-open again');

  const quiet: Array<Partial<PairingRouteStatus>> = [
    { elgatoVersion: '7.6.0' },
    { supported: false },
    { route: 'wsl' },
  ];
  for (const over of quiet) {
    await t.mount(over);
    t.check(!t.open(), `No auto-open for ${JSON.stringify(over)}`);
  }
}

async function shortFlows(t: Ctx): Promise<void> {
  await t.mount();
  const newer = t.choice('7.6.1 or newer');
  t.check(
    newer?.getAttribute('aria-pressed') === 'true',
    'A detected 7.6.1 preselects "7.6.1 or newer"',
  );
  t.check(
    t.q('#pw-next')?.hasAttribute('disabled') === false,
    'The preselected answer enables Next',
  );
  t.check(t.q('#pairing-wizard')?.textContent.includes('Step 1 of 2') === true, 'Progress shows');

  await press(t.choice('7.6.0 or older'));
  t.check(
    t.choice('7.6.0 or older')?.getAttribute('aria-pressed') === 'true',
    'Picking an answer presses it',
  );
  await t.next();
  t.check(
    t.q('#pairing-wizard')!.textContent.includes('No fix needed. Stream Deck app 7.6.0'),
    '"7.6.0 or older" ends at the no-fix screen',
  );
  t.check(t.q('#pw-next') === null, 'The last screen has no Next');
  t.check(t.q('#pw-cancel')?.textContent === 'Done', 'The last screen offers Done');
  await press(t.q('#pw-cancel'));
  t.check(!t.open(), 'Done closes the wizard');

  await t.mount();
  await t.next();
  await press(t.choice('On another computer'));
  await t.next();
  t.check(
    t.q('#pairing-wizard')!.textContent.includes('Pair the Stream Deck app on the other computer'),
    '"On another computer" ends at the elsewhere screen',
  );
  t.check(t.q('.manual-add') !== null, 'The elsewhere screen shows the manual address panel');
  await press(t.q('#pw-cancel'));
}

async function chooseWsl(t: Ctx): Promise<void> {
  await t.mount({ wizardDismissed: true });
  patch({ pairingWizardOpen: true });
  await act(() => render(<Stage />, t.root));
  t.check(t.open(), 'The wizard opens on request even when dismissed');
  await t.next();
  await press(t.choice('On this computer'));
  await t.next();
  t.check(
    t.q('#pairing-wizard')!.textContent.includes('Why pairing fails'),
    'The why screen shows',
  );
  await t.next();
  t.check(t.q('#pw-next')?.hasAttribute('disabled') === true, 'Next waits for the device answer');
  await press(t.choice('No, only this computer'));
  await t.next();
  const titles = [...t.root.querySelectorAll('.pairing-choice strong')].map((e) => e.textContent);
  t.check(
    titles[0]?.startsWith('Use Stream Deck app 7.6.0') === true &&
      titles[1]?.startsWith('Relay in WSL on this PC') === true,
    `The downgrade is listed first (${titles.join(' | ')})`,
  );
  const wsl = t.choice('Relay in WSL')!;
  t.check(
    wsl.textContent.includes('Recommended') &&
      wsl.textContent.includes('Ready: Ubuntu-24.04 (WSL 2)'),
    'WSL is recommended and shows the probe badge',
  );
  t.check(t.q('#pw-next')?.hasAttribute('disabled') === true, 'Next waits for a choice');

  await press(t.q('#pw-back'));
  t.check(
    t.choice('No, only this computer')?.getAttribute('aria-pressed') === 'true',
    'Back returns to the previous screen with the answer kept',
  );
  await t.next();

  await press(t.choice('Relay in WSL'));
  await t.next();
  t.check(
    t.calls.includes('POST /api/pairing-route {"route":"wsl"}'),
    `Choosing wsl posts the route (${t.calls.join(' ; ')})`,
  );
  t.check(getSnapshot().pairingRoute?.route === 'wsl', 'The reply updates the store');
  t.check(t.q('#wsl-relay-card li') !== null, 'The WSL steps show');
  t.check(t.q('#pw-cancel')?.textContent === 'Done', 'The WSL setup ends the wizard');
  await press(t.q('#pw-cancel'));
  t.check(
    getSnapshot().pairingRoute?.wizardDismissed === true,
    'Closing with a route set also counts as seen, so "Turn off relay" never auto-reopens it',
  );
}

async function reopen(t: Ctx): Promise<void> {
  patch({ pairingWizardOpen: true });
  await act(() => render(null, t.root));
  await act(() => render(<Stage />, t.root));
  t.check(t.q('#wsl-relay-card') !== null, 'A set route reopens at its setup screen');
  patch({ pairingWizardOpen: false });
  await act(() => render(null, t.root));
  patch({ pairingWizardOpen: true, pairingWizardRestart: true });
  await act(() => render(<Stage />, t.root));
  t.check(t.choice('7.6.1 or newer') !== null, '"Run setup again" starts at the version screen');
  patch({ pairingWizardOpen: false });
  await act(() => render(null, t.root));
}

async function banner(t: Ctx): Promise<void> {
  const shown = async (over: Partial<PairingRouteStatus> | null): Promise<boolean> => {
    patch({ pairingRoute: over === null ? null : route(over) });
    await act(() => render(<ElgatoVersionBanner />, t.root));
    return t.root.textContent !== '';
  };
  t.check(!(await shown({ elgatoVersion: '7.6.0' })), 'The banner is hidden for 7.6.0');
  t.check(!(await shown({ supported: false })), 'The banner is hidden when unsupported');
  t.check(!(await shown({ route: 'device' })), 'The banner is hidden once a route is set');
  t.check(!(await shown(null)), 'The banner is hidden without a status');
  t.check(await shown({ elgatoVersion: null }), 'The banner shows for an unknown version');
  await press(t.q('.linkbtn'));
  t.check(getSnapshot().pairingWizardOpen, 'The banner link opens the wizard');
}

export async function runPairingWizard(root: HTMLElement, check: Check): Promise<void> {
  const before = getSnapshot();
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    const body = (init?.body as string | undefined) ?? '';
    calls.push(`${init?.method ?? 'GET'} ${url} ${body}`);
    let reply: unknown = {};
    if (url === '/api/pairing-route/probe') reply = PROBE;
    else if (url === '/api/pairing-route/dismiss') reply = route({ wizardDismissed: true });
    else if (url === '/api/pairing-route') reply = route(JSON.parse(body) as object);
    return Promise.resolve(new Response(JSON.stringify(reply), { status: 200 }));
  }) as typeof fetch;
  const t = makeCtx(root, check, calls);
  try {
    await autoOpen(t);
    await shortFlows(t);
    await chooseWsl(t);
    await reopen(t);
    await banner(t);
  } finally {
    globalThis.fetch = original;
    patch({
      pairingRoute: before.pairingRoute,
      pairingWizardOpen: before.pairingWizardOpen,
      pairingWizardRestart: before.pairingWizardRestart,
      wslRelay: before.wslRelay,
    });
    await act(() => render(null, root));
  }
}
