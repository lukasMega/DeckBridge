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
  EncoderSettings,
  ExtraKeyCfg,
  TouchStripMode,
  UpdateInfo,
} from './ui-types.js';

// Cap constants matching ui-logs.ts / ui-logs.ts KE_MAX
const LOG_MAX = 2000;
const KE_MAX = 50;

export interface StoreState {
  status: Status;
  stats: Stats;
  mockConfig?: MockConfig;
  brightness: number;
  brightnessOverride: boolean;
  serverLogs: ServerLog[];
  commLogs: CommLog[];
  keyEvents: KeyEvent[];
  resizeEnabled: boolean;
  imageMode: string | null;
  deviceModels: DeviceModel[];
  deviceIdentity?: DeviceIdentity;
  /** SELECTED dock's extra-key assignments, keyed by device wire id. */
  extraKeys: Record<string, ExtraKeyCfg>;
  /** SELECTED dock's touch-strip mode + knob override (AKP05E). */
  touchStripMode: TouchStripMode;
  encoders: EncoderSettings;
  updateInfo?: UpdateInfo;
}

let state: StoreState = {
  status: { driverMode: 'real', driverConnected: false, elgatoConnected: false },
  stats: { uptimeMs: 0, elgatoRxPkts: 0, elgatoTxPkts: 0, imagesSent: 0 },
  mockConfig: undefined,
  brightness: 82,
  brightnessOverride: true,
  serverLogs: [],
  commLogs: [],
  keyEvents: [],
  resizeEnabled: true,
  imageMode: null,
  deviceModels: [],
  deviceIdentity: undefined,
  extraKeys: {},
  touchStripMode: 'elgato',
  encoders: {},
  updateInfo: undefined,
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

// Mutators

function setField<K extends keyof StoreState>(key: K, value: StoreState[K]): void {
  state = { ...state, [key]: value };
  notify();
}

export function setStatus(status: Status): void {
  setField('status', status);
}

export function setStats(stats: Stats): void {
  setField('stats', stats);
}

export function setMockConfig(mockConfig: MockConfig): void {
  setField('mockConfig', mockConfig);
}

export function setBrightness(brightness: number): void {
  setField('brightness', brightness);
}

export function setBrightnessOverride(brightnessOverride: boolean): void {
  setField('brightnessOverride', brightnessOverride);
}

export function setTouchStripMode(touchStripMode: TouchStripMode): void {
  setField('touchStripMode', touchStripMode);
}

export function setEncoders(encoders: EncoderSettings): void {
  setField('encoders', encoders);
}

export function setResizeEnabled(resizeEnabled: boolean): void {
  setField('resizeEnabled', resizeEnabled);
}

export function setImageMode(imageMode: string | null): void {
  setField('imageMode', imageMode);
}

export function addServerLog(entry: ServerLog): void {
  const serverLogs =
    state.serverLogs.length >= LOG_MAX
      ? [...state.serverLogs.slice(1), entry]
      : [...state.serverLogs, entry];
  setField('serverLogs', serverLogs);
}

export function addCommLog(entry: CommLog): void {
  const commLogs =
    state.commLogs.length >= LOG_MAX
      ? [...state.commLogs.slice(1), entry]
      : [...state.commLogs, entry];
  setField('commLogs', commLogs);
}

export function addKeyEvent(entry: KeyEvent): void {
  const keyEvents = [entry, ...state.keyEvents].slice(0, KE_MAX);
  setField('keyEvents', keyEvents);
}

export function patch(partial: Partial<StoreState>): void {
  state = { ...state, ...partial };
  notify();
}

// Local port of useSyncExternalStore (UPSTREAM: preact/compat/src/hooks.js, preact
// 10.29.8 — re-diff on upgrade); importing it drags in all of compat, +5,556 bytes
// minified. Do not "simplify" the two effects: the double-check closes the mount race,
// and re-running the layout effect on a new `getSnapshot` identity is what keeps an
// inline selector reading the latest selector, not the mount-time one.

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

// Select during rendering, against the local useSyncExternalStore above. It compares
// consecutive getSnapshot() results with Object.is and re-renders until two agree, so a
// selector building a *fresh* object per call (`(s) => ({ a: s.x })`) would loop forever
// ("getSnapshot should be cached"). Memoizing on shallow equality hands those a stable
// reference; selectors returning primitives or stored refs are unaffected.
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
