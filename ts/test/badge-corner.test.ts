import assert from 'tjs:assert';
import { badgeCorner } from '../src/transform/badge-corner.js';
import { splashSpec } from '../src/shared/splash-spec.js';
import { ULANZI_D200_MODEL } from '../src/devices/ulanzi/ulanzi-d200.js';
import { MIRABOX_293S_MODEL } from '../src/devices/mirabox/mirabox-293s.js';
import { MIRABOX_293_MODEL } from '../src/devices/mirabox/mirabox-293.js';
import { test, summaryExit } from './helpers/harness.js';

// Corner ids: 1 top-left, 2 top-right, 3 bottom-right, 4 bottom-left of the sent image.
// The sent image is the upright one rotated clockwise, then flipped H, then flipped V.
test('no rotate/flip: top-right stays top-right', () => {
  assert.equal(badgeCorner({ rotate: 0, flipH: false, flipV: false }), 2);
});

test('rotate walks the corner clockwise', () => {
  const corners = ([0, 90, 180, 270] as const).map((rotate) =>
    badgeCorner({ rotate, flipH: false, flipV: false }),
  );
  assert.deepEqual(corners, [2, 3, 4, 1]);
});

test('flips mirror the corner', () => {
  assert.equal(badgeCorner({ rotate: 0, flipH: true, flipV: false }), 1);
  assert.equal(badgeCorner({ rotate: 0, flipH: false, flipV: true }), 3);
  assert.equal(badgeCorner({ rotate: 0, flipH: true, flipV: true }), 4);
});

/** Where the upright image's top-right corner (x=1, y=0) ends up as (x, y) in {0,1}². */
function followCorner(rotate: number, flipH: boolean, flipV: boolean): [number, number] {
  let [x, y] = [1, 0];
  for (let i = 0; i < rotate / 90; i++) [x, y] = [1 - y, x]; // 90° clockwise
  return [flipH ? 1 - x : x, flipV ? 1 - y : y];
}

test('rotate then flip, all 8 combinations land on the top-right of the panel', () => {
  const xy: Record<number, [number, number]> = { 1: [0, 0], 2: [1, 0], 3: [1, 1], 4: [0, 1] };
  const flips = [false, true];
  for (const rotate of [0, 90, 180, 270] as const) {
    for (const flipH of flips) {
      for (const flipV of flips) {
        assert.deepEqual(
          xy[badgeCorner({ rotate, flipH, flipV })],
          followCorner(rotate, flipH, flipV),
        );
      }
    }
  }
});

// The splash spec is the upright → sent transform; model.image is not (CORA frames arrive
// pre-rotated), which put the badge bottom-left on the D200 (rotate 180 in model.image).
test('real models: D200 sent image is upright, 293S is turned a quarter, 293 a half', () => {
  assert.equal(badgeCorner(splashSpec(ULANZI_D200_MODEL)), 2);
  assert.equal(badgeCorner(splashSpec(MIRABOX_293S_MODEL)), 1);
  assert.equal(badgeCorner(splashSpec(MIRABOX_293_MODEL)), 4);
});

summaryExit();
