import assert from 'tjs:assert';
import { createTracker } from '../src/demo/track.js';
import { DEFAULT_MODEL } from '../src/devices/registry.js';
import { test, summary } from './helpers/harness.js';

test('tracking dedupes each target and keeps event vocabulary', () => {
  const calls: string[][] = [];
  const tracker = createTracker(() => ({
    trackEvent: (event, target) => calls.push([event, target!]),
  }));
  tracker.mockModel(DEFAULT_MODEL.id);
  tracker.mockModel(DEFAULT_MODEL.id);
  tracker.hwConnected(DEFAULT_MODEL.id);
  tracker.hwUnsupported();
  tracker.hwFail('open');
  assert.deepEqual(calls, [
    ['demo', `mock:${DEFAULT_MODEL.id}`],
    ['demo', `hw:${DEFAULT_MODEL.id}`],
    ['demo', 'hw:unsupported'],
    ['demo', 'hw:fail:open'],
  ]);
});

test('unknown USB ids are zero-padded lowercase hex', () => {
  const calls: string[] = [];
  const tracker = createTracker(() => ({ trackEvent: (_event, target) => calls.push(target!) }));
  tracker.hwUnknown(0x300, 0x3004);
  tracker.hwUnknown(0xabcd, 0xf);
  assert.deepEqual(calls, ['hw:unknown:0300:3004', 'hw:unknown:abcd:000f']);
});

test('unknown models and invalid USB ids send nothing', () => {
  const calls: string[] = [];
  const tracker = createTracker(() => ({ trackEvent: (_event, target) => calls.push(target!) }));
  tracker.mockModel('unknown');
  tracker.hwConnected('unknown');
  tracker.hwUnknown(-1, 0x10000);
  assert.equal(calls.length, 0);
});

test('throwing beacon never interrupts tracking', () => {
  const tracker = createTracker(() => ({
    trackEvent: () => {
      throw new Error('offline');
    },
  }));
  tracker.hwFail('write');
});

test('missing beacon is silent', () => {
  const tracker = createTracker(() => undefined);
  tracker.hwUnsupported();
});

summary();
