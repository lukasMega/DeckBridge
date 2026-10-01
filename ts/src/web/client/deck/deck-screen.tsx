// The deck itself: status, brightness overlay, hints and the key grid, driven by one DeckSocket.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { DeckByeReason, DeckLayout } from '../../contract-deck.js';
import { DeckGrid, type KeyImages } from './deck-grid.js';
import { DeckSocket, randomClientId, type ConnState, type SocketLike } from './deck-socket.js';
import { computeDeckLayout, type Insets } from './layout.js';
import { PressTracker, type KeyTransition } from './press-tracker.js';
import {
  fullscreenSupported,
  isStandalone,
  requestFullscreen,
  requestWakeLock,
  wakeLockSupported,
} from './wake.js';

const WAKE_HINT_KEY = 'deckbridge.deck.hint.wake';

const BYE_NOTICE: Partial<Record<DeckByeReason, string>> = {
  disabled: 'The browser deck is turned off in DeckBridge. Waiting for it to come back…',
  full: 'Too many devices are connected to this deck. Retrying…',
  upgrade: 'This page is out of date. Reload it.',
};

export function deckSocketUrl(loc: Pick<Location, 'protocol' | 'host'> = location): string {
  return `${loc.protocol === 'https:' ? 'wss:' : 'ws:'}//${loc.host}/deck/ws`;
}

const px = (v: string): number => parseFloat(v) || 0;

function readInsets(): Insets {
  // env() only resolves in CSS, so a probe's computed padding is the portable way to read it.
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:fixed;visibility:hidden;pointer-events:none;padding:' +
    'env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const insets = {
    top: px(cs.paddingTop),
    right: px(cs.paddingRight),
    bottom: px(cs.paddingBottom),
    left: px(cs.paddingLeft),
  };
  document.body.removeChild(probe);
  return insets;
}

function dotState(conn: ConnState): 'ok' | 'bad' | 'wait' {
  if (conn === 'live') return 'ok';
  return conn === 'stopped' ? 'bad' : 'wait';
}

function useViewport(): { w: number; h: number; insets: Insets } {
  const [vp, setVp] = useState(() => ({
    w: window.innerWidth,
    h: window.innerHeight,
    insets: readInsets(),
  }));
  useEffect(function trackViewport() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = (): void =>
      setVp({ w: window.innerWidth, h: window.innerHeight, insets: readInsets() });
    // iOS reports the new size a beat after `orientationchange`.
    const onOrientation = (): void => {
      clearTimeout(timer);
      timer = setTimeout(update, 300);
    };
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', onOrientation);
    return function unbind(): void {
      clearTimeout(timer);
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', onOrientation);
    };
  }, []);
  return vp;
}

function useWakeLock(): void {
  useEffect(function holdWakeLock() {
    let release: (() => void) | null = null;
    let cancelled = false;
    const acquire = (): void => {
      void requestWakeLock().then((r) => {
        if (cancelled) r?.();
        else release = r;
        return undefined;
      });
    };
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') acquire();
    };
    if (wakeLockSupported()) {
      acquire();
      document.addEventListener('visibilitychange', onVisible);
    }
    return function cleanup(): void {
      cancelled = true;
      release?.();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
}

function readFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeFlag(key: string): void {
  try {
    window.localStorage.setItem(key, '1');
  } catch {
    // hint just shows again next time
  }
}

/** Visibility/focus/network handling; returns the unbind function. */
function bindPageLifecycle(sock: DeckSocket, onSuspend: () => void): () => void {
  const suspend = (): void => {
    onSuspend();
    sock.suspend();
  };
  const resume = (): void => sock.resume();
  const onVisibility = (): void => (document.visibilityState === 'hidden' ? suspend() : resume());
  const onOnline = (): void => sock.retryNow();
  const bindings: Array<[EventTarget, string, () => void]> = [
    [document, 'visibilitychange', onVisibility],
    [window, 'pagehide', suspend],
    [window, 'blur', suspend],
    [window, 'pageshow', resume],
    [window, 'focus', resume],
    [window, 'online', onOnline],
  ];
  for (const [target, type, fn] of bindings) target.addEventListener(type, fn);
  return function unbind(): void {
    for (const [target, type, fn] of bindings) target.removeEventListener(type, fn);
  };
}

/** `?debug=1` overlay text, refreshed once a second. */
function startStats(
  sock: DeckSocket,
  setStats: (text: string) => void,
): ReturnType<typeof setInterval> {
  return setInterval(() => {
    const r = sock.rtt();
    setStats(
      r
        ? `RTT p50 ${r.p50.toFixed(0)} ms · p95 ${r.p95.toFixed(0)} ms · frames ${sock.inFlightFrames}`
        : 'RTT –',
    );
  }, 1000);
}

function DeckOverlay({
  live,
  paired,
  notice,
  portrait,
  showWakeHint,
  onDismissWakeHint,
  stats,
}: Readonly<{
  live: boolean;
  paired: boolean;
  notice: string | null;
  portrait: boolean;
  showWakeHint: boolean;
  onDismissWakeHint: () => void;
  /** null = no debug overlay. */
  stats: string | null;
}>): preact.JSX.Element {
  return (
    <div class="deck-overlay">
      {live && !paired && (
        <p class="deck-banner">
          Not paired with the Elgato app yet — add this dock in the Elgato app.
        </p>
      )}
      {notice && <p class="deck-banner">{notice}</p>}
      {portrait && <p class="deck-hint">Rotate for bigger keys</p>}
      {showWakeHint && (
        <p class="deck-hint">
          Set Auto-Lock / Screen timeout to Never on this device.{' '}
          <button class="deck-link" type="button" onClick={onDismissWakeHint}>
            Dismiss
          </button>
        </p>
      )}
      {fullscreenSupported() && (
        <button class="deck-link" type="button" onClick={requestFullscreen}>
          Full screen
        </button>
      )}
      {stats !== null && <p class="deck-debug">{stats}</p>}
    </div>
  );
}

export function DeckScreen({
  token,
  name,
  onUnauthorized,
  createSocket = (url: string): SocketLike => new WebSocket(url),
  url = deckSocketUrl(),
}: Readonly<{
  token: string;
  name?: string;
  onUnauthorized: (reason: DeckByeReason) => void;
  /** Test seam: the app uses the browser WebSocket. */
  createSocket?: (url: string) => SocketLike;
  url?: string;
}>): preact.JSX.Element {
  const [conn, setConn] = useState<ConnState>('connecting');
  const [layout, setLayout] = useState<DeckLayout | null>(null);
  const [images, setImages] = useState<KeyImages>({});
  const [brightness, setBrightness] = useState(100);
  const [paired, setPaired] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [down, setDown] = useState<ReadonlySet<number>>(() => new Set());
  const [wakeHintDismissed, setWakeHintDismissed] = useState(() => readFlag(WAKE_HINT_KEY));
  const [stats, setStats] = useState('');
  const tracker = useMemo(() => new PressTracker(), []);
  const socketRef = useRef<DeckSocket | null>(null);
  const vp = useViewport();
  const debug = /[?&]debug=1\b/.test(location.search);
  useWakeLock();

  function applyTransition(t: KeyTransition): void {
    setDown((prev) => {
      const next = new Set(prev);
      if (t.state === 'down') next.add(t.key);
      else next.delete(t.key);
      return next;
    });
  }

  function onTransition(t: KeyTransition): void {
    applyTransition(t);
    socketRef.current?.sendKey(t.key, t.state);
  }

  useEffect(
    function runSocket() {
      const clientId = randomClientId();
      const sock = new DeckSocket({
        url,
        token,
        clientId,
        name,
        createSocket,
        onState: setConn,
        // A reconnect must never replay a press: clear every local hold before hello.
        onReset: () => {
          tracker.releaseAll();
          setDown(new Set());
        },
        onWelcome: (w) => {
          setLayout(w.layout);
          setBrightness(w.brightness);
          setPaired(w.paired);
          setNotice(null);
        },
        onFrame: (f) => {
          const blob = new Blob([f.bytes], {
            type: f.format === 'jpeg' ? 'image/jpeg' : 'image/bmp',
          });
          const urlForKey = URL.createObjectURL(blob);
          setImages((prev) => ({ ...prev, [f.key]: urlForKey }));
        },
        onClear: (k) => setImages((prev) => ({ ...prev, [k]: undefined })),
        onBrightness: setBrightness,
        onPaired: setPaired,
        onBye: (reason) => {
          if (reason === 'unauthorized' || reason === 'revoked') onUnauthorized(reason);
          else setNotice(BYE_NOTICE[reason] ?? null);
        },
      });
      socketRef.current = sock;
      sock.connect();
      // Hidden/blurred pages release server-side first; a sleeping phone may never get to.
      const unbindLifecycle = bindPageLifecycle(sock, () => {
        tracker.releaseAll();
        setDown(new Set());
      });
      const statsTimer = debug ? startStats(sock, setStats) : undefined;
      return function cleanup(): void {
        clearInterval(statsTimer);
        unbindLifecycle();
        sock.stop();
        socketRef.current = null;
      };
    },
    // The socket lives as long as the credential; callbacks are read through refs/setters.
    // eslint-disable-next-line @eslint-react/exhaustive-deps
    [token, url],
  );

  const live = conn === 'live';
  const geometry = layout
    ? computeDeckLayout(vp.w, vp.h, layout.columns, layout.rows, vp.insets)
    : null;
  const portrait = vp.h > vp.w;
  const showWakeHint = !wakeLockSupported() && !isStandalone() && !wakeHintDismissed;

  function dismissWakeHint(): void {
    writeFlag(WAKE_HINT_KEY);
    setWakeHintDismissed(true);
  }

  return (
    <div class="deck-root" id="deck-screen">
      <div class={`deck-dot deck-dot--${dotState(conn)}`} />
      {geometry && layout && (
        <DeckGrid
          layout={layout}
          geometry={geometry}
          images={images}
          live={live}
          down={down}
          tracker={tracker}
          onTransition={onTransition}
        />
      )}
      {!layout && <p class="deck-msg">{conn === 'stopped' ? 'Disconnected' : 'Connecting…'}</p>}
      <div class="deck-dim" style={{ opacity: String(1 - brightness / 100) }} />
      <DeckOverlay
        live={live}
        paired={paired}
        notice={notice}
        portrait={portrait && layout !== null}
        showWakeHint={showWakeHint}
        onDismissWakeHint={dismissWakeHint}
        stats={debug ? stats : null}
      />
    </div>
  );
}
