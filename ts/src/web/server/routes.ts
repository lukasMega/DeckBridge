import { assets } from './assets.js';
import { checkRequirements } from './requirements.js';
import { get, post } from './router.js';
import type { Route, RouteContext } from './router.js';
import { badRequest, css, html, jpeg, js, json, noContent, notFound } from './http.js';
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
];

async function setBrightness({ req, ui }: RouteContext): Promise<Response> {
  let level: unknown;
  let dock: unknown;
  try {
    ({ level, dock } = JSON.parse(await req.text()) as { level: unknown; dock?: unknown });
  } catch {
    return badRequest('invalid JSON');
  }
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
  let body: ExtraKeyBody;
  try {
    body = JSON.parse(await req.text()) as ExtraKeyBody;
  } catch {
    return badRequest('invalid JSON');
  }
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
  let body: RunExtraKeyBody;
  try {
    body = JSON.parse(await req.text()) as RunExtraKeyBody;
  } catch {
    return badRequest('invalid JSON');
  }
  const { wireId } = body;
  if (typeof wireId !== 'number' || !Number.isInteger(wireId) || wireId < 0) {
    return badRequest('wireId must be a non-negative integer');
  }
  const err = ui.tryRunExtraKeyNow(wireId);
  return err ? json({ error: err.error }, err.status) : json({ ok: true });
}

async function selectDock({ req, ui }: RouteContext): Promise<Response> {
  let index: unknown;
  try {
    ({ index } = JSON.parse(await req.text()) as { index: unknown });
  } catch {
    return badRequest('invalid JSON');
  }
  const err = ui.trySelectDock(index);
  return err ? json({ error: err.error }, err.status) : json({ ok: true, index });
}

async function setDriverMode({ req, ui }: RouteContext): Promise<Response> {
  let mode: unknown;
  try {
    ({ mode } = JSON.parse(await req.text()) as { mode: unknown });
  } catch {
    return badRequest('invalid JSON');
  }
  if (mode !== 'real' && mode !== 'mock') return badRequest('mode must be real or mock');
  ui.emit('switchMode', mode);
  return json({ ok: true, mode });
}

async function setDeviceModel({ req, ui }: RouteContext): Promise<Response> {
  try {
    const { modelId } = JSON.parse(await req.text()) as { modelId: unknown };
    if (typeof modelId !== 'string') throw new Error('modelId must be string');
    ui.emit('setModel', modelId);
    return json({ ok: true, modelId });
  } catch {
    return badRequest('invalid request');
  }
}

async function setBrightnessOverride({ req, ui }: RouteContext): Promise<Response> {
  let enabled: unknown;
  try {
    ({ enabled } = JSON.parse(await req.text()) as { enabled: unknown });
  } catch {
    return badRequest('invalid JSON');
  }
  if (typeof enabled !== 'boolean') return badRequest('enabled must be a boolean');
  ui.notifyBrightnessOverride(enabled);
  return json({ ok: true, enabled: ui.brightnessOverride });
}

const IMAGE_MODE_VALUES = ['resize', 'pad-black', 'pad-average', 'pad-edge', 'default'] as const;

async function setImageMode({ req, ui }: RouteContext): Promise<Response> {
  let mode: unknown;
  try {
    ({ mode } = JSON.parse(await req.text()) as { mode: unknown });
  } catch {
    return badRequest('invalid JSON');
  }
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
  let parsed: Partial<MockDeviceConfig>;
  try {
    parsed = JSON.parse(await req.text()) as Partial<MockDeviceConfig>;
  } catch {
    return badRequest('invalid JSON');
  }
  return json({ ok: true, mockConfig: ui.applyMockConfig(parsed) });
}

const MDNS_NAME_MAX_LEN = 63; // sane cap — dns-sd/avahi service instance names aren't unbounded

async function setDeviceMdnsName({ req, ui }: RouteContext): Promise<Response> {
  let deviceKey: unknown;
  let name: unknown;
  try {
    ({ deviceKey, name } = JSON.parse(await req.text()) as { deviceKey: unknown; name: unknown });
  } catch {
    return badRequest('invalid JSON');
  }
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
