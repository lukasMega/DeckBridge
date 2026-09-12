import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type {
  Status,
  Stats,
  MockConfig,
  KeyEvent,
  ServerLog,
  CommLog,
  DeviceModel,
  DeviceIdentity,
  ExtraKeyCfg,
} from './ui-types.js';

// Cap constants matching ui-logs.ts / ui-logs.ts KE_MAX
const LOG_MAX = 2000;
const KE_MAX = 50;

export interface ImageEntry {
  v: number;
  data?: string;
  format?: string;
}

export interface StoreState {
  status: Status;
  stats: Stats;
  mockConfig?: MockConfig;
  brightness: number;
  brightnessOverride: boolean;
  images: Record<number, ImageEntry>;
  serverLogs: ServerLog[];
  commLogs: CommLog[];
  keyEvents: KeyEvent[];
  resizeEnabled: boolean;
  imageMode: string | null;
  deviceModels: DeviceModel[];
  deviceIdentity?: DeviceIdentity;
  /** SELECTED dock's extra-key assignments, keyed by device wire id. */
  extraKeys: Record<string, ExtraKeyCfg>;
}

let state: StoreState = {
  status: { driverMode: 'real', driverConnected: false, elgatoConnected: false },
  stats: { uptimeMs: 0, elgatoRxPkts: 0, elgatoTxPkts: 0, imagesSent: 0 },
  mockConfig: undefined,
  brightness: 82,
  brightnessOverride: true,
  images: {},
  serverLogs: [],
  commLogs: [],
  keyEvents: [],
  resizeEnabled: true,
  imageMode: null,
  deviceModels: [],
  deviceIdentity: undefined,
  extraKeys: {},
};

const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of listeners) fn();
}

export function getSnapshot(): StoreState {
  return state;
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

// --- Mutators ---

export function setStatus(status: Status): void {
  state = { ...state, status };
  notify();
}

export function setStats(stats: Stats): void {
  state = { ...state, stats };
  notify();
}

export function setMockConfig(mockConfig: MockConfig): void {
  state = { ...state, mockConfig };
  notify();
}

export function setImage(idx: number, img: ImageEntry): void {
  state = { ...state, images: { ...state.images, [idx]: img } };
  notify();
}

export function clearImage(idx: number): void {
  const images = { ...state.images };
  delete images[idx];
  state = { ...state, images };
  notify();
}

export function setBrightness(brightness: number): void {
  state = { ...state, brightness };
  notify();
}

export function setBrightnessOverride(brightnessOverride: boolean): void {
  state = { ...state, brightnessOverride };
  notify();
}

export function setResizeEnabled(resizeEnabled: boolean): void {
  state = { ...state, resizeEnabled };
  notify();
}

export function setImageMode(imageMode: string | null): void {
  state = { ...state, imageMode };
  notify();
}

export function addServerLog(entry: ServerLog): void {
  const serverLogs =
    state.serverLogs.length >= LOG_MAX
      ? [...state.serverLogs.slice(1), entry]
      : [...state.serverLogs, entry];
  state = { ...state, serverLogs };
  notify();
}

export function addCommLog(entry: CommLog): void {
  const commLogs =
    state.commLogs.length >= LOG_MAX
      ? [...state.commLogs.slice(1), entry]
      : [...state.commLogs, entry];
  state = { ...state, commLogs };
  notify();
}

export function addKeyEvent(entry: KeyEvent): void {
  const keyEvents = [entry, ...state.keyEvents].slice(0, KE_MAX);
  state = { ...state, keyEvents };
  notify();
}

export function patch(partial: Partial<StoreState>): void {
  state = { ...state, ...partial };
  notify();
}

// --- useSyncExternalStore ---
//
// Local port of Preact's compat implementation, which is itself a trim of React's
// useSyncExternalStoreShimClient. Kept local because importing the hook from
// preact/compat drags the whole compat layer into the browser bundle — measured at
// +5,556 bytes minified (74,080 -> 79,636, ~8%) for these ~25 lines.
//
// UPSTREAM: preact/compat/src/hooks.js (ported from preact 10.29.8). On a Preact
// upgrade, diff that file against this block — carrying a local copy of someone
// else's hook means fixes upstream do not reach us automatically.
//
// Do not "simplify" the two effects. The double-check in each is what closes the
// mount race (a store write landing between render and subscribe), and re-running
// the layout effect whenever `getSnapshot` changes identity is what keeps an inline
// selector's subscription reading the *latest* selector rather than the mount-time one.

interface StoreInstance<T> {
  value: T;
  getSnapshot: () => T;
}

function snapshotChanged<T>(inst: StoreInstance<T>): boolean {
  try {
    return !Object.is(inst.value, inst.getSnapshot());
  } catch {
    return true;
  }
}

// Params are suffixed `Fn` only to avoid shadowing this module's own `subscribe` /
// `getSnapshot` exports (eslint no-shadow); upstream names them without the suffix.
function useSyncExternalStore<T>(
  subscribeFn: (onChange: () => void) => () => void,
  getSnapshotFn: () => T,
): T {
  const value = getSnapshotFn();
  const [tracked, setTracked] = useState<{ inst: StoreInstance<T> }>(() => ({
    inst: { value, getSnapshot: getSnapshotFn },
  }));
  const { inst } = tracked;

  useLayoutEffect(() => {
    inst.value = value;
    inst.getSnapshot = getSnapshotFn;
    // eslint-disable-next-line @eslint-react/set-state-in-effect -- load-bearing: the store may have changed between render and commit; upstream does the same synchronous re-check
    if (snapshotChanged(inst)) setTracked({ inst });
  }, [inst, subscribeFn, value, getSnapshotFn]);

  useEffect(() => {
    // eslint-disable-next-line @eslint-react/set-state-in-effect -- load-bearing: catches a store write landing between commit and subscribe, which would otherwise be lost
    if (snapshotChanged(inst)) setTracked({ inst });
    return subscribeFn(() => {
      if (snapshotChanged(inst)) setTracked({ inst });
    });
  }, [inst, subscribeFn]);

  return value;
}

/** Shallow (one-level) structural equality, `Object.is` on each own key. */
function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const av = a as Record<string, unknown>;
  const bv = b as Record<string, unknown>;
  const keys = Object.keys(av);
  if (keys.length !== Object.keys(bv).length) return false;
  return keys.every((k) => Object.hasOwn(bv, k) && Object.is(av[k], bv[k]));
}

// Select during rendering, against the local useSyncExternalStore above.
//
// useSyncExternalStore compares consecutive getSnapshot() results with Object.is and
// re-renders until two agree, so a selector that builds a *fresh* object or array per
// call (`(s) => ({ a: s.x })`, `(s) => s.list.filter(…)`) would loop forever
// ("getSnapshot should be cached"). Memoize on shallow equality to hand such selectors
// back a stable reference; selectors returning primitives or stored refs are unaffected.
export function useStore<T>(selector: (s: StoreState) => T): T {
  const cacheRef = useRef<{ value: T } | undefined>(undefined);
  return useSyncExternalStore(subscribe, (): T => {
    const next = selector(getSnapshot());
    const prev = cacheRef.current;
    if (prev && shallowEqual(prev.value, next)) return prev.value;
    cacheRef.current = { value: next };
    return next;
  });
}
