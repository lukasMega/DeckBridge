import { assets } from './assets.js';
import { checkRequirements } from './requirements.js';
import { get, post } from './router.js';
import type { Route, RouteContext } from './router.js';
import { badRequest, css, html, jpeg, js, json, noContent, notFound, text } from './http.js';
import type { MockDeviceConfig } from './types.js';
import {
  EXTRA_KEY_WIDGETS,
  EXTRA_KEY_PARAM_MAX,
  COMMAND_INTERVAL_MIN_MS,
  COMMAND_INTERVAL_MAX_MS,
  COMMAND_TIMEOUT_MIN_MS,
  COMMAND_TIMEOUT_MAX_MS,
} from '../../types.js';
import type { ExtraKeyConfig, ExtraKeyWidget, ImageModeOverride } from '../../types.js';

// The complete HTTP surface, declarative. WebSocket upgrade (/api/ws) is handled
// before dispatch in WebUIServer; everything else lives here.
export const routes: Route[] = [
  get('/', () => html(assets.html)),
  get('/ui.css', () => css(assets.css)),
  get('/ui.js', () => js(assets.js)),
  get('/requirements', () => html(assets.requirementsHtml)),
  get('/api/requirements', async () => json(await checkRequirements())),
  get('/api/state', ({ ui }) => json(ui.fullState())),
  get('/api/plugins', async ({ ui }) => json(await ui.pluginsInfo())),
  get('/api/settings', ({ ui }) => json(JSON.parse(ui.getSettingsJson()))),
  get('/api/image/:key', ({ ui, params }) => {
    const buf = ui.getImage(Number(params.key));
    return buf ? jpeg(buf) : notFound();
  }),

  post('/api/driver-mode', setDriverMode),
  post('/api/mock-config', setMockConfig),
  post('/api/device-model', setDeviceModel),
  post('/api/brightness', setBrightness),
  post('/api/brightness-override', setBrightnessOverride),
  post('/api/resize-toggle', ({ ui }) => {
    ui.notifyResizeToggle(!ui.resizeEnabled);
    return json({ ok: true, enabled: ui.resizeEnabled });
  }),
  post('/api/image-mode', setImageMode),
  post('/api/key/:n', ({ ui, params }) => {
    const err = ui.trySimulateKey(Number(params.n));
    return err ? json({ error: err.error }, err.status) : noContent();
  }),
  post('/api/select-dock', selectDock),
  post('/api/extra-key', setExtraKey),
  post('/api/extra-key/run', runExtraKeyNow),
  post('/api/settings', setSettings),
  post('/api/settings/open-in-os', async ({ ui }) => {
    await ui.openSettingsFile();
    return json({ ok: true });
  }),
  post('/api/device-identity/mdns-name', setDeviceMdnsName),
  post('/api/log-level', setLogLevelRoute),
  post('/api/logs/open-in-os', async ({ ui }) => {
    await ui.openLogsFolder();
    return json({ ok: true });
  }),

  get('/api/device-overrides', ({ ui, url }) => {
    const modelId = url.searchParams.get('modelId') ?? undefined;
    const view = ui.deviceOverridesView(modelId);
    return 'error' in view ? json({ error: view.error }, view.status) : json(view);
  }),
  post('/api/device-overrides', setDeviceOverrides),
  post('/api/device-overrides/reset', resetDeviceOverrides),

  // text/plain, not JSON: the report is meant to be pasted verbatim into an issue.
  get('/api/diagnostics', async ({ ui, url }) => {
    const redact = url.searchParams.get('redactCommands') === '1';
    return text(await ui.buildDiagnosticsReport({ redactCommands: redact }));
  }),
  post('/api/diagnostics/save', saveDiagnostics),
];

type ParsedBody<T> = { body: T } | { error: Response };

async function readJson<T>(req: Request, message = 'invalid JSON'): Promise<ParsedBody<T>> {
  try {
    const body = JSON.parse(await req.text()) as T | null;
    return body === null ? { error: badRequest(message) } : { body };
  } catch {
    return { error: badRequest(message) };
  }
}

/** Persist one model's device tuning. A validation failure returns the whole
 *  error list so the UI can show every bad field at once. */
async function setDeviceOverrides({ req, ui }: RouteContext): Promise<Response> {
  const parsed = await readJson<{ modelId?: unknown; overrides?: unknown }>(req);
  if ('error' in parsed) return parsed.error;
  const { body } = parsed;
  const err = ui.trySetModelOverride(body.modelId, body.overrides ?? {});
  if (err) return json({ error: err.error }, err.status);
  // The device session closes and reopens (image/wire/keyMap must be in force
  // from the next open) — the UI shows a brief "reapplying…" state on this flag.
  return json({ ok: true, reconnecting: true });
}

async function resetDeviceOverrides({ req, ui }: RouteContext): Promise<Response> {
  const parsed = await readJson<{ modelId: unknown }>(req);
  if ('error' in parsed) return parsed.error;
  const { modelId } = parsed.body;
  const err = ui.tryResetModelOverride(modelId);
  return err ? json({ error: err.error }, err.status) : json({ ok: true, reconnecting: true });
}

/** Write the report next to settings.json and reveal it in the OS file manager —
 *  the path for users who would rather attach a file than paste text. */
async function saveDiagnostics({ req, ui }: RouteContext): Promise<Response> {
  let redactCommands = false;
  try {
    const raw = await req.text();
    if (raw) ({ redactCommands = false } = JSON.parse(raw) as { redactCommands?: boolean });
  } catch {
    return badRequest('invalid JSON');
  }
  const path = await ui.saveDiagnosticsReport({ redactCommands });
  return path ? json({ ok: true, path }) : json({ error: 'could not write report' }, 500);
}

/** WebUI "Debug logging" toggle. Levels are validated against cli.ts's LOG_LEVELS
 *  (the single source of truth, shared with --log-level and settings.json). */
async function setLogLevelRoute({ req, ui }: RouteContext): Promise<Response> {
  const parsed = await readJson<{ level: unknown }>(req);
  if ('error' in parsed) return parsed.error;
  const { level } = parsed.body;
  const err = ui.trySetLogLevel(level);
  return err ? json({ error: err.error }, err.status) : json({ ok: true, level });
}

async function setBrightness({ req, ui }: RouteContext): Promise<Response> {
  const parsed = await readJson<{ level: unknown; dock?: unknown }>(req);
  if ('error' in parsed) return parsed.error;
  const { level, dock } = parsed.body;
  if (typeof level !== 'number' || level < 0 || level > 100 || !Number.isFinite(level)) {
    return badRequest('level must be a number 0–100');
  }
  if (dock !== undefined && (typeof dock !== 'number' || !Number.isInteger(dock) || dock < 0)) {
    return badRequest('dock must be a non-negative integer');
  }
  const dockIndex = typeof dock === 'number' ? dock : 0;
  const rounded = Math.round(level);
  ui.emit('setBrightness', rounded, dockIndex);
  // The legacy single-value brightness field (persisted + shown in Settings)
  // tracks whichever dock is currently selected, so it always reflects the
  // device the user is actually looking at — not always the primary.
  if (dockIndex === ui.selectedDock) ui.notifyBrightness(rounded);
  return json({ ok: true, level: rounded, dock: dockIndex });
}

interface ExtraKeyBody {
  wireId: unknown;
  widget: unknown;
  param?: unknown;
  intervalMs?: unknown;
  timeoutMs?: unknown;
  pluginArg?: unknown;
}

/** null when `v` is undefined or a number within [min, max]; else an error message. */
function validateOptionalMs(v: unknown, field: string, min: number, max: number): string | null {
  if (v === undefined) return null;
  if (typeof v !== 'number' || v < min || v > max) {
    return `${field} must be a number between ${min} and ${max}`;
  }
  return null;
}

/** Field validation for POST /api/extra-key; returns an error message or null. */
function validateExtraKeyBody({
  wireId,
  widget,
  param,
  intervalMs,
  timeoutMs,
  pluginArg,
}: ExtraKeyBody): string | null {
  if (typeof wireId !== 'number' || !Number.isInteger(wireId) || wireId < 0) {
    return 'wireId must be a non-negative integer';
  }
  if (typeof widget !== 'string' || !(EXTRA_KEY_WIDGETS as readonly string[]).includes(widget)) {
    return `widget must be one of: ${EXTRA_KEY_WIDGETS.join(', ')}`;
  }
  if (param !== undefined && (typeof param !== 'string' || param.length > EXTRA_KEY_PARAM_MAX)) {
    return `param must be a string ≤ ${EXTRA_KEY_PARAM_MAX} chars`;
  }
  if (
    pluginArg !== undefined &&
    (typeof pluginArg !== 'string' || pluginArg.length > EXTRA_KEY_PARAM_MAX)
  ) {
    return `pluginArg must be a string ≤ ${EXTRA_KEY_PARAM_MAX} chars`;
  }
  return (
    validateOptionalMs(
      intervalMs,
      'intervalMs',
      COMMAND_INTERVAL_MIN_MS,
      COMMAND_INTERVAL_MAX_MS,
    ) ?? validateOptionalMs(timeoutMs, 'timeoutMs', COMMAND_TIMEOUT_MIN_MS, COMMAND_TIMEOUT_MAX_MS)
  );
}

/** Assign a display widget to one of the selected dock's extra keys (293S 6th
 *  column — display-only). The server renders and refreshes the key itself. */
async function setExtraKey({ req, ui }: RouteContext): Promise<Response> {
  const parsed = await readJson<ExtraKeyBody>(req);
  if ('error' in parsed) return parsed.error;
  const { body } = parsed;
  const invalid = validateExtraKeyBody(body);
  if (invalid) return badRequest(invalid);
  const { wireId, widget, param, intervalMs, timeoutMs, pluginArg } = body;
  const cfg: ExtraKeyConfig = {
    widget: widget as ExtraKeyWidget,
    ...(typeof param === 'string' && param ? { param } : {}),
    ...(typeof intervalMs === 'number' ? { intervalMs } : {}),
    ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
    ...(typeof pluginArg === 'string' && pluginArg ? { pluginArg } : {}),
  };
  const err = ui.trySetExtraKey(wireId as number, cfg);
  return err ? json({ error: err.error }, err.status) : json({ ok: true, wireId, widget });
}

interface RunExtraKeyBody {
  wireId: unknown;
}

/** Force an immediate re-run of a command-widget extra key (WebUI "Run now"). */
async function runExtraKeyNow({ req, ui }: RouteContext): Promise<Response> {
  const parsed = await readJson<RunExtraKeyBody>(req);
  if ('error' in parsed) return parsed.error;
  const { wireId } = parsed.body;
  if (typeof wireId !== 'number' || !Number.isInteger(wireId) || wireId < 0) {
    return badRequest('wireId must be a non-negative integer');
  }
  const err = ui.tryRunExtraKeyNow(wireId);
  return err ? json({ error: err.error }, err.status) : json({ ok: true });
}

async function selectDock({ req, ui }: RouteContext): Promise<Response> {
  const parsed = await readJson<{ index: unknown }>(req);
  if ('error' in parsed) return parsed.error;
  const { index } = parsed.body;
  const err = ui.trySelectDock(index);
  return err ? json({ error: err.error }, err.status) : json({ ok: true, index });
}

async function setDriverMode({ req, ui }: RouteContext): Promise<Response> {
  const parsed = await readJson<{ mode: unknown }>(req);
  if ('error' in parsed) return parsed.error;
  const { mode } = parsed.body;
  if (mode !== 'real' && mode !== 'mock') return badRequest('mode must be real or mock');
  ui.emit('switchMode', mode);
  return json({ ok: true, mode });
}

async function setDeviceModel({ req, ui }: RouteContext): Promise<Response> {
  const parsed = await readJson<{ modelId: unknown }>(req, 'invalid request');
  if ('error' in parsed) return parsed.error;
  const { modelId } = parsed.body;
  if (typeof modelId !== 'string') return badRequest('invalid request');
  ui.emit('setModel', modelId);
  return json({ ok: true, modelId });
}

async function setBrightnessOverride({ req, ui }: RouteContext): Promise<Response> {
  const parsed = await readJson<{ enabled: unknown }>(req);
  if ('error' in parsed) return parsed.error;
  const { enabled } = parsed.body;
  if (typeof enabled !== 'boolean') return badRequest('enabled must be a boolean');
  ui.notifyBrightnessOverride(enabled);
  return json({ ok: true, enabled: ui.brightnessOverride });
}

const IMAGE_MODE_VALUES = ['resize', 'pad-black', 'pad-average', 'pad-edge', 'default'] as const;

async function setImageMode({ req, ui }: RouteContext): Promise<Response> {
  const parsed = await readJson<{ mode: unknown }>(req);
  if ('error' in parsed) return parsed.error;
  const { mode } = parsed.body;
  if (
    typeof mode !== 'string' ||
    !IMAGE_MODE_VALUES.includes(mode as (typeof IMAGE_MODE_VALUES)[number])
  ) {
    return badRequest(`mode must be one of: ${IMAGE_MODE_VALUES.join(', ')}`);
  }
  const effective: ImageModeOverride = mode === 'default' ? null : (mode as ImageModeOverride);
  ui.notifyImageMode(effective);
  return json({ ok: true, mode });
}

async function setMockConfig({ req, ui }: RouteContext): Promise<Response> {
  const parsed = await readJson<Partial<MockDeviceConfig>>(req);
  if ('error' in parsed) return parsed.error;
  return json({ ok: true, mockConfig: ui.applyMockConfig(parsed.body) });
}

const MDNS_NAME_MAX_LEN = 63; // sane cap — dns-sd/avahi service instance names aren't unbounded

async function setDeviceMdnsName({ req, ui }: RouteContext): Promise<Response> {
  const parsed = await readJson<{ deviceKey: unknown; name: unknown }>(req);
  if ('error' in parsed) return parsed.error;
  const { deviceKey, name } = parsed.body;
  if (typeof deviceKey !== 'string' || !deviceKey) {
    return badRequest('deviceKey must be a non-empty string');
  }
  if (typeof name !== 'string' || !name.trim()) {
    return badRequest('name must be a non-empty string');
  }
  const trimmed = name.trim().slice(0, MDNS_NAME_MAX_LEN);
  ui.emit('setDeviceMdnsName', deviceKey, trimmed);
  return json({ ok: true, name: trimmed });
}

async function setSettings({ req, ui }: RouteContext): Promise<Response> {
  const raw = await req.text();
  try {
    ui.applySettingsJson(raw);
  } catch (e) {
    return badRequest((e as Error).message || 'invalid settings');
  }
  return json({ ok: true, settings: JSON.parse(ui.getSettingsJson()) as unknown });
}
