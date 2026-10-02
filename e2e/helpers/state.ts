import { expect, type APIRequestContext } from '@playwright/test';
import { api, waitForState, type AppState } from './api.js';

/** The part of GET /api/settings the specs read or restore (ts/src/infra/settings-store.ts). */
export interface DeviceEntry {
  deviceKey: string;
  mdnsServiceName: string;
  macAddress: string;
  dockSerial: string;
  childSerial: string;
  brightness?: number;
  brightnessOverride?: boolean;
  extraKeys?: Record<string, Record<string, unknown>>;
  touchStripMode?: string;
  touchStripRepaintMs?: number;
  encoders?: { connectToApp?: boolean; commands?: Record<string, Record<string, string>> };
  [key: string]: unknown;
}

export interface SettingsJson {
  selectedDock?: number;
  logLevel?: string;
  multiDeck?: boolean;
  updateCheck?: boolean;
  devices?: DeviceEntry[];
  modelOverrides?: Record<string, unknown>;
  [key: string]: unknown;
}

/** One dock entry of GET /api/state `docks[]` (ts/src/web/contract.ts DockStatus). */
export interface DockState {
  index: number;
  modelId: string;
  keyCount: number;
  columns: number;
  rows: number;
  deviceKey: string;
  mdnsServiceName: string;
  brightness: number;
  displayState?: 'active' | 'dimmed' | 'night' | 'standby' | 'off';
  effectiveBrightness?: number;
  elgatoConnected: boolean;
  extraKeys?: number[];
  pressableExtraKeys?: number[];
  widgetDisplays?: Array<{ wireId: number; label: string }>;
  encoderCount?: number;
  coraProfile?: string;
  touchStripSize?: { width: number; height: number };
}

export function dock0(state: AppState): DockState {
  const docks = state.docks as DockState[] | undefined;
  const d = docks?.[0];
  if (!d) throw new Error('GET /api/state has no dock 0');
  return d;
}

export async function getSettings(
  request: APIRequestContext,
  baseURL: string,
): Promise<SettingsJson> {
  return (await api<SettingsJson>(request, baseURL, '/api/settings')).json;
}

export async function deviceEntry(
  request: APIRequestContext,
  baseURL: string,
  deviceKey: string,
): Promise<DeviceEntry | undefined> {
  return (await getSettings(request, baseURL)).devices?.find((d) => d.deviceKey === deviceKey);
}

const IDENTITY_FIELDS = ['deviceKey', 'mdnsServiceName', 'macAddress', 'dockSerial', 'childSerial'];

/**
 * Put settings.json back the way `snapshot` had it, without dropping identities created
 * since: a mock dock keeps its `mock:<modelId>` entry (its prefs are looked up by that
 * key), it only loses what the spec configured on it.
 *
 * Device tuning is re-imported only when it changed — every `modelOverrides` import
 * reopens the session, and a needless reopen would flap the driver under the next spec.
 */
export async function restoreSettings(
  request: APIRequestContext,
  baseURL: string,
  snapshot: SettingsJson,
): Promise<void> {
  const now = await getSettings(request, baseURL);
  const saved = new Map((snapshot.devices ?? []).map((d) => [d.deviceKey, d]));
  const devices = (now.devices ?? []).map(
    (d) =>
      saved.get(d.deviceKey) ??
      (Object.fromEntries(IDENTITY_FIELDS.map((k) => [k, d[k]])) as DeviceEntry),
  );
  const overridesChanged =
    JSON.stringify(now.modelOverrides ?? {}) !== JSON.stringify(snapshot.modelOverrides ?? {});
  const body: SettingsJson = {
    devices,
    multiDeck: snapshot.multiDeck ?? false,
    ...(overridesChanged ? { modelOverrides: snapshot.modelOverrides ?? {} } : {}),
  };
  const res = await api(request, baseURL, '/api/settings', body);
  expect(res.status, 'restore settings.json').toBe(200);
  await waitForState(request, baseURL, (s) => s.driverConnected);
}

/** POST a device-tuning override and wait until the reopened mock reports it. */
export async function setOverride(
  request: APIRequestContext,
  baseURL: string,
  modelId: string,
  overrides: Record<string, unknown>,
  settled: (state: AppState) => boolean,
): Promise<AppState> {
  const res = await api<{ reconnecting?: boolean; error?: string }>(
    request,
    baseURL,
    '/api/device-overrides',
    { modelId, overrides },
  );
  expect(res.status, `override ${JSON.stringify(overrides)}: ${res.json.error ?? ''}`).toBe(200);
  return waitForState(request, baseURL, (s) => s.driverConnected && settled(s));
}

/** Drop a model's device tuning; `settled` says when the reopened mock shows the defaults. */
export async function resetOverride(
  request: APIRequestContext,
  baseURL: string,
  modelId: string,
  settled: (state: AppState) => boolean = () => true,
): Promise<AppState> {
  const res = await api(request, baseURL, '/api/device-overrides/reset', { modelId });
  expect(res.status).toBe(200);
  return waitForState(request, baseURL, (s) => s.driverConnected && settled(s));
}
