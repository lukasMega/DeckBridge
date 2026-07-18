// Display widgets for physical keys outside the emulated CORA grid
// (model.keyMap.extraKeys — 293S 6th column, wire ids 16/17/18). Those keys
// have no switches (display-only, verified on hardware), so each shows a
// server-rendered value: clock, date, custom text, or weather. The text is
// composed from a packed bitmap font into a small BMP and shipped through the
// splash path (the worker transform decodes/rotates/encodes for the device),
// so the main thread never runs the 50–200 ms FFI transform itself.
import { FONT_BIG, FONT_SMALL, fontGlyphIndex } from './assets/font-atlas.js';
import type { BitmapFont } from './assets/font-atlas.js';
import {
  COMMAND_INTERVAL_DEFAULT_MS,
  COMMAND_TIMEOUT_DEFAULT_MS,
  type ExtraKeyConfig,
} from './types.js';
import type { DeviceDriver } from './devices/driver.js';
import { splashSpec } from './splash-sender.js';
import { platformName } from './os-utils.js';
import { log } from './logger.js';
import { pluginValueFor, type PluginStatus } from './plugin-host.js';

// Key panel colors — match the WebUI's former canvas icons.
const BG = [0x14, 0x10, 0x10] as const; // BGR of #101014
const FG = [0xec, 0xe8, 0xe8] as const; // BGR of #e8e8ec

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');

/** One rendered line of a widget; big = FONT_BIG (16×32), else FONT_SMALL (8×16). */
export interface WidgetLine {
  text: string;
  big: boolean;
}

/** Everything time/network-dependent a widget can show, injected for testability. */
export interface WidgetContext {
  now: Date;
  /** Last known temperature (°C) for the widget's location; undefined = not fetched yet. */
  weatherTemp?: number;
  /** Last stdout of the command widget's command; undefined = not run yet. */
  commandOut?: string;
  /** plugin widget: last value from the plugin host; undefined = not fetched
   *  yet, null = the plugin returned null (clear the key). */
  pluginValue?: string | null;
  /** plugin widget: the key's plugin run status (ERR/disabled → 'ERR' on the key). */
  pluginStatus?: PluginStatus;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Lay a free-text blob (custom text / command stdout) onto ≤4 centered lines:
 *  blank → null (clear); a single short line uses the big font. */
function textLines(s: string): WidgetLine[] | null {
  const lines = s
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return null;
  const big = lines.length === 1 && lines[0]!.length <= 5;
  return lines.slice(0, 4).map((text) => ({ text, big }));
}

/** The lines a widget shows right now, or null to clear the key ('none'). */
// oxlint-disable-next-line complexity
export function renderWidgetLines(cfg: ExtraKeyConfig, ctx: WidgetContext): WidgetLine[] | null {
  switch (cfg.widget) {
    case 'clock':
      return [{ text: `${pad2(ctx.now.getHours())}:${pad2(ctx.now.getMinutes())}`, big: true }];
    case 'date':
      return [
        { text: WEEKDAYS[ctx.now.getDay()]!, big: false },
        { text: String(ctx.now.getDate()), big: true },
        { text: MONTHS[ctx.now.getMonth()]!, big: false },
      ];
    case 'text':
      return textLines(cfg.param ?? '');
    case 'weather': {
      const t = ctx.weatherTemp;
      return [{ text: t === undefined ? '--' : `${Math.round(t)}\xb0`, big: true }];
    }
    case 'command':
      // Not run yet → a single dot placeholder; empty stdout → clear.
      return ctx.commandOut === undefined ? [{ text: '…', big: true }] : textLines(ctx.commandOut);
    case 'plugin':
      // ERR/disabled → 'ERR'; no value yet → '…' placeholder (like command);
      // null return → clear; a value → centered text lines.
      if (ctx.pluginStatus === 'err' || ctx.pluginStatus === 'disabled') {
        return [{ text: 'ERR', big: true }];
      }
      if (ctx.pluginValue === undefined) return [{ text: '…', big: true }];
      return ctx.pluginValue === null ? null : textLines(ctx.pluginValue);
    case 'none':
      return null;
  }
}

const decodedFonts = new Map<BitmapFont, Uint8Array>();
function fontBits(font: BitmapFont): Uint8Array {
  let bits = decodedFonts.get(font);
  if (!bits) {
    bits = new Uint8Array(Buffer.from(font.bits, 'base64'));
    decodedFonts.set(font, bits);
  }
  return bits;
}

/** Blit one glyph (foreground pixels only) into a BGR pixel buffer. */
function blitGlyph(
  px: Uint8Array,
  size: number,
  font: BitmapFont,
  codepoint: number,
  x0: number,
  y0: number,
): void {
  const idx = fontGlyphIndex(codepoint);
  if (idx < 0) return;
  const rowBytes = Math.ceil(font.width / 8);
  const bits = fontBits(font);
  const base = idx * rowBytes * font.height;
  for (let y = 0; y < font.height; y++) {
    const py = y0 + y;
    if (py < 0 || py >= size) continue;
    for (let x = 0; x < font.width; x++) {
      const on = bits[base + y * rowBytes + (x >> 3)]! & (0x80 >> (x & 7));
      const pxX = x0 + x;
      if (!on || pxX < 0 || pxX >= size) continue;
      const o = (py * size + pxX) * 3;
      px[o] = FG[0];
      px[o + 1] = FG[1];
      px[o + 2] = FG[2];
    }
  }
}

/** Compose widget lines into an upright size×size 24-bit BMP (the worker
 *  transform accepts any format the image crate sniffs — BMP included). */
export function composeWidgetBmp(lines: readonly WidgetLine[], size: number): Uint8Array {
  const px = new Uint8Array(size * size * 3);
  for (let o = 0; o < px.length; o += 3) {
    px[o] = BG[0];
    px[o + 1] = BG[1];
    px[o + 2] = BG[2];
  }

  const totalH = lines.reduce((h, l) => h + (l.big ? FONT_BIG : FONT_SMALL).height, 0);
  let y = Math.max(0, Math.floor((size - totalH) / 2));
  for (const line of lines) {
    const font = line.big ? FONT_BIG : FONT_SMALL;
    const maxChars = Math.floor(size / font.width);
    const text = Array.from(line.text).slice(0, maxChars);
    let x = Math.floor((size - text.length * font.width) / 2);
    for (const ch of text) {
      blitGlyph(px, size, font, ch.codePointAt(0)!, x, y);
      x += font.width;
    }
    y += font.height;
  }

  // 24-bit bottom-up BMP: 14-byte file header + 40-byte BITMAPINFOHEADER.
  const rowSize = Math.ceil((size * 3) / 4) * 4;
  const dataSize = rowSize * size;
  const buf = Buffer.alloc(54 + dataSize);
  buf.write('BM', 0, 'ascii');
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(54, 10); // pixel data offset
  buf.writeUInt32LE(40, 14); // info header size
  buf.writeInt32LE(size, 18);
  buf.writeInt32LE(size, 22);
  buf.writeUInt16LE(1, 26); // planes
  buf.writeUInt16LE(24, 28); // bpp
  buf.writeUInt32LE(dataSize, 34);
  for (let row = 0; row < size; row++) {
    const srcY = size - 1 - row; // bottom-up
    buf.set(px.subarray(srcY * size * 3, (srcY + 1) * size * 3), 54 + row * rowSize);
  }
  return new Uint8Array(buf);
}

// ── Shared background-refresh cache (weather + command) ─────────────────────

interface CacheEntry<T> {
  value?: T;
  lastAttempt: number;
  inflight: boolean;
}

/** Cached value for `key` (module-level caches: the same param — location or
 *  command string — is fetched once and shared across keys and docks). Kicks
 *  off a background `fetchValue` at most every `refreshMs`, one in flight per
 *  key; `onUpdate` repaints on completion. Failures log a warning, not debug —
 *  an invisible failure leaves the key stale with no clue (exactly how the
 *  missing-TLS build bit us). */
function cachedValue<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  refreshMs: number,
  fetchValue: () => Promise<T | undefined>,
  onUpdate: () => void,
): T | undefined {
  let entry = cache.get(key);
  if (!entry) {
    entry = { lastAttempt: 0, inflight: false };
    cache.set(key, entry);
  }
  if (entry.inflight || Date.now() - entry.lastAttempt < refreshMs) return entry.value;
  const e = entry;
  e.inflight = true;
  e.lastAttempt = Date.now();
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
    });
  return e.value;
}

// ── Weather (Open-Meteo, no API key) ─────────────────────────────────────────

const WEATHER_REFRESH_MS = 10 * 60 * 1000;
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

/** Current cached temperature for a weather param; refreshes at most every 10 min. */
function weatherTempFor(param: string | undefined, onUpdate: () => void): number | undefined {
  const coords = parseLatLon(param);
  if (!coords) return undefined;
  const [lat, lon] = coords;
  const fetchTemp = (): Promise<number | undefined> => fetchWeatherTemp(lat, lon);
  return cachedValue(weatherCache, `${lat},${lon}`, WEATHER_REFRESH_MS, fetchTemp, onUpdate);
}

// ── Custom command (runs the param via the shell, shows its stdout) ───────────
//
// SECURITY: this executes an arbitrary shell command taken from the dock's
// WebUI config. The WebUI has no auth and binds all interfaces by default, so
// anyone who can reach :3000 can set a command that runs on this host. It is
// opt-in per key and meant for a trusted personal LAN — the same local-tool
// pragmatism as the weather widget's cleartext HTTP.

const commandCache = new Map<string, CacheEntry<string>>();

/** Read a spawned process' stdout to a string, killing it after `timeoutMs` so
 *  a hung command can't wedge the entry on inflight forever. */
async function runCommand(cmd: string, timeoutMs: number): Promise<string> {
  const args = platformName() === 'Windows' ? ['cmd', '/c', cmd] : ['sh', '-c', cmd];
  const p = tjs.spawn(args, { stdout: 'pipe', stderr: 'ignore' });
  const killer = setTimeout(() => p.kill(), timeoutMs);
  try {
    const dec = new TextDecoder();
    let out = '';
    const reader = p.stdout.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      out += dec.decode(value, { stream: true });
    }
    await p.wait();
    return out;
  } finally {
    clearTimeout(killer);
  }
}

/** Cached stdout of the command widget's command; re-runs at most every `intervalMs`. */
function commandOutputFor(
  param: string | undefined,
  intervalMs: number,
  timeoutMs: number,
  onUpdate: () => void,
): string | undefined {
  const cmd = param?.trim();
  if (!cmd) return undefined;
  return cachedValue(commandCache, cmd, intervalMs, () => runCommand(cmd, timeoutMs), onUpdate);
}

/** Force an immediate re-run of a command widget's command, bypassing the
 *  interval gate (the popup's "Run now" button) — a no-op while already inflight. */
function forceRunCommand(param: string | undefined, timeoutMs: number, onUpdate: () => void): void {
  const cmd = param?.trim();
  if (!cmd) return;
  cachedValue(commandCache, cmd, 0, () => runCommand(cmd, timeoutMs), onUpdate);
}

// ── Per-dock scheduler ────────────────────────────────────────────────────────

/** Ticks once a second, re-renders every configured widget, and repaints a key
 *  only when its rendered content actually changed (clock → one repaint per
 *  minute; idle cost is a few string compares). One instance per connected
 *  dock; start() on connect, stop() on disconnect, repaint() on a WebUI config
 *  change or the driver's 'reinit' (sleep/wake CLE ALL wipes the panels). */
export class ExtraKeyWidgets {
  private readonly driver: DeviceDriver;
  private readonly configFor: (wireId: number) => ExtraKeyConfig | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastPainted = new Map<number, string>();

  constructor(driver: DeviceDriver, configFor: (wireId: number) => ExtraKeyConfig | undefined) {
    this.driver = driver;
    this.configFor = configFor;
  }

  start(): void {
    if (!this.driver.model.keyMap.extraKeys || this.timer !== undefined) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), 1000);
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Force a full repaint on the next tick (config change / device reinit). */
  repaint(): void {
    this.lastPainted.clear();
    if (this.timer !== undefined) this.tick();
  }

  /** Build the render context for one widget, kicking off the background
   *  weather/command refresh (which repaints on completion) as a side effect. */
  private contextFor(cfg: ExtraKeyConfig, now: Date): WidgetContext {
    const onUpdate = (): void => this.repaint();
    if (cfg.widget === 'weather') return { now, weatherTemp: weatherTempFor(cfg.param, onUpdate) };
    if (cfg.widget === 'command') {
      const intervalMs = cfg.intervalMs ?? COMMAND_INTERVAL_DEFAULT_MS;
      const timeoutMs = cfg.timeoutMs ?? COMMAND_TIMEOUT_DEFAULT_MS;
      return { now, commandOut: commandOutputFor(cfg.param, intervalMs, timeoutMs, onUpdate) };
    }
    if (cfg.widget === 'plugin') {
      // SECURITY: a plugin is arbitrary user JS (fs/spawn/ffi, same trust as the
      // command widget above) run in an isolated Worker so it can't stall the
      // CORA loop — see plugin-host.ts / plugin-worker.ts. Opt-in per key,
      // trusted-LAN only. `param` = plugin file name, `pluginArg` = ctx.param.
      const { value, status } = pluginValueFor(cfg.param, cfg.pluginArg, cfg.intervalMs, onUpdate);
      return { now, pluginValue: value, pluginStatus: status };
    }
    return { now };
  }

  /** Force an immediate re-run of wireId's command widget (popup "Run now"),
   *  repainting once it completes. No-op for a non-command/unconfigured key. */
  forceRun(wireId: number): void {
    const cfg = this.configFor(wireId);
    if (cfg?.widget !== 'command') return;
    forceRunCommand(cfg.param, cfg.timeoutMs ?? COMMAND_TIMEOUT_DEFAULT_MS, () => this.repaint());
  }

  private tick(): void {
    const extraKeys = this.driver.model.keyMap.extraKeys;
    if (!extraKeys) return;
    const now = new Date();
    for (const wireId of extraKeys) {
      const cfg = this.configFor(wireId);
      const lines = cfg ? renderWidgetLines(cfg, this.contextFor(cfg, now)) : null;
      const sig = lines === null ? '' : JSON.stringify(lines);
      if (this.lastPainted.get(wireId) === sig) continue;
      this.lastPainted.set(wireId, sig);
      if (lines === null) {
        this.driver.clearKey(wireId);
      } else if (this.driver.sendSplashImage) {
        const spec = splashSpec(this.driver.model);
        this.driver.sendSplashImage(wireId, composeWidgetBmp(lines, spec.width), spec);
      }
    }
  }
}
