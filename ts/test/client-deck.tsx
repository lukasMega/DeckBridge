/* eslint-disable sonarjs/no-clear-text-protocols, sonarjs/no-hardcoded-ip -- fixtures, nothing is contacted */
// Browser regressions for the phone/tablet deck page and the admin Browser-deck panel.
// Called from run() in client-regressions.tsx (real Chrome via CDP, see scripts/test-client.mjs).
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { FakeDeckSocket } from './helpers/fake-deck-socket.js';
import { DOCK_IDENTITY } from './helpers/dock-fixture.js';
import { EMPTY_STATUS, patch } from '../src/web/client/lib/store.js';
import { DockList } from '../src/web/client/simple/dock-cards.js';
import { KeyPressPanel } from '../src/web/client/simple/key-press-panel.js';
import type { DockStatus } from '../src/web/contract.js';
import { DeckApp } from '../src/web/client/deck/DeckApp.js';
import { DeckScreen } from '../src/web/client/deck/deck-screen.js';
import { PairScreen, pairErrorMessage } from '../src/web/client/deck/pair-screen.js';
import { TOKEN_KEY } from '../src/web/client/deck/token-store.js';
import { QR_LIB, validateMatrix } from '../src/web/client/simple/pairing-qr.js';
import { PairingAddressLink } from '../src/web/client/simple/pairing-address-modal.js';
import { VirtualDeckPanel } from '../src/web/client/simple/virtual-deck-panel.js';
import type { PairingOffer, VirtualDeckState } from '../src/web/contract-deck.js';

type Check = (condition: boolean, message: string) => void;

const WELCOME = {
  t: 'welcome',
  v: 1,
  layout: { profile: 'mk2', columns: 5, rows: 3, keyCount: 15, rotate: 180 },
  brightness: 100,
  paired: true,
  deviceName: 'iPad',
};

// A tiny valid 1x1 JPEG-ish payload is unnecessary: the page only needs bytes for a Blob URL.
const FRAME_KEY_2 = [1, 2, 0, 0, 0xff, 0xd8, 0xff, 0xd9];

function bodyOf(init?: RequestInit): unknown {
  return typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
}

function textOf(root: ParentNode, selector: string): string {
  return root.querySelector(selector)?.textContent ?? '';
}

async function clickSettled(root: ParentNode, selector: string): Promise<void> {
  await act(async () => {
    root.querySelector<HTMLElement>(selector)!.click();
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

const settleAll = (): Promise<void> =>
  act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });

function setup(root: HTMLElement): {
  mount: (props?: { onUnauthorized?: (r: string) => void }) => Promise<FakeDeckSocket>;
  /** Every socket the page opened, oldest first (a reconnect adds one). */
  socks: FakeDeckSocket[];
} {
  const socks: FakeDeckSocket[] = [];
  return {
    socks,
    async mount(props = {}) {
      await act(() =>
        render(
          <DeckScreen
            token="dbp_test"
            onUnauthorized={props.onUnauthorized ?? ((): void => undefined)}
            createSocket={() => {
              const s = new FakeDeckSocket();
              socks.push(s);
              return s;
            }}
            url="ws://test/deck/ws"
          />,
          root,
        ),
      );
      return socks[socks.length - 1]!;
    },
  };
}

function key(root: HTMLElement, k: number): HTMLElement {
  return root.querySelector<HTMLElement>(`[data-key="${k}"]`)!;
}

function pointer(el: Element, type: string, id: number): void {
  el.dispatchEvent(
    new PointerEvent(type, { pointerId: id, bubbles: true, cancelable: true, isPrimary: id === 1 }),
  );
}

function touch(el: Element, type: string, id: number): Event {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'changedTouches', { value: [{ identifier: id, target: el }] });
  el.dispatchEvent(e);
  return e;
}

async function live(root: HTMLElement, sock: FakeDeckSocket): Promise<void> {
  await act(() => {
    sock.open();
    sock.text(WELCOME);
  });
}

async function runDeckScreen(root: HTMLElement, check: Check): Promise<void> {
  const { mount, socks } = setup(root);
  let sock = await mount();
  await live(root, sock);
  check(root.querySelectorAll('.deck-key').length === 15, 'Deck page renders 15 keys for MK.2');

  // images + rotation + brightness
  await act(() => sock.binary(FRAME_KEY_2));
  const img = key(root, 2).querySelector('img');
  check(img !== null && img.src.startsWith('blob:'), 'A binary frame becomes a blob: image');
  check(
    img?.style.transform === 'rotate(180deg)',
    'Key images are rotated 180° like the admin preview',
  );
  check(
    sock.sent.some((m) => m.t === 'ack' && m.n === 1),
    'Each binary frame is acked',
  );
  await act(() => sock.text({ t: 'brightness', level: 40 }));
  const dim = root.querySelector<HTMLElement>('.deck-dim')!;
  check(Math.abs(Number(dim.style.opacity) - 0.6) < 0.001, 'Brightness 40 dims the overlay to 0.6');
  await act(() => sock.text({ t: 'clear', k: 2 }));
  check(key(root, 2).querySelector('img') === null, 'A clear removes the key image');

  // pointer press / release
  await act(() => pointer(key(root, 3), 'pointerdown', 1));
  check(key(root, 3).classList.contains('down'), 'A pressed key shows the down state');
  await act(() => pointer(key(root, 3), 'pointerup', 1));
  check(
    sock.keys().join() === '3:down,3:up',
    'Pointer down/up on key 3 sends exactly down then up',
  );

  // two fingers, two keys
  sock.sent.length = 0;
  await act(() => {
    pointer(key(root, 1), 'pointerdown', 1);
    pointer(key(root, 4), 'pointerdown', 2);
    pointer(key(root, 1), 'pointerup', 1);
    pointer(key(root, 4), 'pointerup', 2);
  });
  check(
    sock.keys().join() === '1:down,4:down,1:up,4:up',
    'Two pointers on keys 1 and 4 are independent presses',
  );

  // two fingers, one key
  sock.sent.length = 0;
  await act(() => {
    pointer(key(root, 2), 'pointerdown', 1);
    pointer(key(root, 2), 'pointerdown', 2);
    pointer(key(root, 2), 'pointerup', 1);
  });
  check(sock.keys().join() === '2:down', 'Two pointers on one key send a single down');
  await act(() => pointer(key(root, 2), 'pointerup', 2));
  check(sock.keys().join() === '2:down,2:up', 'The single up goes out when the last finger lifts');

  // slide off the key: bound to the first key
  sock.sent.length = 0;
  await act(() => {
    pointer(key(root, 0), 'pointerdown', 1);
    key(root, 1).dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, bubbles: true }));
    pointer(key(root, 1), 'pointerup', 1);
  });
  check(sock.keys().join() === '0:down,0:up', 'A press stays on the key it started on');

  // cancel
  sock.sent.length = 0;
  await act(() => {
    pointer(key(root, 5), 'pointerdown', 1);
    pointer(key(root, 5), 'pointercancel', 1);
  });
  check(sock.keys().join() === '5:down,5:up', 'pointercancel releases the key');

  // hidden page: releaseAll and close
  sock.sent.length = 0;
  await act(() => pointer(key(root, 6), 'pointerdown', 1));
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  await act(() => void document.dispatchEvent(new Event('visibilitychange')));
  check(
    sock.sent.some((m) => m.t === 'releaseAll') && sock.closed,
    'Hiding the page sends releaseAll and closes the socket',
  );
  check(!key(root, 6).classList.contains('down'), 'Hiding the page clears the local pressed state');
  delete (document as unknown as Record<string, unknown>).visibilityState;
  await act(() => render(null, root));

  // dropped connection: presses are dropped, never queued, and nothing replays after reconnect
  sock = await mount();
  await live(root, sock);
  await act(() => sock.drop());
  await act(() => pointer(key(root, 7), 'pointerdown', 1));
  await act(() => pointer(key(root, 7), 'pointerup', 1));
  const before = socks.length;
  for (let i = 0; i < 20 && socks.length === before; i++)
    await new Promise((r) => setTimeout(r, 100));
  check(socks.length === before + 1, 'A dropped socket reconnects by itself');
  const second = socks[socks.length - 1]!;
  await live(root, second);
  check(
    sock.keys().length === 0 && second.keys().length === 0,
    'A press while disconnected is dropped and never replayed after reconnect',
  );
  await act(() => render(null, root));

  // bye unauthorized
  let byeReason = '';
  sock = await mount({ onUnauthorized: (r) => (byeReason = r) });
  await live(root, sock);
  await act(() => sock.text({ t: 'bye', reason: 'unauthorized' }));
  check(byeReason === 'unauthorized', 'bye unauthorized is reported to the app');
  await act(() => render(null, root));
}

async function runDeckTouchPath(root: HTMLElement, check: Check): Promise<void> {
  const { mount } = setup(root);
  const original = window.PointerEvent;
  (window as unknown as { PointerEvent: unknown }).PointerEvent = undefined; // iOS 12 has none
  try {
    const sock = await mount();
    await live(root, sock);
    let start: Event | null = null;
    await act(() => {
      start = touch(key(root, 3), 'touchstart', 7);
    });
    await act(() => void touch(key(root, 3), 'touchend', 7));
    check(sock.keys().join() === '3:down,3:up', 'Touch Events path sends the same messages');
    check(start!.defaultPrevented, 'touchstart is non-passive and prevents default');
    await act(() => render(null, root));
  } finally {
    (window as unknown as { PointerEvent: unknown }).PointerEvent = original;
  }
}

function jsonResponse(status: number, payload: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status < 400,
    status,
    headers: { get: (k: string) => headers[k] ?? null },
    json: () => Promise.resolve(payload),
  };
}

async function runPairScreen(root: HTMLElement, check: Check): Promise<void> {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  let reply = jsonResponse(200, { token: 'dbp_new', deviceId: 'd1' });
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    calls.push({ url, body: (bodyOf(init) ?? {}) as Record<string, unknown> });
    return Promise.resolve(reply);
  }) as unknown as typeof fetch;
  try {
    let paired = '';
    await act(() => render(<PairScreen onPaired={(t) => (paired = t)} />, root));
    const submit = root.querySelector<HTMLButtonElement>('#pair-submit')!;
    const code = root.querySelector<HTMLInputElement>('#pair-code')!;
    check(submit.disabled, 'Pair stays disabled with no code');
    await act(() => {
      code.value = '12345';
      code.dispatchEvent(new Event('input', { bubbles: true }));
    });
    check(submit.disabled, 'Pair stays disabled with 5 digits');
    await act(() => {
      code.value = '123456';
      code.dispatchEvent(new Event('input', { bubbles: true }));
    });
    check(!submit.disabled, 'Pair enables with 6 digits');
    reply = jsonResponse(429, { error: 'x', code: 'rate_limited' }, { 'Retry-After': '42' });
    await act(async () => {
      submit.click();
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
    check(textOf(root, '#pair-error').includes('42 s'), 'A 429 shows the retry seconds');
    check(calls[0]?.body.shortCode === '123456', 'The typed code is posted as shortCode');
    reply = jsonResponse(200, { token: 'dbp_new', deviceId: 'd1' });
    await act(async () => {
      submit.click();
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
    check(paired === 'dbp_new', 'A successful pairing hands the token to the app');
    check(
      pairErrorMessage(410, {}, 0).includes('expired') &&
        pairErrorMessage(403, {}, 0).includes('Wrong'),
      'Pair errors name expiry and wrong codes',
    );
    await act(() => render(null, root));

    // QR link: #pair= pairs without typing
    calls.length = 0;
    await act(async () => {
      render(<PairScreen initialCode="ABCDEF" onPaired={(t) => (paired = t)} />, root);
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
    check(calls[0]?.body.code === 'ABCDEF', 'A scanned code is posted as `code` on load');
    await act(() => render(null, root));
  } finally {
    globalThis.fetch = original;
  }
}

async function runDeckAppUnauthorized(root: HTMLElement, check: Check): Promise<void> {
  localStorage.setItem(TOKEN_KEY, 'dbp_stored');
  let sock: FakeDeckSocket | null = null;
  await act(() =>
    render(
      <DeckApp
        createSocket={() => {
          sock = new FakeDeckSocket();
          return sock;
        }}
      />,
      root,
    ),
  );
  check(root.querySelector('#deck-screen') !== null, 'A stored token opens the deck directly');
  await live(root, sock!);
  await act(() => sock!.text({ t: 'bye', reason: 'revoked' }));
  check(root.querySelector('#pair-screen') !== null, 'A revoked token shows the pair screen');
  check(localStorage.getItem(TOKEN_KEY) === null, 'A revoked token is removed from storage');
  await act(() => render(null, root));
}

const MATRIX_SIZE = 21;
function fakeMatrix(): boolean[][] {
  return Array.from({ length: MATRIX_SIZE }, (_row, y) =>
    Array.from({ length: MATRIX_SIZE }, (_cell, x) => (x + y) % 2 === 0),
  );
}

const PANEL_OFFER: PairingOffer = {
  shortCode: '012345',
  qrUrl: 'http://192.168.1.2:44660/deck/#pair=ABC',
  urls: ['http://192.168.1.2:44660/deck/'],
  expiresAt: Date.now() + 120_000,
};

const PANEL_STATE: VirtualDeckState = {
  enabled: true,
  profile: 'mk2',
  listening: true,
  port: 44660,
  bindLoopbackOnly: false,
  urls: ['http://192.168.1.2:44660/deck/'],
  devices: [{ id: 'dev1', name: 'iPad', createdAt: '2026-10-01T10:00:00Z', connected: true }],
  pending: { expiresAt: PANEL_OFFER.expiresAt },
  latencyP95Ms: 42,
  coraPorts: { primary: 5349, child: 5350 },
};

function checkPanelBasics(root: HTMLElement, check: Check): void {
  const hint = textOf(root, '#deck-elgato-hint');
  check(
    hint.includes('5349') && hint.includes('one dock per IP'),
    'The panel names the dock port and the one-dock-per-IP rule',
  );
  check(textOf(root, '#deck-latency').includes('42 ms'), 'The panel shows the input latency p95');
  check(root.querySelectorAll('#deck-devices li').length === 1, 'The panel lists paired devices');
}

async function checkPairingOffer(
  root: HTMLElement,
  check: Check,
  loads: () => number,
): Promise<void> {
  await clickSettled(root, '#deck-pair');
  await settleAll();
  check(
    textOf(root, '#deck-short-code .addr-text') === '012345',
    'The offer shows the 6-digit code with its leading zero',
  );
  check(textOf(root, '#deck-offer').includes('Expires in'), 'The offer shows a countdown');
  check(
    loads() === 0 && root.querySelector('svg.pairing-qr') === null,
    'No QR library load before consent',
  );
  check(root.querySelector('#qr-consent') !== null, 'The consent dialog is shown first');
  check(
    textOf(root, '#qr-consent code') === QR_LIB.url,
    'The consent dialog names the exact CDN URL',
  );
  await clickSettled(root, '#qr-load');
  check(loads() === 1, 'Confirming loads the QR library once');
  check(root.querySelector('svg.pairing-qr path') !== null, 'The QR code renders as an SVG path');
}

async function runVirtualDeckPanel(root: HTMLElement, check: Check): Promise<void> {
  const original = globalThis.fetch;
  let panelState = PANEL_STATE;
  const posts: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push({ url, body: bodyOf(init) });
      if (url === '/api/virtual-deck') {
        panelState = { ...panelState, enabled: (bodyOf(init) as { enabled: boolean }).enabled };
      }
      return Promise.resolve(jsonResponse(200, url.endsWith('/pairing') ? PANEL_OFFER : {}));
    }
    return Promise.resolve(jsonResponse(200, panelState));
  }) as unknown as typeof fetch;
  const confirmOriginal = window.confirm.bind(window);
  window.confirm = () => true;
  let loadCount = 0;
  try {
    await act(() =>
      render(
        <VirtualDeckPanel
          loadQr={() => {
            loadCount++;
            return Promise.resolve(fakeMatrix());
          }}
        />,
        root,
      ),
    );
    await settleAll();
    check(
      textOf(root, '.collapse-status').includes('Enabled'),
      'Browser deck header loads status while collapsed',
    );
    checkPanelBasics(root, check);
    await checkPairingOffer(root, check, () => loadCount);

    await clickSettled(root, '#deck-devices button');
    check(
      posts.some(
        (p) => p.url === '/api/virtual-deck/revoke' && (p.body as { id?: string }).id === 'dev1',
      ),
      'Revoke posts the device id',
    );
    check(
      validateMatrix(fakeMatrix()) !== null &&
        validateMatrix([[true]]) === null &&
        validateMatrix(fakeMatrix().slice(1)) === null &&
        validateMatrix(fakeMatrix().map((r) => r.map((c) => (c ? 1 : 0)))) === null,
      'The QR matrix validator accepts squares of booleans and rejects the rest',
    );
    await clickSettled(root, '#toggle-virtual-deck');
    check(
      textOf(root, '.collapse-status').includes('Disabled'),
      'Browser deck header refreshes after disabling',
    );
    await act(() => render(null, root));
  } finally {
    globalThis.fetch = original;
    window.confirm = confirmOriginal;
  }
}

async function runPairingAddressModal(root: HTMLElement, check: Check): Promise<void> {
  const original = globalThis.fetch;
  const posts: string[] = [];
  let testOk = false;
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push((bodyOf(init) as { ip: string }).ip);
      return Promise.resolve(
        jsonResponse(
          200,
          testOk
            ? { ok: true, stage: 'listen' }
            : { ok: false, stage: 'address', error: 'no such address' },
        ),
      );
    }
    return Promise.resolve(
      jsonResponse(200, {
        platform: 'macos',
        suggested: '127.0.0.2',
        candidates: [
          { ip: '127.0.0.2', kind: 'loopback' },
          { ip: '127.0.0.3', kind: 'loopback' },
          { ip: '192.168.1.5', kind: 'lan' },
        ],
        docks: [
          { index: 0, name: 'Stream Deck MK.2', primaryPort: 5343, running: true },
          { index: 3, name: 'Browser deck', primaryPort: 5349, running: true },
        ],
        bindAddress: '0.0.0.0',
      }),
    );
  }) as unknown as typeof fetch;
  try {
    await act(() => render(<PairingAddressLink initialDock={3} />, root));
    check(root.querySelector('#address-modal') === null, 'The address modal is closed until asked');
    await act(async () => {
      root.querySelector<HTMLButtonElement>('.address-link')!.click();
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
    await settleAll();
    check(
      textOf(root, '#address-modal').includes('sudo ifconfig lo0 alias 127.0.0.2 up'),
      'The macOS tab shows the alias command for the suggested address',
    );
    check(
      textOf(root, '#address-elgato').includes('127.0.0.2:5349'),
      "Step 3 names the chosen dock's port with the address",
    );
    await act(async () => {
      root.querySelector<HTMLButtonElement>('#address-test')!.click();
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
    check(
      posts[0] === '127.0.0.2' && textOf(root, '#address-test-result').includes('no such address'),
      'A failed test posts the address and shows the error text',
    );
    testOk = true;
    await act(async () => {
      root.querySelector<HTMLButtonElement>('#address-test')!.click();
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
    check(
      textOf(root, '#address-test-result').includes('127.0.0.2 works'),
      'A passing test says the address works',
    );
    const pick = root.querySelector<HTMLSelectElement>('#address-pick')!;
    await act(() => {
      pick.value = '192.168.1.5';
      pick.dispatchEvent(new Event('change', { bubbles: true }));
    });
    check(!textOf(root, '#address-modal').includes('sudo'), 'A LAN address needs no command');
    check(
      root.querySelector('#address-test-result') === null,
      'Changing the address clears the test result',
    );
    await act(() => root.querySelector<HTMLButtonElement>('#address-close')!.click());
    check(root.querySelector('#address-modal') === null, 'Close dismisses the modal');
    await act(() => render(null, root));
  } finally {
    globalThis.fetch = original;
  }
}

const KEY_DOCK: DockStatus = {
  index: 0,
  ...DOCK_IDENTITY,
  modelId: 'mirabox-293s',
  modelName: 'Mirabox 293S',
  keyCount: 15,
  columns: 5,
  rows: 3,
  primaryPort: 5343,
  primaryConnected: true,
  elgatoConnected: true,
  brightness: 100,
};

async function runClickToPress(root: HTMLElement, check: Check): Promise<void> {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; body: unknown }> = [];
  let keyStatus = 204;
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    calls.push({ url, body: bodyOf(init) });
    if (url.startsWith('/api/key/')) {
      return Promise.resolve(
        keyStatus === 403
          ? jsonResponse(403, { error: 'key press from the web UI is disabled' })
          : jsonResponse(204, {}),
      );
    }
    return Promise.resolve(jsonResponse(200, {}));
  }) as unknown as typeof fetch;
  const toast = document.createElement('div');
  toast.id = 'toast';
  document.body.appendChild(toast);
  const keyPosts = (): string[] =>
    calls.filter((c) => c.url.startsWith('/api/key/')).map((c) => c.url);
  const cells = (): HTMLElement[] => [...root.querySelectorAll<HTMLElement>('button.key-cell')];
  const mountCards = async (enabled: boolean, paired: boolean): Promise<void> => {
    await act(() =>
      patch({
        status: {
          ...EMPTY_STATUS,
          docks: [{ ...KEY_DOCK, elgatoConnected: paired }],
          selectedDock: 0,
        },
        keyPressEnabled: enabled,
      }),
    );
    await act(() =>
      render(
        <DockList docks={[{ ...KEY_DOCK, elgatoConnected: paired }]} onHelp={() => undefined} />,
        root,
      ),
    );
    await settleAll();
  };
  try {
    // Settings toggle
    await act(() => render(<KeyPressPanel enabled={false} />, root));
    const toggle = root.querySelector<HTMLInputElement>('#toggle-key-press')!;
    check(!toggle.checked, 'The Click to press toggle starts off');
    check(
      textOf(root, '.collapse-status').includes('Disabled'),
      'Click to press header starts disabled',
    );
    check(
      root.textContent.includes('Double-click a key in the preview'),
      'The toggle explains the double-click gesture and the exposure',
    );
    await act(async () => {
      toggle.click();
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
    const posted = calls.find((c) => c.url === '/api/webui-key-press');
    check(
      textOf(root, '.collapse-status').includes('Enabled'),
      'Click to press header updates after saving',
    );
    check(
      (posted?.body as { enabled?: boolean } | undefined)?.enabled === true,
      'Turning Click to press on posts {enabled: true}',
    );
    await act(() => render(null, root));

    // inert while off, or while the dock is not paired
    await mountCards(false, true);
    check(
      cells().length === 15 && !cells().some((c) => c.classList.contains('clickable')),
      'Keys are not clickable while Click to press is off',
    );
    await act(() => render(null, root));
    await mountCards(true, false);
    check(
      !cells().some((c) => c.classList.contains('clickable')) &&
        (cells()[0]?.title ?? '').includes('Pair with the Elgato app'),
      'Keys are not clickable on an unpaired dock and say why',
    );
    await act(() => render(null, root));

    // enabled + paired
    await mountCards(true, true);
    check(
      cells().every((c) => c.classList.contains('clickable')),
      'Keys are clickable when enabled and paired',
    );
    check(
      cells()[0]?.title === 'Double-click to press this key',
      'Clickable keys carry the double-click tooltip',
    );
    await act(() => cells()[3]!.click());
    check(keyPosts().length === 0, 'A single click does not press a key');
    await act(async () => {
      cells()[3]!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
    check(keyPosts().join() === '/api/key/3', 'A double-click posts /api/key/<n>');

    calls.length = 0;
    await act(async () => {
      cells()[5]!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
      cells()[5]!.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          repeat: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
    check(keyPosts().join() === '/api/key/5', 'Enter on a focused key fires exactly once');
    check(
      !calls.some((c) => c.url === '/api/select-dock'),
      'Enter on a key does not also select the dock card',
    );

    // a 403 shows the server's own text
    keyStatus = 403;
    await act(async () => {
      cells()[1]!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
    check(
      toast.textContent === 'key press from the web UI is disabled',
      'A 403 shows the server error text as a toast',
    );
    await act(() => render(null, root));
  } finally {
    globalThis.fetch = original;
    toast.remove();
    patch({ keyPressEnabled: false });
  }
}

export async function runDeckPage(root: HTMLElement, check: Check): Promise<void> {
  await runDeckScreen(root, check);
  await runDeckTouchPath(root, check);
  await runPairScreen(root, check);
  await runDeckAppUnauthorized(root, check);
  await runVirtualDeckPanel(root, check);
  await runPairingAddressModal(root, check);
  await runClickToPress(root, check);
}
