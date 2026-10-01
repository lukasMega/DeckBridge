// The key grid: absolutely positioned square keys, one <img> per key, and the pointer/touch
// input binding. A press stays bound to the key it started on (like a physical key).
import { useEffect, useRef } from 'preact/hooks';
import type { DeckLayout } from '../../contract-deck.js';
import { keyOrigin, type DeckGeometry } from './layout.js';
import { PressTracker, type KeyTransition } from './press-tracker.js';

export interface KeyImages {
  [key: number]: string | undefined;
}

function KeyImage({ url, rotate }: Readonly<{ url: string; rotate: 0 | 180 }>): preact.JSX.Element {
  const currentRef = useRef<string | null>(null);
  const staleRef = useRef<string[]>([]);
  if (currentRef.current !== url) {
    if (currentRef.current !== null) staleRef.current.push(currentRef.current);
    currentRef.current = url;
  }
  // Revoke old blobs only once the new image has settled, so a key never flashes empty.
  function revokeStale(): void {
    for (const old of staleRef.current) URL.revokeObjectURL(old);
    staleRef.current = [];
  }
  useEffect(function revokeOnUnmount() {
    return function cleanup(): void {
      revokeStale();
      if (currentRef.current !== null) URL.revokeObjectURL(currentRef.current);
    };
  }, []);
  return (
    <img
      style={rotate === 180 ? { transform: 'rotate(180deg)' } : undefined}
      src={url}
      alt=""
      draggable={false}
      onLoad={revokeStale}
      onError={revokeStale}
    />
  );
}

function keyFromTarget(target: EventTarget | null, keyCount: number): number | null {
  const el = target instanceof Element ? target.closest('[data-key]') : null;
  if (!el) return null;
  const n = Number(el.getAttribute('data-key'));
  return Number.isInteger(n) && n >= 0 && n < keyCount ? n : null;
}

type Binding = [string, EventListener, AddEventListenerOptions | undefined];
type Latest = { current: { keyCount: number; onTransition: (t: KeyTransition) => void } };

const NON_PASSIVE: AddEventListenerOptions = { passive: false };

function stop(e: Event): void {
  if (e.cancelable) e.preventDefault();
}

/** Pointer Events when the browser has them, else Touch Events (iOS 12 has no Pointer Events). */
function inputBindings(tracker: PressTracker, latestRef: Latest): Binding[] {
  const emit = (ts: KeyTransition[]): void => {
    for (const t of ts) latestRef.current.onTransition(t);
  };
  const onPointerDown = (e: PointerEvent): void => {
    const key = keyFromTarget(e.target, latestRef.current.keyCount);
    if (key === null) return;
    stop(e);
    try {
      (e.target as Element).setPointerCapture(e.pointerId);
    } catch {
      // capture is best-effort; pointerup still arrives on the grid
    }
    emit(tracker.down(e.pointerId, key));
  };
  const onPointerEnd = (e: PointerEvent): void => emit(tracker.up(e.pointerId));
  const onTouchStart = (e: TouchEvent): void => {
    stop(e); // iOS 12 ignores touch-action: none, so scrolling/zoom is stopped here
    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i]!;
      const key = keyFromTarget(t.target, latestRef.current.keyCount);
      if (key !== null) emit(tracker.down(t.identifier, key));
    }
  };
  const onTouchEnd = (e: TouchEvent): void => {
    stop(e);
    for (let i = 0; i < e.changedTouches.length; i++) {
      emit(tracker.up(e.changedTouches[i]!.identifier));
    }
  };
  const input: Binding[] =
    typeof window.PointerEvent === 'function'
      ? [
          ['pointerdown', onPointerDown as EventListener, NON_PASSIVE],
          ['pointerup', onPointerEnd as EventListener, undefined],
          ['pointercancel', onPointerEnd as EventListener, undefined],
        ]
      : [
          ['touchstart', onTouchStart as EventListener, NON_PASSIVE],
          ['touchend', onTouchEnd as EventListener, NON_PASSIVE],
          ['touchcancel', onTouchEnd as EventListener, NON_PASSIVE],
        ];
  return [
    ...input,
    ['touchmove', stop, NON_PASSIVE],
    ['gesturestart', stop, NON_PASSIVE],
    ['contextmenu', stop, undefined],
  ];
}

export function DeckGrid({
  layout,
  geometry,
  images,
  live,
  down,
  tracker,
  onTransition,
}: Readonly<{
  layout: DeckLayout;
  geometry: DeckGeometry;
  images: KeyImages;
  live: boolean;
  down: ReadonlySet<number>;
  tracker: PressTracker;
  /** Called for every merged key transition (the socket send + the local highlight). */
  onTransition: (t: KeyTransition) => void;
}>): preact.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  // Latest props for listeners bound once: re-binding per render would drop a live touch.
  const latestRef = useRef({ keyCount: layout.keyCount, onTransition });
  latestRef.current = { keyCount: layout.keyCount, onTransition };

  useEffect(
    function bindInput() {
      const grid = ref.current;
      if (!grid) return undefined;
      const bindings = inputBindings(tracker, latestRef);
      for (const [type, fn, opts] of bindings) grid.addEventListener(type, fn, opts);
      return function unbind(): void {
        for (const [type, fn, opts] of bindings) grid.removeEventListener(type, fn, opts);
      };
    },
    [tracker],
  );

  const cells: preact.JSX.Element[] = [];
  for (let k = 0; k < layout.keyCount; k++) {
    const { x, y } = keyOrigin(geometry, layout.columns, k);
    const url = images[k];
    cells.push(
      <div
        key={k}
        class={down.has(k) ? 'deck-key down' : 'deck-key'}
        data-key={k}
        data-testid={`key-${k}`}
        style={{
          left: `${x}px`,
          top: `${y}px`,
          width: `${geometry.size}px`,
          height: `${geometry.size}px`,
        }}
      >
        {url !== undefined && <KeyImage url={url} rotate={layout.rotate} />}
      </div>,
    );
  }
  return (
    <div ref={ref} class={live ? 'deck-grid' : 'deck-grid deck-grid--idle'}>
      {cells}
    </div>
  );
}
