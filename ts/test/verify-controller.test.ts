import assert from 'tjs:assert';
import { VerifyController, VERIFY_LEASE_MS } from '../src/web/server/verify-controller.js';
import { ModelOverridesController } from '../src/web/server/model-overrides-controller.js';
import type { ControllerHost, ReqError } from '../src/web/server/types.js';
import { WebUIServer } from '../src/web/server/web-ui-server.js';
import { routes } from '../src/web/server/routes.js';
import { matchRoute } from '../src/web/server/router.js';
import { PersistedSettings } from '../src/infra/settings.js';
import { findModelById } from '../src/devices/registry.js';
import type { DeviceModelOverride } from '../src/devices/driver.js';
import type { DockStatus } from '../src/shared/types.js';
import { VIRTUAL_DOCK_INDEX } from '../src/shared/types.js';
import type {
  VerifyEndedMsg,
  VerifySpec,
  VerifySpecResponse,
  VerifyStartResponse,
} from '../src/web/contract-verify.js';
import { testAsync as test, summaryExit } from './helpers/harness.js';
import { FakeClock } from './helpers/fake-standby-clock.js';
import { DOCK_IDENTITY } from './helpers/dock-fixture.js';
import { SOLID_RED_16X16_JPEG } from './helpers/fixtures.js';

console.log('\nverify-controller');

// Untested, sidecar, MK.2 profile (293V3 board): wire ids 1-based, column-flipped rows.
const UNTESTED = 'ajazz-akp153r-rev2';
// Untested AKP05 clone: re-paired as a Stream Deck + (8 CORA keys on a 10-key panel).
const PLUS_CLONE = 'mirabox-n4';
const JPEG = SOLID_RED_16X16_JPEG.toString('base64');
const ROOT = `${tjs.tmpDir}/verify-controller-test-${tjs.pid}`;
let roots = 0;

function dock(index: number, modelId: string, extra: Partial<DockStatus> = {}): DockStatus {
  return {
    index,
    modelId,
    modelName: modelId,
    keyCount: 15,
    columns: 5,
    rows: 3,
    primaryPort: 5343 + index * 2,
    primaryConnected: true,
    elgatoConnected: true,
    brightness: 100,
    ...DOCK_IDENTITY,
    tested: false,
    ...extra,
  };
}

interface SetupOpts {
  docks?: DockStatus[];
  persisted?: Record<string, DeviceModelOverride>;
  frames?: boolean;
}

function setup(o: SetupOpts = {}) {
  const settings = new PersistedSettings(`${ROOT}/${++roots}`);
  for (const [id, ov] of Object.entries(o.persisted ?? {})) settings.setModelOverride(id, ov);
  const emits: unknown[][] = [];
  const ended: VerifyEndedMsg[] = [];
  let published = 0;
  const host: ControllerHost = {
    settings,
    emit: (event: string, ...args: unknown[]) => {
      emits.push([event, ...args]);
      return true;
    },
    broadcast: (event, data) => {
      if (event === 'verifyEnded') ended.push(data as VerifyEndedMsg);
    },
    selectedDeviceKey: () => '',
    selectedDock: () => 0,
    selectedDockStatus: () => undefined,
    trySelectDock: () => null,
    broadcastSelected: () => {},
    publishStatus: () => {
      published++;
    },
  };
  const docks = o.docks ?? [dock(0, UNTESTED)];
  const clock = new FakeClock();
  const overrides = new ModelOverridesController(host, () => UNTESTED);
  const verify = new VerifyController(host, overrides, () => docks, clock);
  verify.configure({ hasAppFrames: () => o.frames ?? true });
  const names = (): unknown[] => emits.map(([event]) => event);
  return { verify, settings, emits, ended, clock, docks, names, published: () => published };
}

function started(verify: VerifyController, index = 0): VerifyStartResponse {
  const r = verify.start(index);
  if ('error' in r) throw new Error(`start failed: ${r.error}`);
  return r;
}

const statusOf = (r: object | null): number | undefined => (r as ReqError | null)?.status;

function specOf(r: VerifySpecResponse): VerifySpec {
  if (!r.ok) throw new Error(`unavailable: ${r.reason}`);
  return r.spec;
}

// availability

await test('unavailable reasons: no-device, virtual, passthrough, safe-mode, busy', () => {
  const h = setup({
    docks: [
      dock(0, UNTESTED),
      dock(1, 'mk2'),
      dock(2, 'mini'),
      dock(VIRTUAL_DOCK_INDEX, 'browser-deck-mk2', { virtualClients: 1 }),
    ],
  });
  const reason = (i: number) => {
    const r = h.verify.spec(i);
    return r.ok ? 'ok' : r.reason;
  };
  assert.equal(reason(0), 'ok');
  assert.equal(reason(1), 'passthrough', 'MK.2 sends the app JPEG as-is');
  assert.equal(reason(2), 'passthrough', 'Mini forwards the app BMP as-is');
  assert.equal(reason(VIRTUAL_DOCK_INDEX), 'virtual');
  assert.equal(reason(7), 'no-device');
  started(h.verify, 0);
  assert.equal(reason(0), 'busy');
  const again = h.verify.start(0);
  assert.equal(statusOf(again), 409);
  assert.equal((again as { reason?: string }).reason, 'busy');
  const passthrough = h.verify.start(1);
  assert.equal(statusOf(passthrough), 400);
  assert.equal((passthrough as { reason?: string }).reason, 'passthrough');
  assert.equal(statusOf(h.verify.start(-1)), 400, 'dockIndex is validated');
});

await test('a second dock of the same model is busy too (drafts are keyed by model id)', () => {
  const h = setup({ docks: [dock(0, UNTESTED), dock(1, UNTESTED)] });
  started(h.verify, 0);
  const r = h.verify.spec(1);
  assert.ok(!r.ok && r.reason === 'busy');
});

await test('safe mode: the persisted override is ignored, sidecar models say safe-mode', () => {
  const h = setup({ docks: [dock(0, UNTESTED), dock(1, 'mk2')] });
  tjs.env.DECKBRIDGE_NO_OVERRIDES = '1';
  try {
    const r = h.verify.spec(0);
    assert.ok(!r.ok && r.reason === 'safe-mode');
    const mk2 = h.verify.spec(1);
    assert.ok(!mk2.ok && mk2.reason === 'passthrough', 'passthrough is reported first');
    assert.equal(statusOf(h.verify.start(0)), 400);
  } finally {
    delete tjs.env.DECKBRIDGE_NO_OVERRIDES;
  }
});

// spec

await test('spec: advertised MK.2 grid, P, effective image + splash, dense wire map', () => {
  const h = setup({
    docks: [dock(0, UNTESTED, { tested: false })],
    persisted: { [UNTESTED]: { image: { rotate: 90, quality: 0.8 } } },
    frames: false,
  });
  const spec = specOf(h.verify.spec(0));
  assert.equal(spec.modelId, UNTESTED);
  assert.equal(spec.tested, false);
  assert.deepEqual([spec.rows, spec.columns, spec.keyCount], [3, 5, 15]);
  assert.deepEqual(spec.sourceSize, { width: 72, height: 72 }, 'the MK.2 key size, not the panel');
  assert.deepEqual([spec.extraKeys, spec.encoders, spec.touchStrip], [0, 0, false]);
  assert.deepEqual(spec.frameOrientation, { rotate: 180, flipH: false });
  assert.equal(spec.image.rotate, 90, 'persisted override applied');
  assert.equal(spec.image.quality, 0.8);
  assert.equal(spec.image.width, 112, 'registry value kept');
  assert.deepEqual(spec.coraToWireImage, [11, 12, 13, 14, 15, 6, 7, 8, 9, 10, 1, 2, 3, 4, 5]);
  assert.deepEqual(spec.splash, { rotate: 180, flipH: false, flipV: false });
  assert.equal(spec.hasAppFrames, false);
  assert.equal(spec.appVersion, __VERSION__);
});

await test('spec: an AKP05 clone advertises the Stream Deck + grid (8 keys, P = identity)', () => {
  const h = setup({ docks: [dock(0, PLUS_CLONE)] });
  const spec = specOf(h.verify.spec(0));
  assert.deepEqual([spec.rows, spec.columns, spec.keyCount], [2, 4, 8]);
  assert.deepEqual(spec.sourceSize, { width: 120, height: 120 });
  assert.deepEqual(spec.frameOrientation, { rotate: 0, flipH: false });
  assert.deepEqual(spec.coraToWireImage, [11, 12, 13, 14, 6, 7, 8, 9]);
  assert.deepEqual(
    [spec.extraKeys, spec.encoders, spec.touchStrip],
    [2, 4, true],
    'the right column stays DeckBridge keys; dials and strip come from the Plus profile',
  );
});

await test('spec: the AKP05E and a 293S-type deck report their extra keys', () => {
  const h = setup({ docks: [dock(0, 'ajazz-akp05e'), dock(1, 'ajazz-akp153')] });
  const plus = specOf(h.verify.spec(0));
  assert.deepEqual(
    [plus.keyCount, plus.extraKeys, plus.encoders, plus.touchStrip],
    [8, 2, 4, true],
  );
  const s293 = specOf(h.verify.spec(1));
  assert.deepEqual(
    [s293.keyCount, s293.extraKeys, s293.encoders, s293.touchStrip],
    [15, 3, 0, false],
  );
});

// session + lease

await test('start holds the dock; the lease expires after 30 s of silence', () => {
  const h = setup();
  const { token, leaseMs } = started(h.verify);
  assert.equal(leaseMs, VERIFY_LEASE_MS);
  assert.ok(/^[0-9a-f]{32}$/.test(token), 'a 128-bit hex token');
  assert.deepEqual(h.emits, [['verifyHold', 0, true, false]]);
  h.clock.advance(VERIFY_LEASE_MS - 1);
  assert.deepEqual(h.verify.keepalive(token), { ok: true, leaseMs: VERIFY_LEASE_MS });
  h.clock.advance(VERIFY_LEASE_MS - 1);
  assert.equal(h.ended.length, 0, 'keepalive renewed the lease');
  h.clock.advance(1);
  assert.deepEqual(h.ended, [{ dockIndex: 0, reason: 'lease' }]);
  assert.deepEqual(h.emits.at(-1), ['verifyHold', 0, false, true], 'end path: hold off + repaint');
  assert.equal(statusOf(h.verify.keepalive(token)), 410);
  assert.equal(statusOf(h.verify.paint(token, [])), 410);
  assert.ok(h.verify.spec(0).ok, 'the dock is free again');
});

await test('paint and draft renew the lease too', () => {
  const h = setup();
  const { token } = started(h.verify);
  h.clock.advance(VERIFY_LEASE_MS - 1);
  assert.equal(h.verify.paint(token, [{ key: 0, data: JPEG }]), null);
  h.clock.advance(VERIFY_LEASE_MS - 1);
  assert.equal(h.verify.draft(token, { rotate: 90 }), null);
  h.clock.advance(VERIFY_LEASE_MS - 1);
  assert.equal(h.ended.length, 0);
});

await test('paint: decoded JPEGs to the held dock; bad keys and data are 400', () => {
  const h = setup();
  const { token } = started(h.verify);
  assert.equal(h.verify.paint(token, [{ key: 14, data: JPEG }]), null);
  const [event, index, keys] = h.emits.at(-1) as [
    string,
    number,
    { key: number; bytes: Uint8Array }[],
  ];
  assert.equal(event, 'verifyPaint');
  assert.equal(index, 0);
  assert.equal(keys[0]!.key, 14);
  assert.deepEqual(Array.from(keys[0]!.bytes), Array.from(SOLID_RED_16X16_JPEG));
  assert.equal(statusOf(h.verify.paint(token, [{ key: 15, data: JPEG }])), 400, 'past keyCount');
  assert.equal(statusOf(h.verify.paint(token, [{ key: 0, data: 'Qk0=' }])), 400, 'not a JPEG');
  assert.equal(statusOf(h.verify.paint(token, [{ key: 0, data: '%%%' }])), 400, 'not base64');
  const big = Buffer.alloc(64 * 1024 + 1);
  big[0] = 0xff;
  big[1] = 0xd8;
  assert.equal(statusOf(h.verify.paint(token, [{ key: 0, data: big.toString('base64') }])), 400);
  const many = Array.from({ length: 16 }, () => ({ key: 0, data: JPEG }));
  assert.equal(statusOf(h.verify.paint(token, many)), 400, 'more entries than keys');
  assert.equal(statusOf(h.verify.paint('nope', [])), 410);
});

// drafts

await test('draft: validated over the persisted override, applied live, never persisted', async () => {
  const h = setup({ persisted: { [UNTESTED]: { image: { quality: 0.8 } } } });
  await h.settings.flush();
  const before = h.settings.json();
  const { token } = started(h.verify);
  assert.equal(h.verify.draft(token, { rotate: 270, flipH: true }), null);
  assert.deepEqual(h.emits.at(-1), ['verifyDraft', UNTESTED]);
  assert.deepEqual(h.verify.draftOverride(UNTESTED), {
    image: { quality: 0.8, rotate: 270, flipH: true },
  });
  assert.equal(h.verify.draftOverride('mirabox-293'), undefined, 'another model has no draft');
  assert.equal(h.settings.json(), before, 'settings untouched');
  assert.deepEqual(h.settings.overrideFor(UNTESTED), { image: { quality: 0.8 } });
  // A new draft replaces the old one instead of merging into it.
  assert.equal(h.verify.draft(token, { width: 100 }), null);
  assert.deepEqual(h.verify.draftOverride(UNTESTED), { image: { quality: 0.8, width: 100 } });
  assert.equal(statusOf(h.verify.draft(token, { rotate: 45 })), 400, 'invalid value');
  assert.equal(statusOf(h.verify.draft(token, { crop: 2 })), 400, 'not a wizard field');
  assert.equal(statusOf(h.verify.draft(token, 'rotate')), 400);
  assert.deepEqual(h.verify.draftOverride(UNTESTED), { image: { quality: 0.8, width: 100 } });
  await h.settings.flush();
  assert.equal(h.settings.json(), before);
});

await test('cancel: draft dropped, persisted re-applied live, then hold off + repaint; idempotent', () => {
  const h = setup();
  const { token } = started(h.verify);
  h.verify.draft(token, { rotate: 90 });
  h.emits.length = 0;
  h.verify.end(token);
  assert.equal(h.verify.draftOverride(UNTESTED), undefined);
  assert.deepEqual(h.emits, [
    ['verifyDraft', UNTESTED],
    ['verifyHold', 0, false, true],
  ]);
  assert.deepEqual(h.ended, [{ dockIndex: 0, reason: 'cancelled' }]);
  h.verify.end(token);
  h.verify.end('unknown');
  assert.equal(h.emits.length, 2, 'a second end does nothing');
  assert.equal(h.clock.pending(), 0, 'the lease timer is gone');
});

await test('cancel without a draft skips the live re-apply', () => {
  const h = setup();
  const { token } = started(h.verify);
  h.verify.end(token);
  assert.deepEqual(h.names(), ['verifyHold', 'verifyHold']);
});

// save

await test('save: persisted ⊕ body, arrays replaced wholesale; hold off without repaint', async () => {
  const wireInputToCora = [-1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
  const h = setup({
    persisted: {
      [UNTESTED]: {
        image: { quality: 0.8 },
        keyMap: {
          coraToWireImage: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
          wireInputToCora,
        },
      },
    },
  });
  const { token } = started(h.verify);
  h.verify.draft(token, { rotate: 90 });
  h.emits.length = 0;
  const map = [5, 4, 3, 2, 1, 10, 9, 8, 7, 6, 15, 14, 13, 12, 11];
  const r = h.verify.save({
    token,
    image: { rotate: 90 },
    coraToWireImage: map,
    splash: { rotate: 270, flipH: false, flipV: false },
  });
  assert.deepEqual(r, { ok: true, reconnecting: true }, 'keyMap/splash need a reopen');
  assert.deepEqual(h.settings.overrideFor(UNTESTED), {
    image: { quality: 0.8, rotate: 90 },
    keyMap: { coraToWireImage: map, wireInputToCora },
    splash: { transformOverride: { rotate: 270, flipH: false, flipV: false } },
  });
  assert.deepEqual(h.emits, [
    ['verifyHold', 0, false, false],
    ['modelOverridesChanged', UNTESTED, 'reopen'],
  ]);
  assert.deepEqual(h.ended, [{ dockIndex: 0, reason: 'saved' }]);
  assert.equal(h.verify.draftOverride(UNTESTED), undefined);
  assert.deepEqual(h.settings.verifyDismissed, [UNTESTED], 'saving also dismisses the offer');
  assert.equal(statusOf(h.verify.keepalive(token)), 410);
  await h.settings.flush();
});

await test('save of an image-only change is live; an unchanged save repaints itself', () => {
  const live = setup();
  const a = started(live.verify);
  live.emits.length = 0;
  assert.deepEqual(live.verify.save({ token: a.token, image: { maxBytes: 8192 } }), {
    ok: true,
    reconnecting: false,
  });
  assert.deepEqual(live.emits, [
    ['verifyHold', 0, false, false],
    ['modelOverridesChanged', UNTESTED, 'live'],
  ]);

  const same = setup();
  const b = started(same.verify);
  same.verify.draft(b.token, { rotate: 90 });
  same.emits.length = 0;
  assert.deepEqual(same.verify.save({ token: b.token }), { ok: true, reconnecting: false });
  assert.deepEqual(same.emits, [
    ['verifyDraft', UNTESTED],
    ['verifyHold', 0, false, true],
    ['modelOverridesChanged', UNTESTED, 'none'],
  ]);
});

await test('an invalid save is a 400 and the session lives on', () => {
  const h = setup();
  const { token } = started(h.verify);
  assert.equal(statusOf(h.verify.save({ token, coraToWireImage: [1, 2, 3] })), 400, 'short map');
  assert.equal(statusOf(h.verify.save({ token, image: { blur: 1 } })), 400, 'not a wizard field');
  assert.equal(statusOf(h.verify.save({ token, splash: { rotate: 45 } })), 400);
  assert.deepEqual(h.verify.keepalive(token), { ok: true, leaseMs: VERIFY_LEASE_MS });
  assert.equal(h.settings.overrideFor(UNTESTED), undefined);
});

await test('save keeps the registry splash fields the override section would otherwise drop', () => {
  const model = findModelById(UNTESTED)!;
  const h = setup();
  const { token } = started(h.verify);
  h.verify.save({ token, splash: { rotate: 270, flipH: true, flipV: false } });
  assert.deepEqual(h.settings.overrideFor(UNTESTED)?.splash, {
    ...model.splash,
    transformOverride: { rotate: 270, flipH: true, flipV: false },
  });
});

await test('save: an AKP05 clone takes an 8-entry (advertised grid) key map', () => {
  const h = setup({ docks: [dock(0, PLUS_CLONE)] });
  const { token } = started(h.verify);
  const map = [6, 7, 8, 9, 11, 12, 13, 14];
  assert.deepEqual(h.verify.save({ token, coraToWireImage: map }), {
    ok: true,
    reconnecting: true,
  });
  assert.deepEqual(h.settings.overrideFor(PLUS_CLONE)?.keyMap, { coraToWireImage: map });
});

// detach / model change

await test('the dock vanishing or switching model ends its session as detached', () => {
  const h = setup({ docks: [dock(0, UNTESTED), dock(1, PLUS_CLONE)] });
  started(h.verify, 0);
  const b = started(h.verify, 1);
  h.verify.syncDocks([dock(0, UNTESTED)]);
  assert.deepEqual(h.ended, [{ dockIndex: 1, reason: 'detached' }]);
  assert.equal(statusOf(h.verify.keepalive(b.token)), 410);
  h.verify.syncDocks([dock(0, 'mirabox-293')]);
  assert.deepEqual(h.ended.at(-1), { dockIndex: 0, reason: 'detached' });
  assert.deepEqual(h.emits.at(-1), ['verifyHold', 0, false, true]);
});

// dismiss

await test('dismiss: "not now" is this run only, "never" lands in settings.json', async () => {
  const h = setup();
  assert.equal(h.verify.dismiss(UNTESTED, false), null);
  assert.deepEqual(h.verify.dismissedIds(), [UNTESTED]);
  assert.deepEqual(h.settings.verifyDismissed, [], 'session-only');
  assert.equal(h.published(), 1, 'status re-broadcast');
  assert.equal(h.verify.dismiss(PLUS_CLONE, true), null);
  assert.deepEqual(h.settings.verifyDismissed, [PLUS_CLONE]);
  assert.deepEqual(h.verify.dismissedIds(), [PLUS_CLONE, UNTESTED], 'persisted, then this run');
  assert.equal(h.verify.dismiss(PLUS_CLONE, true), null);
  assert.deepEqual(h.settings.verifyDismissed, [PLUS_CLONE], 'no duplicates');
  assert.equal(statusOf(h.verify.dismiss('nope', true)), 400);
  assert.equal(statusOf(h.verify.dismiss(UNTESTED, 'yes')), 400);
  await h.settings.flush();
  const reloaded = new PersistedSettings(h.settings.cacheRoot);
  await reloaded.load();
  assert.deepEqual(reloaded.verifyDismissed, [PLUS_CLONE], 'only "never" survives a restart');
});

// WebUIServer: routes, status snapshot, settings import

async function call(ui: WebUIServer, method: string, path: string, body?: unknown) {
  const url = new URL(`http://localhost${path}`);
  const matched = matchRoute(routes, method, url.pathname)!;
  const init = body === undefined ? { method } : { method, body: JSON.stringify(body) };
  const req = new Request(url, init);
  const res = await matched.handler(
    Object.assign({}, ui, { req, url, params: matched.params, ui }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

await test('routes: spec/start/keepalive/end status codes and the busy reason', async () => {
  const ui = new WebUIServer(undefined, [], 'real', new PersistedSettings(`${ROOT}/${++roots}`));
  ui.notifyDocks([dock(0, UNTESTED), dock(1, 'mk2')]);
  const spec = await call(ui, 'GET', '/api/verify/spec');
  assert.equal(spec.status, 200);
  assert.equal(spec.body.ok, true, 'no ?dock = the selected dock');
  assert.deepEqual((await call(ui, 'GET', '/api/verify/spec?dock=1')).body, {
    ok: false,
    reason: 'passthrough',
  });
  assert.equal((await call(ui, 'GET', '/api/verify/spec?dock=x')).status, 400);
  const start = await call(ui, 'POST', '/api/verify/start', { dockIndex: 0 });
  assert.equal(start.status, 200);
  const token = start.body.token as string;
  const busy = await call(ui, 'POST', '/api/verify/start', { dockIndex: 0 });
  assert.deepEqual([busy.status, busy.body.reason], [409, 'busy']);
  const unavailable = await call(ui, 'POST', '/api/verify/start', { dockIndex: 1 });
  assert.deepEqual([unavailable.status, unavailable.body.reason], [400, 'passthrough']);
  assert.equal((await call(ui, 'POST', '/api/verify/keepalive', { token })).status, 200);
  assert.equal((await call(ui, 'POST', '/api/verify/paint', { token, keys: [] })).status, 200);
  assert.equal((await call(ui, 'POST', '/api/verify/end', { token })).status, 200);
  assert.equal((await call(ui, 'POST', '/api/verify/end', { token })).status, 200, 'idempotent');
  assert.equal((await call(ui, 'POST', '/api/verify/keepalive', { token })).status, 410);
  assert.equal((await call(ui, 'POST', '/api/verify/draft', { token, image: {} })).status, 410);
  const dismissed = await call(ui, 'POST', '/api/verify/dismiss', {
    modelId: UNTESTED,
    never: false,
  });
  assert.equal(dismissed.status, 200);
  assert.deepEqual(ui.snapshot().verifyDismissed, [UNTESTED], 'in the status snapshot');
  ui.verify.dispose();
});

await test('settings import sanitizes verifyDismissed and export carries it', () => {
  const ui = new WebUIServer(undefined, [], 'real', new PersistedSettings(`${ROOT}/${++roots}`));
  ui.settingsFile.applyJson(
    JSON.stringify({ verifyDismissed: [PLUS_CLONE, 'no-such-model', 5, PLUS_CLONE] }),
  );
  assert.deepEqual(ui.settings.verifyDismissed, [PLUS_CLONE]);
  const exported = JSON.parse(ui.settings.json()) as { verifyDismissed?: string[] };
  assert.deepEqual(exported.verifyDismissed, [PLUS_CLONE]);
  assert.deepEqual(ui.snapshot().verifyDismissed, [PLUS_CLONE]);
});

summaryExit();
