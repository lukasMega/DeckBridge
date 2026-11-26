import assert from 'tjs:assert';
import { MiraboxDriver } from '../src/devices/mirabox/driver.js';
import { MIRABOX_293_MODEL } from '../src/devices/mirabox/mirabox-293.js';
import { setLogLevel, setWorkerPost } from '../src/shared/logger.js';
import { test, summary } from './helpers/harness.js';

console.log('\nMiraboxDriver stream stats (#292)');

interface Internals {
  noteStream(frameMs: number): void;
  readStats: { gapMax: number; reports: number };
}

const logs: string[] = [];
setLogLevel('info');
setWorkerPost((m) => logs.push(`${m.level} ${m.message}`));

let now = 1_000_000;
Date.now = (): number => now;

/** Feed `frames` frames evenly over `ms`, with the read loop reporting `gapMax` meanwhile. */
function stream(d: Internals, frames: number, ms: number, gapMax: number): void {
  for (let i = 0; i < frames; i++) {
    d.noteStream(20);
    d.readStats.gapMax = Math.max(d.readStats.gapMax, gapMax);
    now += ms / frames;
  }
  d.noteStream(20);
}

function rig(): Internals {
  logs.length = 0;
  return new MiraboxDriver(MIRABOX_293_MODEL) as unknown as Internals;
}

test('healthy stream: one info line per 5 s window', () => {
  const d = rig();
  stream(d, 50, 5000, 10);
  assert.equal(logs.length, 1);
  assert.ok(logs[0]!.startsWith('info stream 10.'), logs[0]);
  assert.ok(logs[0]!.includes('read-gap max 10ms'), logs[0]);
});

test('saturated stream: warn line', () => {
  const d = rig();
  stream(d, 50, 5000, 400);
  assert.equal(logs.length, 1);
  assert.ok(logs[0]!.startsWith('warn '), logs[0]);
  assert.ok(logs[0]!.includes('key presses may be delayed'), logs[0]);
});

test('idle gap before a frame is not reported as stream load', () => {
  const d = rig();
  d.readStats.gapMax = 60_000; // system sleep or a page-switch burst
  stream(d, 50, 5000, 10);
  assert.equal(logs.length, 1);
  assert.ok(logs[0]!.startsWith('info '), logs[0]);
});

test('sparse updates (< 3 fps) log nothing, even with a large gap', () => {
  const d = rig();
  stream(d, 2, 6000, 900);
  assert.equal(logs.length, 0);
});

summary();
