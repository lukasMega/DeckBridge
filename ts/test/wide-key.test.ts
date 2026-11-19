import assert from 'tjs:assert';
import {
  DEFAULT_WIDE_KEY,
  WIDE_KEY_WIDGET_READY,
  pickWideKeyKeys,
  WIDE_KEY_PRESSES,
  resolveWideKey,
  wideKeyChoices,
  wideKeyError,
  wideKeyFirmwareMode,
  wideKeyPresses,
  hasWideWindow,
  sideExtraKeys,
  wideKeyWire,
  wideWindowElgato,
} from '../src/shared/wide-key.js';
import {
  WideKeyElgato,
  WideKeyInput,
  paintedConfig,
  withWideKeyPress,
} from '../src/main/dock-wide-key.js';
import { deviceInputToExtraKey, deviceInputToMk2Index } from '../src/shared/key-map.js';
import { ULANZI_D200_MODEL } from '../src/devices/ulanzi/ulanzi-d200.js';
import { DEFAULT_MODEL } from '../src/devices/registry.js';
import { MIRABOX_293S_MODEL } from '../src/devices/mirabox/mirabox-293s.js';
import { stripDisplays } from '../src/devices/driver.js';
import type { DeviceModel } from '../src/devices/driver.js';
import type { DockPrefs } from '../src/infra/dock-prefs.js';
import type { WideKeyConfig, WideKeyPress } from '../src/shared/types.js';
import { test, summary } from './helpers/harness.js';

console.log('\nwide-key');

const PAGE = ULANZI_D200_MODEL.page!;
const MODES = PAGE.smallWindowModes;

test('no entry resolves to the firmware clock DeckBridge always showed', () => {
  assert.deepEqual(resolveWideKey(undefined), {
    content: 'clock',
    clockMode: 203,
    hourFormat: '24H',
    press: 'none',
    elgatoSource: 'both',
    elgatoImages: 'ignore',
    overrideMs: 5000,
  });
  assert.equal(wideKeyFirmwareMode(resolveWideKey(undefined), PAGE), PAGE.smallWindowMode);
  assert.equal(wideKeyError({}), null);
  assert.equal(wideKeyError({ ...DEFAULT_WIDE_KEY }, MODES), null);
});

test('resolveWideKey overlays a partial and keeps statsPlugin optional', () => {
  const cfg = resolveWideKey({ content: 'stats', hourFormat: '12H' });
  assert.equal(cfg.content, 'stats');
  assert.equal(cfg.hourFormat, '12H');
  assert.equal(cfg.clockMode, 203);
  assert.equal('statsPlugin' in cfg, false);
  assert.equal(resolveWideKey({ statsPlugin: 'cpu.sh' }).statsPlugin, 'cpu.sh');
});

const bad: Array<[string, unknown]> = [
  ['content x', { content: 'x' }],
  ['clockMode 204', { clockMode: 204 }],
  ['clockMode string', { clockMode: '203' }],
  ['hourFormat 24', { hourFormat: '24' }],
  ['press elgato-15', { press: 'elgato-15' }],
  ['statsPlugin empty', { statsPlugin: '' }],
  ['statsPlugin number', { statsPlugin: 5 }],
  ['statsPlugin too long', { statsPlugin: 'x'.repeat(257) }],
  ['elgatoSource elgato-15', { elgatoSource: 'elgato-15' }],
  ['elgatoImages always', { elgatoImages: 'always' }],
  ['overrideMs below 1 s', { overrideMs: 999 }],
  ['overrideMs fraction', { overrideMs: 1500.5 }],
  ['array', []],
  ['null', null],
];
for (const [name, v] of bad) {
  test(`wideKeyError rejects ${name}`, () => {
    assert.ok(wideKeyError(v), `expected an error for ${name}`);
  });
}

test('wideKeyError ignores unknown keys and accepts every documented value', () => {
  assert.equal(wideKeyError({ somethingElse: 1 }), null);
  for (const content of ['clock', 'dial', 'stats', 'widget', 'elgato']) {
    assert.equal(wideKeyError({ content }), null, content);
  }
  for (const press of ['elgato-13', 'elgato-14', 'deckbridge', 'none']) {
    assert.equal(wideKeyError({ press }), null, press);
  }
});

test('with a mode list, a content or variant the model cannot show is rejected', () => {
  assert.ok(wideKeyError({ content: 'dial' }, [0, 203]));
  assert.ok(wideKeyError({ content: 'stats' }, [1, 203]));
  assert.ok(wideKeyError({ content: 'clock', clockMode: 201 }, [0, 203]));
  assert.equal(wideKeyError({ content: 'stats' }, [0, 203]), null);
  assert.ok(wideKeyError({ content: 'clock' }, [0, 1]), 'no clock mode at all');
});

test('the widget content is accepted where the model lists the image mode', () => {
  assert.equal(WIDE_KEY_WIDGET_READY, true);
  assert.equal(wideKeyError({ content: 'widget' }, MODES), null);
  assert.equal(wideKeyError({ content: 'widget' }), null);
  assert.ok(wideKeyError({ content: 'widget' }, [0, 1, 203]), 'a model without mode 2');
});

test('wideKeyChoices follows the model list', () => {
  assert.deepEqual(wideKeyChoices(MODES), {
    contents: ['clock', 'dial', 'stats', 'widget', 'elgato'],
    clockModes: [200, 201, 202, 203],
  });
  assert.deepEqual(wideKeyChoices([0, 1]), { contents: ['dial', 'stats'], clockModes: [] });
});

const modeFor = (c: Parameters<typeof resolveWideKey>[0]): number =>
  wideKeyFirmwareMode(resolveWideKey(c), PAGE);

test('wideKeyFirmwareMode maps content to the firmware mode', () => {
  assert.equal(modeFor({ content: 'stats' }), 0);
  assert.equal(modeFor({ content: 'dial' }), 1);
  assert.equal(modeFor({ content: 'widget' }), 2);
  assert.equal(modeFor({ content: 'elgato' }), 2);
  assert.equal(modeFor({ content: 'clock', clockMode: 201 }), 201);
  assert.equal(modeFor({ content: 'clock' }), 203);
});

test('wideKeyFirmwareMode falls back to the default for a mode the model lacks', () => {
  const narrow = { smallWindowMode: 203, smallWindowModes: [203] };
  assert.equal(wideKeyFirmwareMode(resolveWideKey({ content: 'stats' }), narrow), 203);
  assert.equal(wideKeyFirmwareMode(resolveWideKey({ clockMode: 200 }), narrow), 203);
  assert.equal(
    wideKeyFirmwareMode(resolveWideKey({ content: 'widget' }), narrow),
    203,
    'widget on a model without the image mode',
  );
});

test('pickWideKeyKeys keeps only known keys', () => {
  assert.deepEqual(
    pickWideKeyKeys({ content: 'dial', press: 'none', extra: 1, hourFormat: undefined }),
    {
      content: 'dial',
      press: 'none',
    },
  );
});

test('the DeckBridge press is offered and accepted now the widget side is wired', () => {
  assert.deepEqual(wideKeyPresses(), ['elgato-13', 'elgato-14', 'deckbridge', 'none']);
  assert.equal(wideKeyError({ press: 'deckbridge' }, MODES), null);
  assert.equal(wideKeyError({ press: 'elgato-14' }, MODES), null);
});

// Press routing (main/dock-wide-key.ts)

const WIRE = 13;
/** Where a device press on `code` ends up: an Elgato cell, an extra key, or -1 = nowhere. */
const targetOf = (model: DeviceModel, code = WIRE) => ({
  cell: deviceInputToMk2Index(code, model),
  extra: deviceInputToExtraKey(code, model),
});
const ROUTES: Record<WideKeyPress, { cell: number; extra: number }> = {
  'elgato-13': { cell: 13, extra: -1 },
  'elgato-14': { cell: 14, extra: -1 },
  deckbridge: { cell: -1, extra: WIRE },
  none: { cell: -1, extra: -1 },
};

test('the window wire id is its manifest slot; models without one have none', () => {
  assert.equal(wideKeyWire(ULANZI_D200_MODEL), WIRE);
  assert.equal(wideKeyWire(DEFAULT_MODEL), undefined);
});

test('each press routes the window to exactly one target', () => {
  for (const press of WIDE_KEY_PRESSES) {
    assert.deepEqual(targetOf(withWideKeyPress(ULANZI_D200_MODEL, press)), ROUTES[press], press);
  }
});

test('a press never moves a real key and never edits the registry model', () => {
  const before = JSON.stringify(ULANZI_D200_MODEL.keyMap);
  for (const press of WIDE_KEY_PRESSES) {
    const routed = withWideKeyPress(ULANZI_D200_MODEL, press);
    for (let code = 0; code < WIRE; code++) {
      assert.deepEqual(targetOf(routed, code), { cell: code, extra: -1 }, `${press} key ${code}`);
    }
    assert.deepEqual(routed.keyMap.coraToWireImage, ULANZI_D200_MODEL.keyMap.coraToWireImage);
  }
  assert.equal(JSON.stringify(ULANZI_D200_MODEL.keyMap), before);
});

test('a model that already lists the window or other extra keys still has one target', () => {
  const base: DeviceModel = {
    ...ULANZI_D200_MODEL,
    keyMap: { ...ULANZI_D200_MODEL.keyMap, extraKeys: [16, WIRE], extraKeyInputs: [16, WIRE] },
  };
  for (const press of WIDE_KEY_PRESSES) {
    const routed = withWideKeyPress(base, press);
    assert.deepEqual(targetOf(routed), ROUTES[press], press);
    assert.equal(targetOf(routed, 16).extra, 16, `${press}: another extra key keeps its switch`);
  }
  // Display-only extra keys (no inputs) stay display-only.
  const displayOnly: DeviceModel = {
    ...ULANZI_D200_MODEL,
    keyMap: { ...ULANZI_D200_MODEL.keyMap, extraKeys: [16] },
  };
  const routed = withWideKeyPress(displayOnly, 'deckbridge');
  assert.equal(targetOf(routed, 16).extra, -1);
  assert.equal(targetOf(routed).extra, WIRE);
});

test('a model without an info window is returned untouched', () => {
  assert.equal(withWideKeyPress(DEFAULT_MODEL, 'deckbridge'), DEFAULT_MODEL);
  assert.equal(withWideKeyPress(MIRABOX_293S_MODEL, 'elgato-13'), MIRABOX_293S_MODEL);
});

test('WideKeyInput reads the press per call and reuses the routed model while nothing changes', () => {
  let stored: Partial<{ press: WideKeyPress }> | undefined;
  const prefs = { wideKey: () => resolveWideKey(stored) } as unknown as DockPrefs;
  const input = new WideKeyInput(() => prefs);
  const first = input.model(ULANZI_D200_MODEL);
  assert.deepEqual(targetOf(first), ROUTES.none, 'no entry drops the press');
  assert.equal(input.model(ULANZI_D200_MODEL), first, 'same routed model object');
  stored = { press: 'elgato-14' };
  assert.deepEqual(targetOf(input.model(ULANZI_D200_MODEL)), ROUTES['elgato-14']);
  stored = undefined;
  assert.deepEqual(targetOf(input.model(ULANZI_D200_MODEL)), ROUTES.none, 'a removed entry resets');
  assert.equal(input.model(DEFAULT_MODEL), DEFAULT_MODEL, 'other models pass through');
  const beforeIdentity = new WideKeyInput(() => undefined);
  assert.deepEqual(targetOf(beforeIdentity.model(ULANZI_D200_MODEL)), ROUTES.none);
});

// Widget (mode 2): the window as a DeckBridge-owned key

test('the D200 lists the window as a standalone widget display and an extra key', () => {
  assert.deepEqual(ULANZI_D200_MODEL.keyMap.extraKeys, [WIRE]);
  const [display, ...rest] = ULANZI_D200_MODEL.widgetDisplays ?? [];
  assert.equal(rest.length, 0);
  assert.equal(display?.wireId, WIRE);
  assert.equal(display?.standalone, true);
  assert.equal(display?.image.width, 458);
  assert.equal(display?.image.height, 196);
  // Upright like the splash: the keys' 180 only undoes Elgato's pre-rotated MK.2 frames.
  assert.equal(display?.image.rotate, 0);
  assert.deepEqual(stripDisplays(ULANZI_D200_MODEL), [], 'no touch-strip zone');
});

test('the window never receives a CORA image, with or without a widget', () => {
  const map = ULANZI_D200_MODEL.keyMap.coraToWireImage!;
  assert.equal(map.includes(WIRE), false);
  assert.deepEqual(map.slice(13), [-1, -1]);
});

test('sideExtraKeys drops the window and keeps real side keys', () => {
  assert.deepEqual(sideExtraKeys(ULANZI_D200_MODEL), []);
  assert.deepEqual(sideExtraKeys(MIRABOX_293S_MODEL), MIRABOX_293S_MODEL.keyMap.extraKeys);
  assert.deepEqual(sideExtraKeys(DEFAULT_MODEL), []);
  const both: DeviceModel = {
    ...ULANZI_D200_MODEL,
    keyMap: { ...ULANZI_D200_MODEL.keyMap, extraKeys: [16, WIRE] },
  };
  assert.deepEqual(sideExtraKeys(both), [16]);
});

test('hasWideWindow: a D200X turns slot 13 into a real key, so it has no window', () => {
  assert.equal(hasWideWindow(ULANZI_D200_MODEL), true, 'type unknown yet');
  assert.equal(hasWideWindow(ULANZI_D200_MODEL, 'D200'), true);
  assert.equal(hasWideWindow(ULANZI_D200_MODEL, 'D200H'), true);
  assert.equal(hasWideWindow(ULANZI_D200_MODEL, 'D200X'), false);
  assert.equal(hasWideWindow(ULANZI_D200_MODEL, 'd200x'), false);
  assert.equal(hasWideWindow(DEFAULT_MODEL, 'D200'), false);
});

const prefsWith = (stored?: { content: 'widget' | 'clock' }): DockPrefs =>
  ({ wideKey: () => resolveWideKey(stored) }) as unknown as DockPrefs;

test('paintedConfig gates only the window: its widget paints only for content widget', () => {
  const cfg = { widget: 'text', param: 'hi' } as const;
  const prefs = prefsWith;
  assert.equal(paintedConfig(ULANZI_D200_MODEL, prefs({ content: 'widget' }), WIRE, cfg), cfg);
  assert.equal(paintedConfig(ULANZI_D200_MODEL, prefs({ content: 'clock' }), WIRE, cfg), undefined);
  assert.equal(paintedConfig(ULANZI_D200_MODEL, prefs(), WIRE, cfg), undefined, 'no entry');
  assert.equal(paintedConfig(ULANZI_D200_MODEL, undefined, WIRE, cfg), undefined);
  assert.equal(
    paintedConfig(ULANZI_D200_MODEL, prefs(), 5, cfg),
    cfg,
    'another key passes through',
  );
  assert.equal(paintedConfig(MIRABOX_293S_MODEL, prefs(), 16, cfg), cfg, 'other models too');
});

test('content elgato is offered on the D200 and shows a mode-2 image', () => {
  assert.ok(wideKeyChoices(MODES).contents.includes('elgato'));
  assert.equal(wideKeyFirmwareMode(resolveWideKey({ content: 'elgato' }), PAGE), 2);
  assert.equal(wideKeyError({ content: 'elgato', elgatoSource: 'elgato-14' }, MODES), null);
});

const at = (cfg: Partial<WideKeyConfig>) => wideWindowElgato(resolveWideKey(cfg));

test('wideWindowElgato: cells per source, drawn for elgato and for a widget under override', () => {
  assert.deepEqual(at({ content: 'elgato' }), { cells: [13, 14], show: true });
  assert.deepEqual(at({ content: 'elgato', elgatoSource: 'elgato-14' }), {
    cells: [14],
    show: true,
  });
  assert.deepEqual(at({ content: 'widget' }), { cells: [13, 14], show: false }, 'ignore keeps');
  assert.deepEqual(at({ content: 'widget', elgatoImages: 'override', elgatoSource: 'elgato-13' }), {
    cells: [13],
    show: true,
  });
  assert.deepEqual(at({ content: 'clock' }), { cells: [], show: false });
});

test('WideKeyElgato: content elgato always yields; override only within overrideMs of a source frame', () => {
  let cfg: Partial<WideKeyConfig> = { content: 'elgato' };
  const prefs = { wideKey: () => resolveWideKey(cfg) } as unknown as DockPrefs;
  const w = new WideKeyElgato(
    () => ULANZI_D200_MODEL,
    () => prefs,
  );
  assert.equal(w.yields(WIRE, 0), true);
  assert.equal(w.yields(5, 0), false, 'only the window');
  cfg = { content: 'widget', elgatoImages: 'override', overrideMs: 2000 };
  assert.equal(w.yields(WIRE, 0), false, 'no frame yet: the widget shows');
  w.noteFrame(3, 1000);
  assert.equal(w.yields(WIRE, 1000), false, 'a frame of another key does not count');
  w.noteFrame(14, 1000);
  assert.equal(w.yields(WIRE, 2999), true);
  assert.equal(w.yields(WIRE, 3000), false, 'the widget returns after overrideMs');
  cfg = { content: 'widget', elgatoImages: 'ignore' };
  w.noteFrame(14, 5000);
  assert.equal(w.yields(WIRE, 5001), false, 'ignore never yields');
  assert.equal(
    new WideKeyElgato(
      () => ULANZI_D200_MODEL,
      () => undefined,
    ).yields(WIRE, 0),
    false,
  );
});

summary();
