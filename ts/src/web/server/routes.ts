import { assets } from './assets.js';
import { checkRequirements } from './requirements.js';
import { get, post, postJson } from './router.js';
import type { Route, RouteContext } from './router.js';
import { badRequest, bmp, css, html, jpeg, js, json, noContent, notFound, text } from './http.js';
import { isNonNegInt, nonNegIntMessage } from './types.js';
import type { MockDeviceConfig } from './types.js';
import {
  EXTRA_KEY_WIDGETS,
  EXTRA_KEY_PARAM_MAX,
  COMMAND_INTERVAL_MIN_MS,
  COMMAND_INTERVAL_MAX_MS,
  COMMAND_TIMEOUT_MIN_MS,
  COMMAND_TIMEOUT_MAX_MS,
  ENCODER_COMMAND_MAX,
  TOUCH_STRIP_MODES,
  TOUCH_STRIP_REPAINT_MIN_MS,
  TOUCH_STRIP_REPAINT_MAX_MS,
  isTouchStripRepaintMs,
} from '../../types.js';
import type {
  EncoderSettings,
  ExtraKeyConfig,
  ExtraKeyWidget,
  TouchStripMode,
} from '../../types.js';
import { encoderSettingsError } from './encoders-controller.js';

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
    const key = Number(params.key);
    const buf = ui.getImage(key);
    if (!buf) return notFound();
    return ui.imageChannel.imageFormat.get(key) === 'bmp' ? bmp(buf) : jpeg(buf);
  }),

  postJson('/api/driver-mode', setDriverMode),
  postJson('/api/mock-config', setMockConfig),
  postJson('/api/device-model', setDeviceModel, 'invalid request'),
  postJson('/api/brightness', setBrightness),
  postJson('/api/brightness-override', setBrightnessOverride),
  post('/api/key/:n', ({ ui, params }) => {
    const err = ui.trySimulateKey(Number(params.n));
    return err ? json({ error: err.error }, err.status) : noContent();
  }),
  postJson('/api/select-dock', selectDock),
  postJson('/api/extra-key', setExtraKey),
  postJson('/api/extra-key/run', runExtraKeyNow),
  postJson('/api/extra-key/press', setExtraKeyPress),
  postJson('/api/touch-strip-mode', setTouchStripMode),
  postJson('/api/touch-strip-repaint', setTouchStripRepaint),
  postJson('/api/encoders', setEncoders),
  post('/api/settings', setSettings),
  post('/api/settings/open-in-os', async ({ ui }) => {
    await ui.openSettingsFile();
    return json({ ok: true });
  }),
  postJson('/api/device-identity/mdns-name', setDeviceMdnsName),
  postJson('/api/log-level', setLogLevelRoute),
  postJson('/api/multi-deck', setMultiDeckRoute),
  postJson('/api/browser-locale', setBrowserLocaleRoute),
  post('/api/logs/open-in-os', async ({ ui }) => {
    await ui.openLogsFolder();
    return json({ ok: true });
  }),

  get('/api/device-overrides', ({ ui, url }) => {
    const modelId = url.searchParams.get('modelId') ?? undefined;
    const view = ui.deviceOverridesView(modelId);
    return 'error' in view ? json({ error: view.error }, view.status) : json(view);
  }),
  postJson('/api/device-overrides', setDeviceOverrides),
  postJson('/api/device-overrides/reset', resetDeviceOverrides),

  get('/api/update', ({ ui }) => json(ui.updates.info())),
  post('/api/update/check', async ({ ui }) => json(await ui.updates.check(true))),
  postJson('/api/update/dismiss', dismissUpdate),
  postJson('/api/update-check-enabled', setUpdateCheckEnabled),

  // text/plain, not JSON: the report is meant to be pasted verbatim into an issue.
  get('/api/diagnostics', async ({ ui, url }) => {
    const redact = url.searchParams.get('redactCommands') === '1';
    return text(await ui.buildDiagnosticsReport({ redactCommands: redact }));
  }),
  post('/api/diagnostics/save', saveDiagnostics),
];

/** Persist one model's device tuning. A validation failure returns the whole
 *  error list so the UI can show every bad field at once. */
function setDeviceOverrides(
  body: { modelId?: unknown; overrides?: unknown },
  { ui }: RouteContext,
): Response {
  const r = ui.trySetModelOverride(body.modelId, body.overrides ?? {});
  if ('error' in r) return json({ error: r.error }, r.status);
  // An image-only change is swapped into the running session and the deck is
  // repainted; keyMap/wire/splash need the next open(), so the session reopens
  // and the UI shows a brief "reapplying…" state on this flag.
  return json({ ok: true, reconnecting: r.kind === 'reopen' });
}

function resetDeviceOverrides({ modelId }: { modelId: unknown }, { ui }: RouteContext): Response {
  const r = ui.tryResetModelOverride(modelId);
  if ('error' in r) return json({ error: r.error }, r.status);
  return json({ ok: true, reconnecting: r.kind === 'reopen' });
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

/** WebUI "Check for updates" close-button: remembers the version so the badge
 *  doesn't reappear until a newer one ships. */
function dismissUpdate({ version }: { version: unknown }, { ui }: RouteContext): Response {
  if (typeof version !== 'string' || !version)
    return badRequest('version must be a non-empty string');
  return json(ui.updates.dismiss(version));
}

/** WebUI "Check for updates" toggle (opt-out; settings.json `updateCheck`). */
function setUpdateCheckEnabled({ enabled }: { enabled: unknown }, { ui }: RouteContext): Response {
  if (typeof enabled !== 'boolean') return badRequest('enabled must be a boolean');
  ui.updates.setEnabled(enabled);
  return json({ ok: true, enabled });
}

/** WebUI "Debug logging" toggle. Levels are validated against cli.ts's LOG_LEVELS
 *  (the single source of truth, shared with --log-level and settings.json). */
function setLogLevelRoute({ level }: { level: unknown }, { ui }: RouteContext): Response {
  const err = ui.trySetLogLevel(level);
  return err ? json({ error: err.error }, err.status) : json({ ok: true, level });
}

/** WebUI "Use two decks at once" toggle. Disabling it also disconnects a live
 *  second dock (DriverManager.setMultiDeck). */
function setMultiDeckRoute({ enabled }: { enabled: unknown }, { ui }: RouteContext): Response {
  if (typeof enabled !== 'boolean') return badRequest('enabled must be a boolean');
  ui.setMultiDeck(enabled);
  return json({ ok: true, enabled });
}

/** Browser's `navigator.language`, sent once on WebUI load. Fallback for
 *  daily-ping.ts's locale dim when the OS-level probe fails. Length-capped —
 *  same reasoning as daily-ping.ts's other closed-vocabulary fields: an
 *  unbounded string is an unbounded fingerprint, not just an unbounded key. */
function setBrowserLocaleRoute({ locale }: { locale: unknown }, { ui }: RouteContext): Response {
  if (typeof locale !== 'string' || !locale || locale.length > 35)
    return badRequest('locale must be a non-empty string of at most 35 characters');
  ui.setBrowserLocale(locale);
  return json({ ok: true });
}

function setBrightness(
  { level, dock }: { level: unknown; dock?: unknown },
  { ui }: RouteContext,
): Response {
  if (typeof level !== 'number' || level < 0 || level > 100 || !Number.isFinite(level)) {
    return badRequest('level must be a number 0–100');
  }
  if (dock !== undefined && !isNonNegInt(dock)) return badRequest(nonNegIntMessage('dock'));
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
  if (!isNonNegInt(wireId)) return nonNegIntMessage('wireId');
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
 *  column, AKP05E right column). The server renders and refreshes the key itself. */
function setExtraKey(body: ExtraKeyBody, { ui }: RouteContext): Response {
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
function runExtraKeyNow({ wireId }: RunExtraKeyBody, { ui }: RouteContext): Response {
  if (!isNonNegInt(wireId)) return badRequest(nonNegIntMessage('wireId'));
  const err = ui.tryRunExtraKeyNow(wireId);
  return err ? json({ error: err.error }, err.status) : json({ ok: true });
}

/** Shell command a pressable extra key runs on press ('' clears it). Separate from the
 *  widget POST so neither overwrites the other. */
function setExtraKeyPress(
  { wireId, command }: { wireId: unknown; command: unknown },
  { ui }: RouteContext,
): Response {
  if (!isNonNegInt(wireId)) return badRequest(nonNegIntMessage('wireId'));
  if (typeof command !== 'string' || command.length > ENCODER_COMMAND_MAX) {
    return badRequest(`command must be a string ≤ ${ENCODER_COMMAND_MAX} chars`);
  }
  const err = ui.trySetExtraKey(wireId, { pressCommand: command });
  return err ? json({ error: err.error }, err.status) : json({ ok: true });
}

/** Who paints the touch strip: the Elgato app only, or DeckBridge widgets over it. */
function setTouchStripMode({ mode }: { mode: unknown }, { ui }: RouteContext): Response {
  if (!(TOUCH_STRIP_MODES as readonly unknown[]).includes(mode)) {
    return badRequest(`mode must be one of: ${TOUCH_STRIP_MODES.join(', ')}`);
  }
  const err = ui.trySetTouchStripMode(mode as TouchStripMode);
  return err ? json({ error: err.error }, err.status) : json({ ok: true, mode });
}

/** How long after the Elgato app's last strip frame 'deckbridge-repaint' brings a widget back. */
function setTouchStripRepaint({ ms }: { ms: unknown }, { ui }: RouteContext): Response {
  if (!isTouchStripRepaintMs(ms)) {
    return badRequest(
      `ms must be an integer ${TOUCH_STRIP_REPAINT_MIN_MS}–${TOUCH_STRIP_REPAINT_MAX_MS}`,
    );
  }
  const err = ui.devicePrefs.trySetTouchStripRepaintMs(ms);
  return err ? json({ error: err.error }, err.status) : json({ ok: true, ms });
}

/** Knob override: connect to the Elgato app, or run per-knob shell commands. */
function setEncoders(body: unknown, { ui }: RouteContext): Response {
  const invalid = encoderSettingsError(body);
  if (invalid) return badRequest(invalid);
  const { connectToApp, commands } = body as EncoderSettings;
  const err = ui.trySetEncoders({
    ...(connectToApp !== undefined ? { connectToApp } : {}),
    ...(commands !== undefined ? { commands } : {}),
  });
  return err ? json({ error: err.error }, err.status) : json({ ok: true });
}

function selectDock({ index }: { index: unknown }, { ui }: RouteContext): Response {
  const err = ui.trySelectDock(index);
  return err ? json({ error: err.error }, err.status) : json({ ok: true, index });
}

function setDriverMode({ mode }: { mode: unknown }, { ui }: RouteContext): Response {
  if (mode !== 'real' && mode !== 'mock') return badRequest('mode must be real or mock');
  ui.emit('switchMode', mode);
  return json({ ok: true, mode });
}

function setDeviceModel({ modelId }: { modelId: unknown }, { ui }: RouteContext): Response {
  if (typeof modelId !== 'string') return badRequest('invalid request');
  ui.emit('setModel', modelId);
  return json({ ok: true, modelId });
}

function setBrightnessOverride({ enabled }: { enabled: unknown }, { ui }: RouteContext): Response {
  if (typeof enabled !== 'boolean') return badRequest('enabled must be a boolean');
  ui.notifyBrightnessOverride(enabled);
  return json({ ok: true, enabled: ui.brightnessOverride });
}

function setMockConfig(body: Partial<MockDeviceConfig>, { ui }: RouteContext): Response {
  return json({ ok: true, mockConfig: ui.applyMockConfig(body) });
}

const MDNS_NAME_MAX_LEN = 63; // sane cap — dns-sd/avahi service instance names aren't unbounded

function setDeviceMdnsName(
  { deviceKey, name }: { deviceKey: unknown; name: unknown },
  { ui }: RouteContext,
): Response {
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
