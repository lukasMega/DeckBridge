import assert from 'tjs:assert';
import { ExtensionEventWiring } from '../src/main/extension-events-wiring.js';
import type { Dock } from '../src/main/dock.js';
import type { ExtensionEvent } from '../src/extension/api.js';
import { DEFAULT_MODEL } from '../src/devices/registry.js';
import { AJAZZ_AKP05E_MODEL } from '../src/devices/ajazz/akp05e.js';
import type { DeviceModel } from '../src/devices/driver.js';
import { VIRTUAL_DOCK_INDEX } from '../src/shared/types.js';
import { test, summary } from './helpers/harness.js';

function setup(model: DeviceModel, deviceKey: string | null = 'dk') {
  const events: ExtensionEvent[] = [];
  const sink = { active: true, emit: (e: ExtensionEvent) => events.push(e) };
  const docks = new Map<number, Dock>();
  const dock = { model, identity: deviceKey === null ? undefined : { deviceKey } } as Dock;
  const wiring = new ExtensionEventWiring(sink, (i) => docks.get(i));
  const place = (index: number): void => void docks.set(index, dock);
  return { events, sink, docks, wiring, place };
}

console.log('\nextension-events-wiring');

test('attach carries model, source, encoders, columns and side keys', () => {
  const { events, wiring, place } = setup(AJAZZ_AKP05E_MODEL);
  place(1);
  wiring.hooks(1).attached!(false);
  const e = events[0] as Extract<ExtensionEvent, { type: 'deckAttached' }>;
  assert.equal(e.type, 'deckAttached');
  assert.equal(e.deviceKey, 'dk');
  assert.equal(e.modelName, AJAZZ_AKP05E_MODEL.name);
  assert.equal(e.source, 'usb');
  assert.equal(e.hasEncoders, true);
  assert.ok(e.columns > 0);
  assert.deepEqual(e.extraKeys, [...(AJAZZ_AKP05E_MODEL.keyMap.extraKeys ?? [])]);
});

test('source: mock flag, and the browser deck by its index', () => {
  const mock = setup(DEFAULT_MODEL);
  mock.place(1);
  mock.wiring.hooks(1).attached!(true);
  assert.equal((mock.events[0] as { source: string }).source, 'mock');
  const browser = setup(DEFAULT_MODEL);
  browser.place(VIRTUAL_DOCK_INDEX);
  browser.wiring.hooks(VIRTUAL_DOCK_INDEX).attached!(false);
  assert.equal((browser.events[0] as { source: string }).source, 'browser');
});

test('input and image events carry the device key and the raw input', () => {
  const { events, wiring, place } = setup(DEFAULT_MODEL);
  place(0);
  const hooks = wiring.hooks(0);
  hooks.input!({ kind: 'dialRotate', index: 0, delta: -3 });
  hooks.imageSent!(4, true);
  assert.deepEqual(
    events.map((e) => ({ ...e, at: 0 })),
    [
      {
        type: 'input',
        at: 0,
        deviceKey: 'dk',
        input: { kind: 'dialRotate', index: 0, delta: -3 },
      },
      { type: 'imageProcessed', at: 0, deviceKey: 'dk', cached: true },
    ],
  );
});

test('an inactive sink gets nothing, but the attach is still remembered', () => {
  const { events, sink, wiring, place } = setup(DEFAULT_MODEL);
  sink.active = false;
  place(0);
  const hooks = wiring.hooks(0);
  hooks.attached!(false);
  hooks.input!({ kind: 'key', mk2: 0, state: 'down' });
  hooks.imageSent!(0, false);
  assert.equal(events.length, 0);
  assert.equal(wiring.currentDecks().length, 1);
});

test('a forgotten dock (unplugged dock 0) is not replayed', () => {
  const { wiring, place } = setup(DEFAULT_MODEL);
  place(0);
  wiring.hooks(0).attached!(false);
  wiring.forget(0);
  assert.equal(wiring.currentDecks().length, 0);
});

test('currentDecks drops docks that are gone', () => {
  const { docks, wiring, place } = setup(DEFAULT_MODEL);
  place(0);
  place(1);
  wiring.hooks(0).attached!(false);
  wiring.hooks(1).attached!(false);
  docks.delete(1);
  assert.equal(wiring.currentDecks().length, 1);
});

test('a dock without identity reports nothing', () => {
  const { events, wiring, place } = setup(DEFAULT_MODEL, null);
  place(0);
  const hooks = wiring.hooks(0);
  hooks.attached!(false);
  hooks.input!({ kind: 'key', mk2: 0, state: 'down' });
  hooks.imageSent!(0, false);
  assert.equal(events.length, 0);
  assert.equal(wiring.currentDecks().length, 0);
});

summary();
