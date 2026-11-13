import assert from 'tjs:assert';
import { buildBugReport } from '../src/web/client/simple/bug-report-export.js';
import {
  applyModelOverrides,
  tunableDefaults,
  validateModelOverride,
} from '../src/devices/model-overrides.js';
import { findModelById } from '../src/devices/registry.js';
import type { DeviceOverridesView, KeyEvent } from '../src/web/client/ui-types.js';
import { test, summary as reportSummary } from './helpers/harness.js';

/** The same projection the server builds in model-overrides-controller.ts view(). */
function viewFor(
  modelId: string,
  overrides: DeviceOverridesView['overrides'],
): DeviceOverridesView {
  const model = findModelById(modelId)!;
  const effective = applyModelOverrides(model, overrides as never);
  return {
    modelId,
    modelName: model.name,
    defaults: tunableDefaults(model),
    overrides,
    safeMode: false,
    effective: {
      image: effective.image,
      keyMap: effective.keyMap,
      wire: { ...effective.wire },
      cora: effective.cora,
    },
    tunable: tunableDefaults(effective),
    profiles: [],
    sourceSize: { width: 72, height: 72 },
  };
}

const CASES: ReadonlyArray<[string, DeviceOverridesView['overrides']]> = [
  ['mk2', {}],
  ['mirabox-293', { image: { rotate: 90, flipH: true, quality: 0.5 } }],
  [
    'mirabox-293s',
    {
      image: { rotate: 180, cropRect: { x: 2, y: 2, width: 60, height: 60 } },
      keyMap: {
        wireInputToCora: [-1, 4, 9, 14, 3, 8, 13, 2, 7, 12, 1, 6, 11, 0, 5, 10, -1, -1, -1],
      },
      wire: { batchImageTransfers: false },
    },
  ],
  ['ajazz-akp05e', { wire: { inSize: 512 }, cora: { advertiseAs: 'stream-deck-plus' } }],
];

test('the exported overrides round-trip through validateModelOverride', () => {
  for (const [modelId, overrides] of CASES) {
    const report = buildBugReport(viewFor(modelId, overrides), '0.19.0', [], modelId);
    // Through JSON, exactly as the clipboard text a reporter pastes back.
    const pasted = JSON.parse(JSON.stringify(report)) as typeof report;
    assert.equal(pasted.modelId, modelId);
    assert.equal(pasted.appVersion, '0.19.0');
    const result = validateModelOverride(pasted.overrides, findModelById(modelId)!);
    assert.ok(result.ok, `${modelId}: ${result.ok ? '' : result.errors.join('; ')}`);
    assert.deepEqual(pasted.overrides, overrides, `${modelId}: overrides pass through verbatim`);
  }
});

test('the report carries only the documented keys, never settings', () => {
  const allowed = new Set(['modelId', 'appVersion', 'overrides', 'advertiseAs', 'rawInputSamples']);
  for (const [modelId, overrides] of CASES) {
    const report = buildBugReport(viewFor(modelId, overrides), 'x', [], modelId);
    for (const key of Object.keys(report)) assert.ok(allowed.has(key), `${modelId}: ${key}`);
    assert.ok(!JSON.stringify(report).includes('command'), `${modelId}: no commands`);
  }
});

test('advertiseAs is the pairing the device actually runs', () => {
  const plus = buildBugReport(viewFor('ajazz-akp05e', {}), 'x', [], 'ajazz-akp05e');
  assert.equal(plus.advertiseAs, 'stream-deck-plus');
});

test('raw input samples keep only wire-id events, newest first, capped at 20', () => {
  const events: KeyEvent[] = [
    { ts: 99, mk2Index: 0, state: 'down' },
    ...Array.from({ length: 30 }, (_, i): KeyEvent => ({
      ts: i,
      mk2Index: i % 15,
      state: i % 2 === 0 ? 'down' : 'up',
      wireId: i + 1,
    })),
  ];
  const report = buildBugReport(viewFor('mirabox-293', {}), 'x', events, 'mirabox-293');
  assert.equal(report.rawInputSamples!.length, 20);
  assert.deepEqual(report.rawInputSamples![0], { state: 'down', wireId: 1, mk2Index: 0 });
  assert.ok(!('ts' in report.rawInputSamples![0]!), 'timestamps are not exported');
  const none = buildBugReport(viewFor('mirabox-293', {}), 'x', [events[0]!], 'mirabox-293');
  assert.equal(none.rawInputSamples, undefined);
});

test('raw input samples are dropped when another device produced them', () => {
  const events: KeyEvent[] = [{ ts: 1, mk2Index: 0, state: 'down', wireId: 7 }];
  const report = buildBugReport(viewFor('mirabox-293', {}), 'x', events, 'mk2');
  assert.equal(report.rawInputSamples, undefined);
});

reportSummary();
