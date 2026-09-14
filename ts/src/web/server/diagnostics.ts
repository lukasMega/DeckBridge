// Builds the one-file diagnostics report pasted into a bug report.
//
// Pure: every input is injected, so the SAME builder serves the HTTP route (where
// a live server exists) and `deckbridge diagnose` (where it does not — that is the
// path that works when the WebUI never starts). Output is plain UTF-8 text with
// headed sections, not a zip: it pastes straight into a GitHub issue and needs no
// archive code path.
import type { HidDeviceInfo } from '../../ffi/hidapi.js';
import type { DeviceRow } from '../../cli-devices.js';
import type { RequirementResult } from './requirements.js';
import type { CommEntry } from '../../types.js';
import type { KeyEventEntry, LogEntry, StateResponse } from './types.js';

export interface DiagnosticsOptions {
  /** Replace extra-key `param`/`pluginArg` with "<redacted>". Off by default —
   *  see REVIEW_NOTICE. */
  redactCommands?: boolean;
  /** Cap on the log tail (default DEFAULT_LOG_TAIL_LINES). */
  logTailLines?: number;
}

/** Everything the report can show. Only `header` is required; a section whose
 *  source is absent renders as "(unavailable)" rather than being dropped, so a
 *  reader can tell "no data" from "never collected". */
export interface DiagnosticsSources {
  header: {
    version: string;
    platform: string;
    txikiVersion: string;
    cpus?: string;
    uptimeMs?: number;
    logLevel: string;
    /** Elgato desktop app process presence, probed fresh for the report. Distinct
     *  from `state.elgatoAppConflict`, which is forced false while we hold the
     *  device — that flag answers "is it blocking us", this one "is it running". */
    elgatoAppRunning?: boolean;
  };
  /** Effective CLI flags, as parsed. Values are shown verbatim — none are secrets. */
  flags?: Record<string, unknown>;
  /** DECKBRIDGE_* environment only; the caller filters. */
  env?: Record<string, string>;
  paths?: { cacheRoot?: string; settingsPath?: string; logPath?: string };
  /** Active model overrides (Part B). Flagged loudly when non-empty — a bug
   *  report from a tuned device must never read as default behaviour. */
  modelOverrides?: Record<string, unknown>;
  /** Model specs in effect after overrides are applied, keyed by model id. */
  effectiveModels?: Record<string, unknown>;
  hidDevices?: HidDeviceInfo[];
  /** Wall time of the full diagnostic enumeration that produced `hidDevices`, in ms.
   * Large values identify HID stacks avoided by operational supported-only scans. */
  hidEnumerateMs?: number;
  deviceRows?: DeviceRow[];
  requirements?: RequirementResult[];
  /** Server path only — absent for the CLI path. */
  state?: StateResponse;
  comms?: CommEntry[];
  keyEvents?: KeyEventEntry[];
  /** Tail of the log FILE. Empty falls back to `ringLogs`. */
  logTail?: string;
  /** In-memory log ring buffer (server path) — the fallback when the log file
   *  is unreadable or the sink was disabled. */
  ringLogs?: LogEntry[];
  settingsJson?: string;
}

export const DEFAULT_LOG_TAIL_LINES = 400;

/** First line of every report, in both modes. It survives a copy-paste out of
 *  context, which the UI's and CLI's own on-screen notices do not. */
export const REVIEW_NOTICE =
  '!! This report includes your settings, extra-key commands and local paths. ' +
  'Review it before posting publicly; re-run with --redact-commands to omit commands.';

const REDACTED = '<redacted>';
const UNAVAILABLE = '(unavailable)';

function section(title: string, body: string): string {
  return `\n──── ${title} ────\n${body.length > 0 ? body : UNAVAILABLE}\n`;
}

function kvBlock(obj: Record<string, unknown> | undefined): string {
  if (!obj) return '';
  const entries = Object.entries(obj);
  if (entries.length === 0) return '(none)';
  const width = Math.max(...entries.map(([k]) => k.length));
  return entries.map(([k, v]) => `${k.padEnd(width)} = ${String(v)}`).join('\n');
}

function jsonBlock(value: unknown): string {
  if (value === undefined) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return UNAVAILABLE;
  }
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ${s % 60}s`;
}

/** Render rows as an aligned text table. Empty rows → '(none)'. */
function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return '(none)';
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]): string =>
    cells
      .map((c, i) => c.padEnd(widths[i]!))
      .join('  ')
      .trimEnd();
  return [line(headers), ...rows.map(line)].join('\n');
}

function hex4(n: number): string {
  return Number.isFinite(n) ? n.toString(16).padStart(4, '0') : '????';
}

/** The enumeration duration rides in the section title: it is the single number that
 *  says whether a "freezes when X is plugged in" report is an enumeration stall. */
function hidSectionTitle(tookMs: number | undefined): string {
  const took = tookMs === undefined ? '' : `, took ${tookMs}ms`;
  return `hid enumeration (all devices${took})`;
}

function hidTable(devices: HidDeviceInfo[] | undefined): string {
  if (!devices) return '';
  return table(
    ['VID:PID', 'USAGE', 'IF', 'MANUFACTURER', 'PRODUCT', 'SERIAL', 'PATH'],
    devices.map((d) => [
      `${hex4(d.vendorId)}:${hex4(d.productId)}`,
      `${hex4(d.usagePage)}:${hex4(d.usage)}`,
      String(d.interfaceNumber),
      d.manufacturer,
      d.product,
      d.serial,
      d.path,
    ]),
  );
}

function registryTable(rows: DeviceRow[] | undefined): string {
  if (!rows) return '';
  return table(
    ['MODEL', 'VID:PID', 'SERIAL', 'PATH', 'SUPPORTED'],
    rows.map((r) => [r.model, r.vidPid, r.serial, r.path, r.supported]),
  );
}

function requirementsBlock(results: RequirementResult[] | undefined): string {
  if (!results) return '';
  return table(
    ['CHECK', 'OK', 'DETAIL'],
    results.map((r) => [
      r.name,
      r.ok ? 'yes' : 'NO',
      r.ok ? r.message : `${r.message} — ${r.installHint ?? ''}`.trim(),
    ]),
  );
}

function logsBlock(sources: DiagnosticsSources, maxLines: number): string {
  const tail = sources.logTail?.trim() ?? '';
  if (tail.length > 0) {
    const lines = tail.split('\n');
    return lines.slice(Math.max(0, lines.length - maxLines)).join('\n');
  }
  if (!sources.ringLogs) return '';
  // Fallback: the in-memory ring buffer, when the log file is unreadable or the
  // sink disabled itself.
  return sources.ringLogs
    .slice(-maxLines)
    .map(
      (e) =>
        `${new Date(e.ts).toISOString()} ${e.level.toUpperCase()} [${e.component}] ${e.message}`,
    )
    .join('\n');
}

function commsBlock(comms: CommEntry[] | undefined): string {
  if (!comms) return '';
  return comms
    .map(
      (c) =>
        `${new Date(c.ts).toISOString()} ${c.direction} ${c.protocol} [${c.component}] ` +
        `${c.totalBytes}B ${c.human}`,
    )
    .join('\n');
}

function keyEventsBlock(events: KeyEventEntry[] | undefined): string {
  if (!events) return '';
  return events
    .map((e) => `${new Date(e.ts).toISOString()} mk2=${e.mk2Index} ${e.state}`)
    .join('\n');
}

/** Replace extra-key `param`/`pluginArg` in a settings.json string. Operates on
 *  the parsed object so it can't corrupt unrelated text that happens to match. */
function redactSettings(settingsJson: string): string {
  try {
    const parsed = JSON.parse(settingsJson) as {
      devices?: Array<{ extraKeys?: Record<string, { param?: string; pluginArg?: string }> }>;
    };
    for (const device of parsed.devices ?? []) {
      for (const cfg of Object.values(device.extraKeys ?? {})) {
        if (cfg.param !== undefined) cfg.param = REDACTED;
        if (cfg.pluginArg !== undefined) cfg.pluginArg = REDACTED;
      }
    }
    return JSON.stringify(parsed, null, 2);
  } catch {
    // Unparsable settings: redact nothing rather than leak — the raw text could
    // contain commands anywhere.
    return UNAVAILABLE;
  }
}

/** Process presence of the Elgato desktop app, or "(unavailable)" when the
 *  caller could not probe it. */
function elgatoAppText(running: boolean | undefined): string {
  if (running === undefined) return UNAVAILABLE;
  return running ? 'running' : 'not running';
}

function headerBlock(h: DiagnosticsSources['header']): string {
  return kvBlock({
    version: h.version,
    platform: h.platform,
    'txiki.js': h.txikiVersion,
    cpus: h.cpus ?? UNAVAILABLE,
    uptime: h.uptimeMs === undefined ? UNAVAILABLE : formatDuration(h.uptimeMs),
    'log level': h.logLevel,
    'elgato app': elgatoAppText(h.elgatoAppRunning),
    generated: new Date().toISOString(),
  });
}

function overridesBlock(overrides: Record<string, unknown> | undefined): string {
  if (!overrides) return '';
  const ids = Object.keys(overrides);
  if (ids.length === 0) return 'none — this device is running registry defaults';
  return (
    `!! ${ids.length} model(s) have USER OVERRIDES active — behaviour below is NOT the shipped default:\n` +
    `   ${ids.join(', ')}\n\n${jsonBlock(overrides)}`
  );
}

/** Assemble the report. Never throws: a missing or malformed source degrades to
 *  "(unavailable)" so a partial report still reaches the issue. */
export function buildDiagnostics(src: DiagnosticsSources, opt: DiagnosticsOptions = {}): string {
  const maxLines = opt.logTailLines ?? DEFAULT_LOG_TAIL_LINES;
  const settings = src.settingsJson;
  let settingsBlock = '';
  if (settings !== undefined) {
    settingsBlock = opt.redactCommands ? redactSettings(settings) : settings;
  }
  const parts = [
    REVIEW_NOTICE,
    section('deckbridge diagnostics', headerBlock(src.header)),
    section('cli flags', kvBlock(src.flags)),
    section('environment (DECKBRIDGE_*)', kvBlock(src.env)),
    section('paths', kvBlock(src.paths)),
    section('model overrides', overridesBlock(src.modelOverrides)),
    section('effective model specs', jsonBlock(src.effectiveModels)),
    section(hidSectionTitle(src.hidEnumerateMs), hidTable(src.hidDevices)),
    section('registry matches', registryTable(src.deviceRows)),
    section('requirements', requirementsBlock(src.requirements)),
    section('docks / live state', jsonBlock(src.state)),
    section(`log tail (last ${maxLines} lines)`, logsBlock(src, maxLines)),
    section('cora comm buffer', commsBlock(src.comms)),
    section('key events', keyEventsBlock(src.keyEvents)),
    section('settings.json', settingsBlock),
  ];
  return parts.join('\n') + '\n';
}

/** `deckbridge-diagnostics-<ISO>.txt`, with the colons an ISO timestamp would put
 *  in a filename replaced (Windows rejects them). */
export function diagnosticsFileName(now: Date = new Date()): string {
  return `deckbridge-diagnostics-${now.toISOString().replace(/[:.]/g, '-')}.txt`;
}
