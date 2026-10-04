import { assets } from './assets.js';
import { checkRequirements } from './requirements.js';
import { get, post, postJson } from './router.js';
import type { Route, RouteContext } from './router.js';
import { badRequest, css, html, js, json, noContent, readJson, text } from './http.js';
import type { RawMockInput } from './mock-input.js';
import { pushAdminRoutes } from './push-routes.js';
import { virtualDeckRoutes } from './virtual-deck/virtual-deck-routes.js';
import { pairingAddressRoutes } from './pairing-address-routes.js';
import type { ExternalExpire } from '../contract.js';
import { isNonNegInt, nonNegIntMessage } from './types.js';
import type { MockDeviceConfig } from './types.js';
import {
  EXTRA_KEY_PRESS_ACTIONS,
  ENCODER_COMMAND_MAX,
  TOUCH_STRIP_MODES,
  TOUCH_STRIP_REPAINT_MIN_MS,
  TOUCH_STRIP_REPAINT_MAX_MS,
  compactTextStyle,
  extraKeyConfigError,
  isOneOf,
  isTouchStripRepaintMs,
} from '../../shared/types.js';
import type {
  EncoderSettings,
  ExtraKeyConfig,
  ExtraKeyTextStyle,
  ExtraKeyWidget,
} from '../../shared/types.js';
import { encoderSettingsError } from '../../shared/encoder-settings.js';

// The complete HTTP surface, declarative. WebSocket upgrade (/api/ws) is handled
// before dispatch in WebUIServer; everything else lives here.
export const routes: Route[] = [
  get('/', () => html(assets.html)),
  get('/ui.css', () => css(assets.css)),
  get('/ui.js', () => js(assets.js)),
  get('/requirements', () => html(assets.requirementsHtml)),
  get('/api/requirements', async () => json(await checkRequirements())),
  get('/api/state', ({ ui }) => json(ui.fullState())),
  get('/api/plugins', async ({ extraKeys }) => json(await extraKeys.pluginsInfo())),
  get('/api/settings', ({ settings }) => json(JSON.parse(settings.json()))),

  ...(__MOCK_BUILD__
    ? [
        postJson('/api/driver-mode', setDriverMode),
        postJson('/api/mock-config', setMockConfig),
        postJson('/api/device-model', setDeviceModel, 'invalid request'),
        post('/api/mock/extra-key/:wireId', ({ ui, params }) =>
          simulate(ui, { kind: 'extraKey', wireId: Number(params.wireId) }),
        ),
        post('/api/mock/dial', async ({ ui, req }) =>
          simulate(ui, { kind: 'dial', event: await bodyOrUndefined(req) }),
        ),
        post('/api/mock/touch', async ({ ui, req }) =>
          simulate(ui, { kind: 'touch', event: await bodyOrUndefined(req) }),
        ),
      ]
    : []),
  post('/api/key/:n', ({ ui, params }) => {
    const err = ui.trySimulateKey(Number(params.n));
    return err ? json({ error: err.error }, err.status) : noContent();
  }),
  postJson('/api/webui-key-press', setWebuiKeyPress),
  postJson('/api/brightness', setBrightness),
  postJson('/api/brightness-override', setBrightnessOverride),
  postJson('/api/select-dock', selectDock),
  postJson('/api/extra-key', setExtraKey),
  postJson('/api/extra-key/run', runExtraKeyNow),
  postJson('/api/extra-key/preview', previewExtraKey),
  postJson('/api/extra-key/press', setExtraKeyPress),
  ...pushAdminRoutes,
  ...virtualDeckRoutes,
  ...pairingAddressRoutes,
  postJson('/api/touch-strip-mode', setTouchStripMode),
  postJson('/api/touch-strip-repaint', setTouchStripRepaint),
  postJson('/api/encoders', setEncoders),
  post('/api/settings', setSettings),
  post('/api/settings/open-in-os', async ({ settings }) => {
    await settings.openFile();
    return json({ ok: true });
  }),
  postJson('/api/device-identity/mdns-name', setDeviceMdnsName),
  postJson('/api/log-level', setLogLevelRoute),
  postJson('/api/multi-deck', setMultiDeckRoute),
  postJson('/api/browser-locale', setBrowserLocaleRoute),
  post('/api/logs/open-in-os', async ({ logging }) => {
    await logging.openFolder();
    return json({ ok: true });
  }),

  get('/api/device-overrides', ({ modelOverrides, url }) => {
    const modelId = url.searchParams.get('modelId') ?? undefined;
    const view = modelOverrides.view(modelId);
    return 'error' in view ? json({ error: view.error }, view.status) : json(view);
  }),
  postJson('/api/device-overrides', setDeviceOverrides),
  postJson('/api/device-overrides/reset', resetDeviceOverrides),

  get('/api/update', ({ updates }) => json(updates.info())),
  post('/api/update/check', async ({ updates }) => json(await updates.check(true))),
  postJson('/api/update/dismiss', dismissUpdate),
  postJson('/api/update-check-enabled', setUpdateCheckEnabled),

  postJson('/api/elgato-auto-restart', setElgatoAutoRestart),
  get('/api/standby', ({ standby }) => json(standby.view())),
  postJson('/api/standby', setStandby),
  get('/api/elgato-app/status', async ({ elgatoApp }) => json(await elgatoApp.status())),
  post('/api/elgato-app/restart', async ({ elgatoApp }) => json(await elgatoApp.restartNow())),

  // text/plain, not JSON: the report is meant to be pasted verbatim into an issue.
  get('/api/diagnostics', async ({ logging, url }) => {
    const redact = url.searchParams.get('redactCommands') === '1';
    return text(await logging.buildReport({ redactCommands: redact }));
  }),
  post('/api/diagnostics/save', saveDiagnostics),
];

/** Persist one model's device tuning. A validation failure returns the whole
 *  error list so the UI can show every bad field at once. */
function setDeviceOverrides(
  body: { modelId?: unknown; overrides?: unknown },
  { modelOverrides }: RouteContext,
): Response {
  const r = modelOverrides.trySet(body.modelId, body.overrides ?? {});
  if ('error' in r) return json({ error: r.error }, r.status);
  // An image-only change is swapped into the running session and the deck is
  // repainted; keyMap/wire/splash need the next open(), so the session reopens
  // and the UI shows a brief "reapplying…" state on this flag.
  return json({ ok: true, reconnecting: r.kind === 'reopen' });
}

function resetDeviceOverrides(
  { modelId }: { modelId: unknown },
  { modelOverrides }: RouteContext,
): Response {
  const r = modelOverrides.tryReset(modelId);
  if ('error' in r) return json({ error: r.error }, r.status);
  return json({ ok: true, reconnecting: r.kind === 'reopen' });
}

/** Write the report next to settings.json and reveal it in the OS file manager —
 *  the path for users who would rather attach a file than paste text. */
async function saveDiagnostics({ req, logging }: RouteContext): Promise<Response> {
  let redactCommands = false;
  try {
    const raw = await req.text();
    if (raw) ({ redactCommands = false } = JSON.parse(raw) as { redactCommands?: boolean });
  } catch {
    return badRequest('invalid JSON');
  }
  const path = await logging.saveReport({ redactCommands });
  return path ? json({ ok: true, path }) : json({ error: 'could not write report' }, 500);
}

/** WebUI "Check for updates" close-button: remembers the version so the badge
 *  doesn't reappear until a newer one ships. */
function dismissUpdate({ version }: { version: unknown }, { updates }: RouteContext): Response {
  if (typeof version !== 'string' || !version)
    return badRequest('version must be a non-empty string');
  return json(updates.dismiss(version));
}

/** WebUI "Check for updates" toggle (opt-out; settings.json `updateCheck`). */
function setUpdateCheckEnabled(
  { enabled }: { enabled: unknown },
  { updates }: RouteContext,
): Response {
  if (typeof enabled !== 'boolean') return badRequest('enabled must be a boolean');
  updates.setEnabled(enabled);
  return json({ ok: true, enabled });
}

/** WebUI "Elgato app" panel toggle + grace-delay field (settings.json
 *  `elgatoAutoRestart`/`elgatoAutoRestartDelayS`). An omitted `delayS` leaves
 *  the persisted delay untouched — see PersistedSettings.setElgatoAutoRestart. */
function setElgatoAutoRestart(
  { enabled, delayS }: { enabled: unknown; delayS?: unknown },
  { elgatoApp }: RouteContext,
): Response {
  if (typeof enabled !== 'boolean') return badRequest('enabled must be a boolean');
  if (delayS !== undefined && typeof delayS !== 'number') {
    return badRequest('delayS must be a number');
  }
  elgatoApp.set(enabled, delayS);
  const state = elgatoApp.state();
  return json({ ok: true, enabled: state.enabled, delayS: state.delayS });
}

/** WebUI "Debug logging" toggle. Levels are validated against cli.ts's LOG_LEVELS
 *  (the single source of truth, shared with --log-level and settings.json). */
function setLogLevelRoute({ level }: { level: unknown }, { logging }: RouteContext): Response {
  const err = logging.trySetLevel(level);
  return err ? json({ error: err.error }, err.status) : json({ ok: true, level });
}

/** WebUI "Use two decks at once" toggle. Disabling it also disconnects a live
 *  second dock (DriverManager.setMultiDeck). */
function setMultiDeckRoute(
  { enabled }: { enabled: unknown },
  { settingsFile }: RouteContext,
): Response {
  if (typeof enabled !== 'boolean') return badRequest('enabled must be a boolean');
  settingsFile.setMultiDeck(enabled);
  return json({ ok: true, enabled });
}

/** WebUI Settings "Click to press" opt-in. */
function setWebuiKeyPress({ enabled }: { enabled: unknown }, { settings }: RouteContext): Response {
  if (typeof enabled !== 'boolean') return badRequest('enabled must be a boolean');
  settings.setWebuiKeyPress(enabled);
  return json({ ok: true, enabled });
}

/** Browser's `navigator.language`, sent once on WebUI load. Fallback for
 *  daily-ping.ts's locale dim when the OS-level probe fails. Length-capped —
 *  same reasoning as daily-ping.ts's other closed-vocabulary fields: an
 *  unbounded string is an unbounded fingerprint, not just an unbounded key. */
function setBrowserLocaleRoute(
  { locale, timeZone }: { locale: unknown; timeZone?: unknown },
  { settings }: RouteContext,
): Response {
  if (typeof locale !== 'string' || !locale || locale.length > 35)
    return badRequest('locale must be a non-empty string of at most 35 characters');
  if (timeZone !== undefined && (typeof timeZone !== 'string' || timeZone.length > 64))
    return badRequest('timeZone must be a string of at most 64 characters');
  settings.browserLocale = locale;
  settings.browserTimeZone = timeZone || undefined;
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
  expire?: unknown;
  fallbackText?: unknown;
  style?: unknown;
}

/** Field validation for POST /api/extra-key; returns an error message or null. */
function extraKeyBodyError(body: ExtraKeyBody): string | null {
  if (!isNonNegInt(body.wireId)) return nonNegIntMessage('wireId');
  return extraKeyConfigError(body);
}

/** Assign a display widget to one of the selected dock's extra keys (293S 6th
 *  column, AKP05E right column). The server renders and refreshes the key itself. */
function setExtraKey(body: ExtraKeyBody, { extraKeys }: RouteContext): Response {
  const invalid = extraKeyBodyError(body);
  if (invalid) return badRequest(invalid);
  const { wireId, widget, param, intervalMs, timeoutMs, pluginArg, expire, fallbackText } = body;
  const style = body.style === undefined ? {} : compactTextStyle(body.style as ExtraKeyTextStyle);
  const cfg: ExtraKeyConfig = {
    widget: widget as ExtraKeyWidget,
    ...(typeof param === 'string' && param ? { param } : {}),
    ...(typeof intervalMs === 'number' ? { intervalMs } : {}),
    ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
    ...(typeof pluginArg === 'string' && pluginArg ? { pluginArg } : {}),
    ...(typeof expire === 'string' ? { expire: expire as ExternalExpire } : {}),
    ...(typeof fallbackText === 'string' && fallbackText ? { fallbackText } : {}),
    ...(Object.keys(style).length > 0 ? { style } : {}),
  };
  const err = extraKeys.trySet(wireId as number, cfg);
  return err ? json({ error: err.error }, err.status) : json({ ok: true, wireId, widget });
}

interface RunExtraKeyBody {
  wireId: unknown;
}

/** Force an immediate re-run of a command-widget extra key (WebUI "Run now"). */
function runExtraKeyNow({ wireId }: RunExtraKeyBody, { extraKeys }: RouteContext): Response {
  if (!isNonNegInt(wireId)) return badRequest(nonNegIntMessage('wireId'));
  const err = extraKeys.tryRunNow(wireId);
  return err ? json({ error: err.error }, err.status) : json({ ok: true });
}

/** Text-size picker: the widget's last paint rendered at every text size (nothing saved). */
function previewExtraKey({ wireId }: RunExtraKeyBody, { extraKeys }: RouteContext): Response {
  if (!isNonNegInt(wireId)) return badRequest(nonNegIntMessage('wireId'));
  const res = extraKeys.tryPreview(wireId);
  return 'error' in res ? json({ error: res.error }, res.status) : json(res);
}

/** A pressable extra key's press side: the shell command it runs ('' clears it) and/or
 *  its action (refresh / command / both); an omitted field is kept. Separate from the
 *  widget POST so neither overwrites the other. */
function setExtraKeyPress(
  { wireId, command, action }: { wireId: unknown; command: unknown; action: unknown },
  { extraKeys }: RouteContext,
): Response {
  if (!isNonNegInt(wireId)) return badRequest(nonNegIntMessage('wireId'));
  if (command === undefined && action === undefined) {
    return badRequest('command or action is required');
  }
  if (
    command !== undefined &&
    (typeof command !== 'string' || command.length > ENCODER_COMMAND_MAX)
  ) {
    return badRequest(`command must be a string ≤ ${ENCODER_COMMAND_MAX} chars`);
  }
  if (action !== undefined && !isOneOf(EXTRA_KEY_PRESS_ACTIONS, action)) {
    return badRequest(`action must be one of: ${EXTRA_KEY_PRESS_ACTIONS.join(', ')}`);
  }
  const err = extraKeys.trySet(wireId, {
    ...(command !== undefined ? { pressCommand: command } : {}),
    ...(action !== undefined ? { pressAction: action } : {}),
  });
  return err ? json({ error: err.error }, err.status) : json({ ok: true });
}

/** Who paints the touch strip: the Elgato app only, or DeckBridge widgets over it. */
function setTouchStripMode({ mode }: { mode: unknown }, { devicePrefs }: RouteContext): Response {
  if (!isOneOf(TOUCH_STRIP_MODES, mode)) {
    return badRequest(`mode must be one of: ${TOUCH_STRIP_MODES.join(', ')}`);
  }
  const err = devicePrefs.trySetTouchStripMode(mode);
  return err ? json({ error: err.error }, err.status) : json({ ok: true, mode });
}

/** How long after the Elgato app's last strip frame 'deckbridge-repaint' brings a widget back. */
function setTouchStripRepaint({ ms }: { ms: unknown }, { devicePrefs }: RouteContext): Response {
  if (!isTouchStripRepaintMs(ms)) {
    return badRequest(
      `ms must be an integer ${TOUCH_STRIP_REPAINT_MIN_MS}–${TOUCH_STRIP_REPAINT_MAX_MS}`,
    );
  }
  const err = devicePrefs.trySetTouchStripRepaintMs(ms);
  return err ? json({ error: err.error }, err.status) : json({ ok: true, ms });
}

/** Knob override: connect to the Elgato app, or run per-knob shell commands. */
function setEncoders(body: unknown, { encoders }: RouteContext): Response {
  const invalid = encoderSettingsError(body);
  if (invalid) return badRequest(invalid);
  const { connectToApp, commands } = body as EncoderSettings;
  const err = encoders.trySet({
    ...(connectToApp !== undefined ? { connectToApp } : {}),
    ...(commands !== undefined ? { commands } : {}),
  });
  return err ? json({ error: err.error }, err.status) : json({ ok: true });
}

function setStandby(body: unknown, { standby }: RouteContext): Response {
  const r = standby.trySet(body);
  return 'error' in r ? json({ error: r.error }, r.status) : json(r.view);
}

function simulate(ui: RouteContext['ui'], raw: RawMockInput): Response {
  const err = ui.trySimulateInput(raw);
  return err ? json({ error: err.error }, err.status) : noContent();
}

/** Malformed JSON becomes a shape error from checkMockInput, after its mock-mode 404. */
async function bodyOrUndefined(req: Request): Promise<unknown> {
  const parsed = await readJson<unknown>(req);
  return 'error' in parsed ? undefined : parsed.body;
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

function setBrightnessOverride(
  { enabled }: { enabled: unknown },
  { devicePrefs }: RouteContext,
): Response {
  if (typeof enabled !== 'boolean') return badRequest('enabled must be a boolean');
  devicePrefs.setBrightnessOverride(enabled);
  return json({ ok: true, enabled: devicePrefs.brightnessOverride });
}

function setMockConfig(body: Partial<MockDeviceConfig>, { ui }: RouteContext): Response {
  return json({ ok: true, mockConfig: ui.applyMockConfig(body) });
}

const MDNS_NAME_MAX_LEN = 63; // sane cap — dns-sd/avahi service instance names aren't unbounded

function setDeviceMdnsName(
  { deviceKey, name }: { deviceKey: unknown; name: unknown },
  { ui, settings }: RouteContext,
): Response {
  if (typeof deviceKey !== 'string' || !deviceKey) {
    return badRequest('deviceKey must be a non-empty string');
  }
  if (typeof name !== 'string' || !name.trim()) {
    return badRequest('name must be a non-empty string');
  }
  const trimmed = name.trim().slice(0, MDNS_NAME_MAX_LEN);
  if (!settings.updateMdnsName(deviceKey, trimmed)) {
    return json({ error: `no persisted identity for deviceKey ${deviceKey}` }, 404);
  }
  // Persisted; app.ts re-advertises the live dock under the new name.
  ui.emit('mdnsNameChanged', deviceKey, trimmed);
  return json({ ok: true, name: trimmed });
}

async function setSettings({ req, settings, settingsFile }: RouteContext): Promise<Response> {
  const raw = await req.text();
  try {
    settingsFile.applyJson(raw);
  } catch (e) {
    return badRequest((e as Error).message || 'invalid settings');
  }
  return json({ ok: true, settings: JSON.parse(settings.json()) as unknown });
}
