import assert from 'tjs:assert';
import { DemoBackend } from '../src/demo/backend.js';
import { DEVICE_MODELS, findModelById } from '../src/devices/registry.js';
import type { DemoDeck } from '../src/demo/deck.js';
import type { StateResponse, WsEvents } from '../src/web/contract.js';
import { testAsync, summary } from './helpers/harness.js';

function fixture() {
  const timers: { fn: () => void; ms: number }[] = [];
  const backend = new DemoBackend({
    now: () => 123,
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
  });
  const events: { event: keyof WsEvents; data: unknown }[] = [];
  backend
    .openSocket()
    .addEventListener('message', (event) =>
      events.push(JSON.parse(event.data) as { event: keyof WsEvents; data: unknown }),
    );
  return { backend, events, timers };
}

async function hardwareFixture(modelId = 'ajazz-akp05e') {
  const result = fixture();
  const brightness: number[] = [];
  const painted: number[] = [];
  const deck: DemoDeck = {
    kind: 'hw',
    model: findModelById(modelId)!,
    paintKey: (index) => painted.push(index),
    paintStrip: () => undefined,
    setBrightness: (level) => brightness.push(level),
    close: () => Promise.resolve(),
  };
  await result.backend.useDeck(deck);
  return { ...result, deck, brightness, painted, callbacks: result.backend.deckEvents() };
}

await testAsync('state contains hydration fields and starts without device', async () => {
  const { backend } = fixture();
  const state = (await (
    await backend.fetch('https://example.org/api/state?ignored=1')
  ).json()) as StateResponse;
  assert.equal(state.driverConnected, false);
  assert.equal(state.elgatoConnected, false);
  assert.equal(state.selectedDock, 0);
  assert.equal(state.docks.length, 1);
  // eslint-disable-next-line sonarjs/no-hardcoded-ip -- Verify the fictional pairing address.
  assert.equal(state.localIp, '192.168.1.42');
  assert.equal(state.keyPressEnabled, true);
  for (const field of [
    'stats',
    'brightness',
    'brightnessOverride',
    'deviceModels',
    'extraKeys',
    'pages',
    'pageState',
    'touchStripMode',
    'touchStripRepaintMs',
    'encoders',
    'updateInfo',
    'keyEvents',
  ]) {
    assert.ok(field in state, field);
  }
});

await testAsync('survey and unknown paths return 404', async () => {
  const { backend } = fixture();
  assert.equal((await backend.fetch('/api/survey')).status, 404);
  assert.equal((await backend.fetch('/api/nope')).status, 404);
});

await testAsync('mock pairing becomes ready after 800ms and sends status', async () => {
  const { backend, events, timers } = fixture();
  backend.plugIn();
  const response = await backend.fetch('/api/elgato-app/restart', { method: 'POST' });
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(backend.state.elgatoConnected, false);
  assert.equal(timers[0]?.ms, 800);
  timers[0]?.fn();
  assert.equal(backend.state.elgatoConnected, true);
  assert.ok(
    events.some(
      (event) => event.event === 'status' && (event.data as WsEvents['status']).elgatoConnected,
    ),
  );
});

await testAsync('reset cancels pending pairing', async () => {
  const { backend, timers } = fixture();
  backend.plugIn();
  await backend.fetch('/api/elgato-app/restart', { method: 'POST' });
  backend.reset();
  backend.plugIn();
  timers[0]?.fn();
  assert.equal(backend.state.elgatoConnected, false);
});

await testAsync('key clicks send down and up', async () => {
  const { backend, events } = fixture();
  await backend.fetch('/api/key/3', { method: 'POST' });
  assert.deepEqual(
    events.filter((event) => event.event === 'keyEvent').map((event) => event.data),
    [
      { ts: 123, mk2Index: 3, state: 'down' },
      { ts: 123, mk2Index: 3, state: 'up' },
    ],
  );
});

await testAsync('brightness and override echo socket events', async () => {
  const { backend, events } = fixture();
  await backend.fetch('/api/brightness', { method: 'POST', body: JSON.stringify({ level: 42 }) });
  assert.equal(backend.state.brightness, 42);
  assert.ok(
    events.some(
      (event) =>
        event.event === 'brightness' && (event.data as WsEvents['brightness']).level === 42,
    ),
  );
  await backend.fetch('/api/brightness-override', {
    method: 'POST',
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(backend.state.brightnessOverride, false);
});

await testAsync('model changes clear images and reset pairing', async () => {
  const { backend, events } = fixture();
  backend.plugIn();
  await backend.setModel(DEVICE_MODELS[1]!.id);
  assert.equal(backend.state.model.id, DEVICE_MODELS[1]!.id);
  assert.equal(backend.state.plugged, false);
  assert.equal(backend.state.elgatoConnected, false);
  assert.ok(events.some((event) => event.event === 'imagesReset'));
});

await testAsync('hardware AKP05 decks expose grid and strip without settings panels', async () => {
  for (const model of ['ajazz-akp05', 'ajazz-akp05e']) {
    const { backend } = await hardwareFixture(model);
    const state = (await (await backend.fetch('/api/state')).json()) as StateResponse;
    assert.equal(state.driverConnected, true);
    assert.equal(state.elgatoConnected, true);
    assert.equal(state.keyCount, 8);
    assert.equal(state.columns, 4);
    assert.equal(state.pageState.keyCount, 8);
    assert.deepEqual(state.docks[0]?.touchStripSize, { width: 800, height: 100 });
    assert.equal(state.docks[0]?.encoderCount, 4);
    assert.equal(state.docks[0]?.widgetDisplays, undefined);
    assert.equal(state.docks[0]?.extraKeys, undefined);
    assert.equal((await backend.fetch('/api/key/8', { method: 'POST' })).status, 404);
  }
});

await testAsync('three clockwise turns raise knob value to 65 without canvas', async () => {
  const { backend, callbacks, events } = await hardwareFixture();
  assert.equal(typeof OffscreenCanvas, 'undefined');
  for (let count = 0; count < 3; count++) callbacks.dial?.({ kind: 'rotate', index: 1, delta: 1 });
  assert.equal(backend.zones[1]?.value, 65);
  assert.equal(backend.state.activity, 'Knob 2 → 65');
  assert.ok(events.some((event) => event.event === 'status'));
  assert.equal(events.filter((event) => event.event === 'touchImage').length, 0);
});

await testAsync('knob values clamp at both limits', async () => {
  const { backend, callbacks } = await hardwareFixture();
  callbacks.dial?.({ kind: 'rotate', index: 0, delta: 30 });
  assert.equal(backend.zones[0]?.value, 100);
  callbacks.dial?.({ kind: 'rotate', index: 0, delta: -30 });
  assert.equal(backend.zones[0]?.value, 0);
});

await testAsync('knob press changes hue only on down', async () => {
  const { backend, callbacks } = await hardwareFixture();
  const before = backend.zones[2]!.hue;
  callbacks.dial?.({ kind: 'press', index: 2, state: 'down' });
  assert.equal(backend.zones[2]?.hue, (before + 70) % 360);
  callbacks.dial?.({ kind: 'press', index: 2, state: 'up' });
  assert.equal(backend.zones[2]?.hue, (before + 70) % 360);
  assert.equal(backend.zones[2]?.value, 50);
});

await testAsync('strip swipes rotate hues left and right', async () => {
  const { backend, callbacks } = await hardwareFixture();
  callbacks.touch?.({ type: 'swipe', x: 700, y: 50, endX: 100 });
  assert.deepEqual(
    backend.zones.map((zone) => zone.hue),
    [80, 160, 240, 0],
  );
  assert.equal(backend.state.activity, 'Swipe left');
  callbacks.touch?.({ type: 'swipe', x: 100, y: 50, endX: 700 });
  assert.deepEqual(
    backend.zones.map((zone) => zone.hue),
    [0, 80, 160, 240],
  );
  assert.equal(backend.state.activity, 'Swipe right');
});

await testAsync('strip tap flashes only its zone for 200ms', async () => {
  const { backend, callbacks, timers } = await hardwareFixture();
  callbacks.touch?.({ type: 'tap', x: 450, y: 50 });
  assert.deepEqual(
    backend.zones.map((zone) => zone.flash),
    [false, false, true, false],
  );
  assert.equal(backend.state.activity, 'Strip zone 3 tapped');
  assert.equal(timers[0]?.ms, 200);
  timers[0]?.fn();
  assert.equal(backend.zones[2]?.flash, false);
});

await testAsync(
  'changing decks invalidates pending strip flash and pairing callbacks',
  async () => {
    const { backend, callbacks, timers } = await hardwareFixture();
    callbacks.touch?.({ type: 'tap', x: 50, y: 50 });
    const oldFlash = timers[0]!;
    await backend.setModel('mk2');
    backend.plugIn();
    await backend.fetch('/api/elgato-app/restart', { method: 'POST' });
    await backend.setModel('mini');
    backend.plugIn();
    oldFlash.fn();
    timers[1]?.fn();
    assert.equal(backend.state.elgatoConnected, false);
    assert.equal(backend.state.activity, '');
    assert.deepEqual(
      backend.zones.map((zone) => zone.flash),
      [false, false, false, false],
    );
  },
);

await testAsync('mock AKP05 ignores knobs and touch and exposes no strip fields', async () => {
  const { backend, events } = fixture();
  await backend.setModel('ajazz-akp05e');
  const callbacks = backend.deckEvents();
  const before = JSON.stringify(backend.zones);
  const count = events.length;
  callbacks.dial?.({ kind: 'rotate', index: 0, delta: 1 });
  callbacks.touch?.({ type: 'tap', x: 50, y: 50 });
  assert.equal(JSON.stringify(backend.zones), before);
  assert.equal(events.length, count);
  const state = (await (await backend.fetch('/api/state')).json()) as StateResponse;
  assert.equal(state.docks[0]?.touchStripSize, undefined);
  assert.equal(state.docks[0]?.encoderCount, undefined);
  assert.equal(state.docks[0]?.widgetDisplays, undefined);
  assert.equal(state.docks[0]?.extraKeys, undefined);
});

await testAsync('hardware brightness drives the attached deck', async () => {
  const { backend, brightness } = await hardwareFixture();
  await backend.fetch('/api/brightness', { method: 'POST', body: JSON.stringify({ level: 42 }) });
  assert.deepEqual(brightness, [75, 42]);
});

await testAsync('reset stops an in-flight key paint loop', async () => {
  const { backend, painted, events } = await hardwareFixture();
  const pending = backend.paintAll();
  backend.reset();
  const count = painted.length;
  await pending;
  assert.equal(painted.length, count);
  assert.equal(events.filter((event) => event.event === 'image').length, 0);
});

await testAsync('previous hardware callbacks cannot affect a replacement session', async () => {
  const { backend, deck, callbacks: old, events } = await hardwareFixture();
  await backend.setModel('mini');
  await backend.useDeck(deck);
  const current = backend.deckEvents();
  const zones = JSON.stringify(backend.zones);
  const count = events.length;
  old.key(3, 'down');
  old.dial?.({ kind: 'rotate', index: 0, delta: 1 });
  old.touch?.({ type: 'tap', x: 50, y: 50 });
  old.lost('disconnect');
  await Promise.resolve();
  assert.equal(events.length, count);
  assert.equal(JSON.stringify(backend.zones), zones);
  assert.equal(backend.deck, deck);
  assert.equal(backend.state.model.id, 'ajazz-akp05e');
  assert.equal(backend.state.plugged, true);
  current.key(3, 'down');
  current.dial?.({ kind: 'rotate', index: 0, delta: 1 });
  assert.equal(backend.zones[0]?.value, 55);
  assert.ok(events.slice(count).some((event) => event.event === 'keyEvent'));
});

summary();
