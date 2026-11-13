// Background value sources for the display widgets (weather + command), shared
// across keys and docks, and the forced refresh a device tap asks for.
import { runCommand } from '../infra/command-runner.js';
import { log } from '../shared/logger.js';
import { fetchTextBounded } from './bounded-http.js';

/** Runs a shell command, resolving its stdout (command-runner runCommand; injectable for tests). */
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
  /** Latest caller's repaint: a stopped widget's closure is replaced, then dropped
   *  with the entry on eviction. */
  onUpdate: () => void;
  /** Last read/refresh by a widget; idle entries past `ttlMs` are evicted. */
  lastAccess: number;
  ttlMs: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const MIN_TTL_MS = 60 * 1000;
/** Hard cap so config churn can't grow a cache without bound between TTL sweeps. */
const MAX_ENTRIES = 64;
/** Entries kept for this many refresh intervals after the last widget access. */
const TTL_INTERVALS = 3;

/** Drop idle entries nobody has asked for lately. An entry with a run in flight or
 *  waiting callbacks is never dropped, so its settled callbacks always fire. */
const idle = (e: CacheEntry<unknown>): boolean => !e.inflight && e.settled.length === 0;

function sweep<T>(cache: Map<string, CacheEntry<T>>, now: number): void {
  for (const [k, e] of cache) {
    if (idle(e) && now - e.lastAccess > e.ttlMs) cache.delete(k);
  }
  // Map iterates in insertion order; touch() re-inserts, so the front is least recent.
  for (const [k, e] of cache) {
    if (cache.size <= MAX_ENTRIES) break;
    if (idle(e)) cache.delete(k);
  }
}

function entryIn<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  now: number,
  onUpdate: () => void,
  refreshMs?: number,
): CacheEntry<T> {
  let entry = cache.get(key);
  if (entry) {
    cache.delete(key); // re-insert: keeps the Map in least-recently-used order
  } else {
    sweep(cache, now);
    entry = {
      lastAttempt: 0,
      inflight: false,
      settled: [],
      onUpdate,
      lastAccess: now,
      ttlMs: DEFAULT_TTL_MS,
    };
  }
  cache.set(key, entry);
  entry.lastAccess = now;
  entry.onUpdate = onUpdate;
  if (refreshMs !== undefined) entry.ttlMs = Math.max(MIN_TTL_MS, TTL_INTERVALS * refreshMs);
  return entry;
}

function startFetch<T>(
  e: CacheEntry<T>,
  key: string,
  fetchValue: () => Promise<T | undefined>,
  now: () => number,
): void {
  e.inflight = true;
  e.lastAttempt = now();
  fetchValue()
    .then((v) => {
      if (v !== undefined) e.value = v;
      e.onUpdate();
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
        startFetch(e, key, next, now);
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
  const e = entryIn(cache, key, now(), onUpdate, refreshMs);
  if (!e.inflight && now() - e.lastAttempt >= refreshMs) {
    startFetch(e, key, fetchValue, now);
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
  const e = entryIn(cache, key, now(), onUpdate);
  if (onSettled) e.settled.push(onSettled);
  if (e.inflight) e.followUp = fetchValue;
  else startFetch(e, key, fetchValue, now);
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

export const WEATHER_TIMEOUT_MS = 10_000;
const WEATHER_MAX_BYTES = 64 * 1024;

export async function fetchWeatherTemp(
  lat: number,
  lon: number,
  timeoutMs = WEATHER_TIMEOUT_MS,
): Promise<number | undefined> {
  // Plain HTTP on purpose: the slim txiki build has no TLS ("HTTPS not
  // supported in this build") — only the location coordinates go cleartext.
  const url = `http://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`;
  const text = await fetchTextBounded(url, timeoutMs, WEATHER_MAX_BYTES);
  const data = JSON.parse(text) as { current_weather?: { temperature?: number } };
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
  const e = entryIn(weatherCache, src.key, now(), onUpdate);
  if (!e.inflight) {
    if (now() - e.lastAttempt < WEATHER_FORCE_MIN_MS) return false;
    startFetch(e, src.key, src.fetchTemp, now);
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
