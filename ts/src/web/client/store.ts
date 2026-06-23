import { useState, useEffect } from 'preact/hooks';
import type {
  Status,
  Stats,
  MockConfig,
  KeyEvent,
  ServerLog,
  CommLog,
  DeviceModel,
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

// --- Hook ---
// Hand-rolled useSyncExternalStore equivalent using useState + useEffect.
// Avoids preact/compat (which adds bytes) while being correct.
export function useStore<T>(selector: (s: StoreState) => T): T {
  const [value, setValue] = useState<T>(() => selector(getSnapshot()));

  useEffect(() => {
    // Re-read on mount (state may have changed between render and effect).
    // The sync setValue call is intentional — same as useSyncExternalStore's getSnapshot.
    // eslint-disable-next-line @eslint-react/set-state-in-effect -- intentional: mirrors useSyncExternalStore mount read
    setValue(selector(getSnapshot()));
    return subscribe(() => {
      setValue(selector(getSnapshot()));
    });
    // eslint-disable-next-line @eslint-react/exhaustive-deps -- selector omitted intentionally: it's a pure projection; re-subscribing on every inline-selector render would cause churn
  }, []);

  return value;
}
