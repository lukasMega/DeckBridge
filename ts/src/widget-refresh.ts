// Background value sources for the display widgets (weather + command), shared
// across keys and docks, and the forced refresh a device tap asks for.
import { runCommand } from './os-utils.js';
import { log } from './logger.js';
import { DEFAULT_TAP_FEEDBACK, type TapFeedback } from './settings-store.js';

/** Runs a shell command, resolving its stdout (os-utils runCommand; injectable for tests). */
export type WidgetCommandRunner = (cmd: string, timeoutMs: number) => Promise<string>;

/** Injectable clock + runner, so tests can drive the gates without real time or a shell. */
export interface SourceSeams {
  now: () => number;
  run: WidgetCommandRunner;
}

export const DEFAULT_SEAMS: SourceSeams = { now: () => Date.now(), run: runCommand };

interface CacheEntry<T> {
  value?: T;
  lastAttempt: number;
  inflight: boolean;
  /** A forced run arrived mid-run: run once more when this one ends (latest wins). */
  followUp?: () => Promise<T | undefined>;
  /** Called once the entry goes idle (run + any follow-up done, success or not). */
  settled: Array<() => void>;
}

function entryIn<T>(cache: Map<string, CacheEntry<T>>, key: string): CacheEntry<T> {
  let entry = cache.get(key);
  if (!entry) {
    entry = { lastAttempt: 0, inflight: false, settled: [] };
    cache.set(key, entry);
  }
  return entry;
}

function startFetch<T>(
  e: CacheEntry<T>,
  key: string,
  fetchValue: () => Promise<T | undefined>,
  onUpdate: () => void,
  now: () => number,
): void {
  e.inflight = true;
  e.lastAttempt = now();
  fetchValue()
    .then((v) => {
      if (v !== undefined) e.value = v;
      onUpdate();
      return undefined;
    })
    .catch((err: unknown) =>
      log('warn', 'widget', `refresh failed (${key}): ${(err as Error).message}`),
    )
    .finally(() => {
      e.inflight = false;
      const next = e.followUp;
      e.followUp = undefined;
      if (next) {
        startFetch(e, key, next, onUpdate, now);
        return;
      }
      for (const done of e.settled.splice(0)) done();
    });
}

/** Cached value for `key` (module-level: same param — location or command string —
 *  fetched once, shared across keys/docks). Kicks off a background `fetchValue` at
 *  most every `refreshMs`, one in flight per key; `onUpdate` repaints on completion. */
function cachedValue<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  refreshMs: number,
  fetchValue: () => Promise<T | undefined>,
  onUpdate: () => void,
  now: () => number,
): T | undefined {
  const e = entryIn(cache, key);
  if (!e.inflight && now() - e.lastAttempt >= refreshMs) {
    startFetch(e, key, fetchValue, onUpdate, now);
  }
  return e.value;
}

/** Run now, bypassing the interval; mid-run it queues exactly one follow-up (a burst
 *  of taps collapses), like the press-command slots in command-actions.ts. */
function forceFetch<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  fetchValue: () => Promise<T | undefined>,
  onUpdate: () => void,
  onSettled: (() => void) | undefined,
  now: () => number,
): void {
  const e = entryIn(cache, key);
  if (onSettled) e.settled.push(onSettled);
  if (e.inflight) e.followUp = fetchValue;
  else startFetch(e, key, fetchValue, onUpdate, now);
}

// Weather (Open-Meteo, no API key)

const WEATHER_REFRESH_MS = 10 * 60 * 1000;
/** A tap refetches a location at most this often — the endpoint is a free public API. */
export const WEATHER_FORCE_MIN_MS = 60 * 1000;
const weatherCache = new Map<string, CacheEntry<number>>();

/** "lat,lon" → [lat, lon], or null when unparseable/out of range. */
export function parseLatLon(param: string | undefined): [number, number] | null {
  const m = param?.split(',').map((s) => Number(s.trim()));
  if (!m || m.length !== 2 || m.some((n) => !Number.isFinite(n))) return null;
  const [lat, lon] = m as [number, number];
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? [lat, lon] : null;
}

async function fetchWeatherTemp(lat: number, lon: number): Promise<number | undefined> {
  // Plain HTTP on purpose: the slim txiki build has no TLS ("HTTPS not
  // supported in this build") — only the location coordinates go cleartext.
  const url = `http://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { current_weather?: { temperature?: number } };
  const t = data.current_weather?.temperature;
  return typeof t === 'number' ? t : undefined;
}

function weatherSource(param: string | undefined) {
  const coords = parseLatLon(param);
  if (!coords) return null;
  const [lat, lon] = coords;
  return {
    key: `${lat},${lon}`,
    fetchTemp: (): Promise<number | undefined> => fetchWeatherTemp(lat, lon),
  };
}

/** Current cached temperature for a weather param; refreshes at most every 10 min. */
export function weatherTempFor(
  param: string | undefined,
  onUpdate: () => void,
  now: () => number,
): number | undefined {
  const src = weatherSource(param);
  if (!src) return undefined;
  return cachedValue(weatherCache, src.key, WEATHER_REFRESH_MS, src.fetchTemp, onUpdate, now);
}

/** Tap refresh: refetch unless this location was fetched under WEATHER_FORCE_MIN_MS
 *  ago. True = a fetch is running (started now or already in flight) and `onSettled`
 *  fires when it ends; false = nothing to fetch, the caller just repaints. */
export function refreshWeather(
  param: string | undefined,
  onUpdate: () => void,
  onSettled: (() => void) | undefined,
  now: () => number,
): boolean {
  const src = weatherSource(param);
  if (!src) return false;
  const e = entryIn(weatherCache, src.key);
  if (!e.inflight) {
    if (now() - e.lastAttempt < WEATHER_FORCE_MIN_MS) return false;
    startFetch(e, src.key, src.fetchTemp, onUpdate, now);
  }
  if (onSettled) e.settled.push(onSettled);
  return true;
}

// Custom command (runs the param via the shell, shows its stdout).
// SECURITY: arbitrary shell command from the WebUI config. Loopback-only by default
// (webuiBindAddr()), but `--bind` on the LAN lets anyone reaching :3000 run a command
// on this host. Opt-in per key, trusted personal LAN only.

const commandCache = new Map<string, CacheEntry<string>>();

/** Cached stdout of the command widget's command; re-runs at most every `intervalMs`. */
export function commandOutputFor(
  param: string | undefined,
  intervalMs: number,
  timeoutMs: number,
  onUpdate: () => void,
  seams: SourceSeams,
): string | undefined {
  const cmd = param?.trim();
  if (!cmd) return undefined;
  const run = (): Promise<string> => seams.run(cmd, timeoutMs);
  return cachedValue(commandCache, cmd, intervalMs, run, onUpdate, seams.now);
}

/** Immediate re-run of a command widget's command, bypassing the interval gate (tap
 *  refresh, the popup's "Run now"). False = no command to run. */
export function refreshCommand(
  param: string | undefined,
  timeoutMs: number,
  onUpdate: () => void,
  onSettled: (() => void) | undefined,
  seams: SourceSeams,
): boolean {
  const cmd = param?.trim();
  if (!cmd) return false;
  const run = (): Promise<string> => seams.run(cmd, timeoutMs);
  forceFetch(commandCache, cmd, run, onUpdate, onSettled, seams.now);
  return true;
}

// Tap feedback source for extra docks. DeviceSession's coordinator
// (driver-manager-extras.ts) is at its line cap, so app.ts registers the
// settings lookup here instead of threading one more dep through it.

let tapFeedbackSource = (_deviceKey: string): TapFeedback => DEFAULT_TAP_FEEDBACK;

export function setTapFeedbackSource(source: (deviceKey: string) => TapFeedback): void {
  tapFeedbackSource = source;
}

/** A dock's tap-refresh feedback flags (settings.json `tapFeedback`), read live. */
export function tapFeedbackFor(deviceKey: string): TapFeedback {
  return tapFeedbackSource(deviceKey);
}
