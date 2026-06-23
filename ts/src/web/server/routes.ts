import { assets } from './assets.js';
import { checkRequirements } from './requirements.js';
import { get, post } from './router.js';
import type { Route, RouteContext } from './router.js';
import { badRequest, css, html, jpeg, js, json, noContent, notFound } from './http.js';
import type { MockDeviceConfig } from './types.js';
import type { ImageModeOverride } from '../../types.js';

// The complete HTTP surface, declarative. WebSocket upgrade (/api/ws) is handled
// before dispatch in WebUIServer; everything else lives here.
export const routes: Route[] = [
  get('/', () => html(assets.html)),
  get('/ui.css', () => css(assets.css)),
  get('/ui.js', () => js(assets.js)),
  get('/requirements', () => html(assets.requirementsHtml)),
  get('/api/requirements', async () => json(await checkRequirements())),
  get('/api/state', ({ ui }) => json(ui.fullState())),
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
];

async function setBrightness({ req, ui }: RouteContext): Promise<Response> {
  let level: unknown;
  try {
    ({ level } = JSON.parse(await req.text()) as { level: unknown });
  } catch {
    return badRequest('invalid JSON');
  }
  if (typeof level !== 'number' || level < 0 || level > 100 || !Number.isFinite(level)) {
    return badRequest('level must be a number 0–100');
  }
  const rounded = Math.round(level);
  ui.emit('setBrightness', rounded);
  ui.notifyBrightness(rounded);
  return json({ ok: true, level: rounded });
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
