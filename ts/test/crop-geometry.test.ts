import assert from 'tjs:assert';
import {
  centredRect,
  clampRect,
  initialRect,
  moveRect,
  previewDrawOp,
  resizeFromCorner,
  withAspect,
} from '../src/web/client/simple/crop-geometry.js';
import { test, summaryExit } from './helpers/harness.js';

const SRC = { width: 120, height: 120 };
const KEY = { width: 112, height: 112 };

test('clampRect keeps the rect inside the source and at least 8 px', () => {
  assert.deepEqual(clampRect({ x: -5, y: 200, width: 4, height: 500 }, SRC), {
    x: 0,
    y: 0,
    width: 8,
    height: 120,
  });
  assert.deepEqual(clampRect({ x: 115, y: 0, width: 10.4, height: 10 }, SRC), {
    x: 110,
    y: 0,
    width: 10,
    height: 10,
  });
});

test('moveRect stops at the source edge', () => {
  const r = centredRect(KEY, SRC);
  assert.deepEqual(r, { x: 4, y: 4, width: 112, height: 112 });
  assert.deepEqual(moveRect(r, 100, -100, SRC), { x: 8, y: 0, width: 112, height: 112 });
});

test('resizeFromCorner keeps the opposite corner fixed', () => {
  const r = { x: 10, y: 10, width: 50, height: 50 };
  assert.deepEqual(resizeFromCorner(r, 'se', 20, 5, SRC), { x: 10, y: 10, width: 70, height: 55 });
  assert.deepEqual(resizeFromCorner(r, 'nw', 5, 5, SRC), { x: 15, y: 15, width: 45, height: 45 });
  // Past the source edge: clamped to the room left.
  assert.deepEqual(resizeFromCorner(r, 'nw', -50, -50, SRC), { x: 0, y: 0, width: 60, height: 60 });
});

test('resizeFromCorner with an aspect keeps the shape inside the source', () => {
  const r = { x: 0, y: 0, width: 40, height: 20 };
  const out = resizeFromCorner(r, 'se', 200, 0, SRC, 2);
  assert.deepEqual(out, { x: 0, y: 0, width: 120, height: 60 });
});

test('withAspect follows the edited side', () => {
  const r = { x: 0, y: 0, width: 60, height: 10 };
  assert.deepEqual(withAspect(r, 'width', SRC, 1), { x: 0, y: 0, width: 60, height: 60 });
  assert.deepEqual(withAspect({ ...r, height: 30 }, 'height', SRC, 2), {
    x: 0,
    y: 0,
    width: 60,
    height: 30,
  });
});

test('initialRect uses a complete saved rect, else the key size centred', () => {
  const saved = { x: 2, y: 3, width: 100, height: 100 };
  assert.deepEqual(initialRect(saved, KEY, SRC), saved);
  assert.deepEqual(initialRect({ x: 2 }, KEY, SRC), { x: 4, y: 4, width: 112, height: 112 });
});

test('previewDrawOp mirrors pad.rs per mode', () => {
  const r = { x: 4, y: 4, width: 120, height: 100 };
  // resize: whole region stretched to the key.
  assert.deepEqual(previewDrawOp(r, KEY, 'resize'), {
    sx: 4,
    sy: 4,
    sw: 120,
    sh: 100,
    dx: 0,
    dy: 0,
    dw: 112,
    dh: 112,
  });
  // pad with a larger axis falls back to resize.
  assert.deepEqual(previewDrawOp(r, KEY, 'pad').dw, 112);
  // crop: centre-crop x (120 → 112), pad y (100 in 112 → 6 px top border).
  assert.deepEqual(previewDrawOp(r, KEY, 'crop'), {
    sx: 8,
    sy: 4,
    sw: 112,
    sh: 100,
    dx: 0,
    dy: 6,
    dw: 112,
    dh: 100,
  });
});

summaryExit();
