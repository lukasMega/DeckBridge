// Verify-wizard math, checked by pixel simulation: every orientation is applied to a small
// asymmetric matrix exactly as transform.rs does (image::imageops rotate CW, then flipH,
// then flipV), so the tests do not trust the algebra they test.
import assert from 'tjs:assert';
import {
  ORIENTATIONS,
  applyOrder,
  blankStart,
  blankStep,
  canonical,
  compose,
  invert,
  invertOrder,
  orderCandidates,
  orientMatrix,
  orientationFix,
  sameOrientation,
  sizeStart,
  sizeStep,
  splashFor,
  splashToSave,
  tapOrder,
  type RawOrientation,
  type SizeAnswer,
} from '../src/web/client/simple/verify-wizard/verify-math.js';
import { DEVICE_MODELS, advertisedModel } from '../src/devices/registry.js';
import { splashSpec } from '../src/shared/splash-sender.js';
import { frameOrientation } from '../src/web/server/verify-orientation.js';
import type { DeviceModel } from '../src/devices/driver.js';
import { test, summaryExit } from './helpers/harness.js';

type M = number[][];

/** Non-square with distinct values: all 8 orientations of it differ. */
const U: M = [
  [1, 2, 3],
  [4, 5, 6],
];

/** Writes src(x, y) to out(to(x, y)), like image::imageops' put_pixel loops. */
function remap(
  m: M,
  swap: boolean,
  to: (x: number, y: number, w: number, h: number) => number[],
): M {
  const h = m.length;
  const w = m[0]?.length ?? 0;
  const out: M = Array.from({ length: swap ? w : h }, () =>
    Array.from({ length: swap ? h : w }, () => 0),
  );
  m.forEach((row, y) =>
    row.forEach((v, x) => {
      const [dx = 0, dy = 0] = to(x, y, w, h);
      (out[dy] ?? [])[dx] = v;
    }),
  );
  return out;
}

const rotate90 = (m: M): M => remap(m, true, (x, y, _w, h) => [h - 1 - y, x]);
const rotate180 = (m: M): M => remap(m, false, (x, y, w, h) => [w - 1 - x, h - 1 - y]);
const rotate270 = (m: M): M => remap(m, true, (x, y, w) => [y, w - 1 - x]);
const flipH = (m: M): M => remap(m, false, (x, y, w) => [w - 1 - x, y]);
const flipV = (m: M): M => remap(m, false, (x, y, _w, h) => [x, h - 1 - y]);

/** transform.rs order: rotate, then flipH, then flipV. */
function apply(m: M, o: RawOrientation): M {
  let out = { 0: m, 90: rotate90(m), 180: rotate180(m), 270: rotate270(m) }[o.rotate];
  if (o.flipH) out = flipH(out);
  if (o.flipV) out = flipV(out);
  return out;
}

const eq = (a: M, b: M): boolean => JSON.stringify(a) === JSON.stringify(b);
const name = (o: RawOrientation): string =>
  `r${o.rotate}${o.flipH ? '+H' : ''}${o.flipV ? '+V' : ''}`;
const ID: RawOrientation = { rotate: 0, flipH: false };

/** All 16 raw field combinations (each of the 8 elements twice). */
const RAW: RawOrientation[] = ORIENTATIONS.flatMap((o) => [o, { ...o, flipV: true }]);

// --- dihedral group ---

test('ORIENTATIONS are the 8 distinct pictures', () => {
  assert.equal(ORIENTATIONS.length, 8);
  const pics = new Set(ORIENTATIONS.map((o) => JSON.stringify(apply(U, o))));
  assert.equal(pics.size, 8);
});

test('canonical: same pixels, no flipV, for all 16 raw forms', () => {
  for (const o of RAW) {
    const c = canonical(o);
    assert.ok(!('flipV' in c), name(o));
    assert.ok(eq(apply(U, c), apply(U, o)), name(o));
  }
});

test('compose(a, b) = a applied after b, all 16 × 16 raw forms', () => {
  for (const a of RAW) {
    for (const b of RAW) {
      assert.ok(eq(apply(U, compose(a, b)), apply(apply(U, b), a)), `${name(a)} ∘ ${name(b)}`);
    }
  }
});

test('invert undoes the element from both sides, all 16 raw forms', () => {
  for (const a of RAW) {
    const inv = invert(a);
    assert.ok(eq(apply(apply(U, a), inv), U), name(a));
    assert.ok(eq(apply(apply(U, inv), a), U), name(a));
  }
});

test('sameOrientation compares pixels, not fields', () => {
  assert.ok(
    sameOrientation({ rotate: 180, flipH: false, flipV: true }, { rotate: 0, flipH: true }),
  );
  assert.ok(!sameOrientation({ rotate: 90, flipH: false }, { rotate: 270, flipH: false }));
});

test('orientMatrix draws an upright tile as o(tile), all 16 raw forms', () => {
  for (const o of RAW) {
    const [a, b, c, d, e, f] = orientMatrix(o, 3, 2);
    // Map each source pixel centre through the canvas matrix.
    const odd = canonical(o).rotate % 180 !== 0;
    const drawn = remap(U, odd, (x, y) => [
      Math.floor(a * (x + 0.5) + c * (y + 0.5) + e),
      Math.floor(b * (x + 0.5) + d * (y + 0.5) + f),
    ]);
    assert.ok(eq(drawn, apply(U, o)), name(o));
  }
});

// --- orientation fix ---

test('orientationFix: 8 frame P × 8 device distortions × 16 current T end upright', () => {
  for (const p of ORIENTATIONS) {
    for (const dev of ORIENTATIONS) {
      for (const t of RAW) {
        const shows = (img: RawOrientation): M => apply(apply(apply(U, p), img), dev);
        // The user picks the candidate thumbnail (g applied to the upright tile).
        const picks = ORIENTATIONS.filter((g) => eq(apply(U, g), shows(t)));
        assert.equal(picks.length, 1);
        const fixed = orientationFix(t, p, picks[0] ?? ID);
        assert.ok(eq(shows(fixed), U), `P ${name(p)}, device ${name(dev)}, T ${name(t)}`);
      }
    }
  }
});

test('orientationFix: picking the upright picture keeps T', () => {
  for (const p of ORIENTATIONS) {
    for (const t of RAW) assert.ok(sameOrientation(orientationFix(t, p, ID), t));
  }
});

// --- splash derive vs the hardware-tested registry (P: the server's O1 table) ---

// Splash inherited from MIRABOX_293_MODEL, never checked on hardware: plan follow-up F1.
const SPLASH_ALLOW = new Set(['ajazz-akp153e-rev2']);

const notes = JSON.parse(
  new TextDecoder().decode(await tjs.readFile('src/devices/device-notes.json')),
) as { notes: Record<string, { tested?: { status?: boolean } }> };
const testedIds = Object.keys(notes.notes).filter((id) => notes.notes[id]?.tested?.status === true);

/** Orientation the app's frames actually get: passthrough and gen1 BMP skip the transform. */
function effectiveT(model: DeviceModel): RawOrientation {
  const im = model.image;
  return im.transform === 'passthrough' || im.format === 'bmp' ? ID : im;
}

test('every hardware-tested model is in the registry with a P for its profile', () => {
  assert.ok(testedIds.length >= 8, `tested: ${testedIds.join(', ')}`);
  for (const id of testedIds) {
    const model = DEVICE_MODELS.find((m) => m.id === id);
    const profile = model && advertisedModel(model).id;
    assert.ok(profile && frameOrientation(profile), `${id} → ${profile}`);
  }
});

test('splash derive: S == T ∘ P for every hardware-tested model (pixels)', () => {
  for (const id of testedIds) {
    const model = DEVICE_MODELS.find((m) => m.id === id);
    if (!model) continue;
    const p = frameOrientation(advertisedModel(model).id) ?? ID;
    const s = splashSpec(model);
    const match = eq(apply(U, s), apply(apply(U, p), effectiveT(model)));
    assert.equal(match, sameOrientation(splashFor(effectiveT(model), p), s), id);
    // An allow-listed model that starts matching means F1 landed: drop it from the list.
    assert.equal(match, !SPLASH_ALLOW.has(id), `${id}: S ${name(s)}`);
  }
});

test('splashToSave: unchanged image → omitted; changed image → derived splash pinned', () => {
  const p = frameOrientation('mk2') ?? ID;
  // F1: the AKP153E rev. 2 (T = 90) keeps its splash while its image orientation is unchanged.
  const t: RawOrientation = { rotate: 90, flipH: false, flipV: false };
  assert.equal(splashToSave(t, t, p), undefined);
  // Same pixels, other fields: the splash may inherit them, so it is pinned.
  const flipped: RawOrientation = { rotate: 270, flipH: true, flipV: true };
  const next = canonical(flipped);
  assert.deepEqual(splashToSave(flipped, next, p), splashFor(next, p));
  assert.deepEqual(
    splashToSave(t, { rotate: 0, flipH: false }, p),
    splashFor({ rotate: 0, flipH: false }, p),
  );
});

// --- key order ---

const isPerm = (a: number[], n: number): boolean =>
  a.length === n && a.toSorted((x, y) => x - y).every((v, i) => v === i);

/** What a deck shows when CORA key k carries number paint[k]: the true physical wire id
 *  at position p is truth[p], and the current map sends CORA key k to map[k]. */
function seenAt(paint: number[], map: number[], truth: number[]): number[] {
  return truth.map((wire) => paint[map.indexOf(wire)] ?? -1);
}

test('orderCandidates: identity first, deduplicated, valid permutations, max 6', () => {
  for (const [rows, columns] of [
    [3, 5],
    [2, 3],
    [2, 4],
    [1, 4],
    [3, 3],
    [1, 1],
  ] as const) {
    const list = orderCandidates(rows, columns);
    const n = rows * columns;
    assert.ok(list.length <= 6, `${rows}×${columns}`);
    assert.deepEqual(list[0], [...Array(n).keys()]);
    assert.equal(new Set(list.map((s) => s.join())).size, list.length);
    for (const s of list) assert.ok(isPerm(s, n), `${rows}×${columns}: ${s.join()}`);
  }
  assert.deepEqual(orderCandidates(2, 3), [
    [0, 1, 2, 3, 4, 5],
    [3, 4, 5, 0, 1, 2],
    [2, 1, 0, 5, 4, 3],
    [5, 4, 3, 2, 1, 0],
    [1, 2, 3, 4, 5, 0],
    [5, 0, 1, 2, 3, 4],
  ]);
  // One row: reversing rows changes nothing, so only 4 remain.
  assert.equal(orderCandidates(1, 4).length, 4);
  // Square: the transpose is offered (and the cap drops the last shift).
  assert.deepEqual(orderCandidates(3, 3)[4], [0, 3, 6, 1, 4, 7, 2, 5, 8]);
  assert.deepEqual(orderCandidates(1, 1), [[0]]);
});

test('key order: simulated paint and the corrected map both put number p at position p', () => {
  const map = [11, 12, 13, 14, 6, 7, 8, 9]; // AKP05E as a Stream Deck +
  const n = map.length;
  const identity = [...Array(n).keys()];
  for (const shuffle of orderCandidates(2, 4)) {
    const truth = applyOrder(map, shuffle); // a deck wired as `shuffle`
    const sigma = seenAt(identity, map, truth);
    assert.deepEqual(sigma, shuffle);
    // Session: CORA key k gets number inv[k], keyMap untouched (I1).
    assert.deepEqual(seenAt(invertOrder(sigma), map, truth), identity);
    // Save: M' = M[σ] with plain identity paint.
    assert.deepEqual(seenAt(identity, applyOrder(map, sigma), truth), identity);
  }
});

test('key order: a re-pick under simulation composes as σ ∘ σ2', () => {
  const map = [...Array(15).keys()].map((i) => i + 1);
  const [, rowsRev, , , shift] = orderCandidates(3, 5);
  const truth = applyOrder(map, applyOrder(rowsRev ?? [], shift ?? []));
  const first = seenAt([...Array(15).keys()], map, truth);
  // The user wrongly picked rows-reversed; the simulated paint is still shifted.
  const second = seenAt(invertOrder(rowsRev ?? []), map, truth);
  assert.deepEqual(applyOrder(rowsRev ?? [], second), first);
});

test('tapOrder: derives σ from taps, null until a full permutation', () => {
  const sigma = [2, 0, 3, 1];
  // For number n the user taps the cell where the deck shows n.
  const pos = [0, 1, 2, 3].map((num) => sigma.indexOf(num));
  assert.deepEqual(tapOrder(pos, 4), sigma);
  assert.equal(tapOrder(pos.slice(0, 3), 4), null);
  assert.equal(tapOrder([0, 0, 1, 2], 4), null);
  assert.equal(tapOrder([0, 1, 2, 4], 4), null);
});

// --- size ladder ---

/** Answers as a deck with a `panel`-pixel key would: bigger is cut, smaller shows a gap. */
function runLadder(
  start: number,
  answer: (size: number) => SizeAnswer,
): { sizes: number[]; end: ReturnType<typeof sizeStart> } {
  let s = sizeStart(start);
  const sizes = [s.size];
  while (!s.result && sizes.length < 30) {
    s = sizeStep(s, answer(s.size));
    if (!s.result) sizes.push(s.size);
  }
  return { sizes, end: s };
}

const panel =
  (px: number) =>
  (size: number): SizeAnswer => {
    if (size === px) return 'fits';
    return size > px ? 'cut' : 'gap';
  };

test('size ladder: current size joins the ladder, sorted, deduplicated', () => {
  assert.deepEqual(sizeStart(100).ladder, [64, 72, 80, 85, 90, 95, 96, 100, 112, 120]);
  assert.deepEqual(sizeStart(93).ladder, [64, 72, 80, 85, 90, 93, 95, 96, 100, 112, 120]);
});

test('size ladder: AKP153E inherited 112 walks down to 95', () => {
  const { sizes, end } = runLadder(112, panel(95));
  assert.deepEqual(sizes, [112, 100, 96, 95]);
  assert.equal(end.result, 'fits');
  assert.equal(end.size, 95);
});

test('size ladder: walks up on gap (72 → 85)', () => {
  const { sizes, end } = runLadder(72, panel(85));
  assert.deepEqual(sizes, [72, 80, 85]);
  assert.equal(end.result, 'fits');
});

test('size ladder: a reversal bisects the integers in between', () => {
  const below = runLadder(112, panel(93));
  assert.deepEqual(below.sizes, [112, 100, 96, 95, 90, 92, 93]);
  assert.equal(below.end.size, 93);
  const between = runLadder(112, panel(105));
  assert.deepEqual(between.sizes, [112, 100, 106, 103, 104, 105]);
  assert.equal(between.end.result, 'fits');
});

test('size ladder: no exact fit settles on the gap side at adjacency', () => {
  const { sizes, end } = runLadder(112, (size) => (size >= 94 ? 'cut' : 'gap'));
  assert.deepEqual(sizes, [112, 100, 96, 95, 90, 92, 93, 94]);
  assert.equal(end.result, 'gap');
  assert.equal(end.size, 93);
});

test('size ladder: cut at the smallest fails, gap at the largest keeps the largest', () => {
  const small = runLadder(72, panel(50));
  assert.deepEqual(small.sizes, [72, 64]);
  assert.equal(small.end.result, 'fail');
  const large = runLadder(112, panel(130));
  assert.deepEqual(large.sizes, [112, 120]);
  assert.equal(large.end.result, 'gap');
  assert.equal(large.end.size, 120);
});

test('size ladder: a settled state ignores further answers', () => {
  const done = sizeStep(sizeStart(95), 'fits');
  assert.equal(sizeStep(done, 'cut'), done);
});

// --- blank ladder ---

const rungs = (maxBytes: number, quality: number): string[] =>
  blankStart({ maxBytes, quality }).rungs.map((r) => `${r.maxBytes}@${r.quality}`);

test('blank ladder: caps below the current, then lower quality at the last cap', () => {
  // Mirabox 293 (10240, 0.9).
  assert.deepEqual(rungs(10240, 0.9), [
    '8192@0.9',
    '5120@0.9',
    '4096@0.9',
    '4096@0.8',
    '4096@0.7',
    '4096@0.6',
  ]);
  // Uncapped (0) and the AKP05 0xffff cap try every cap.
  for (const cap of [0, 0xffff]) {
    assert.deepEqual(rungs(cap, 0.9).slice(0, 4), [
      '10240@0.9',
      '8192@0.9',
      '5120@0.9',
      '4096@0.9',
    ]);
  }
  // Mirabox 293S (5120, 0.7) and K1 Pro (4096, 0.9).
  assert.deepEqual(rungs(5120, 0.7), ['4096@0.7', '4096@0.6']);
  assert.deepEqual(rungs(4096, 0.9), ['4096@0.8', '4096@0.7', '4096@0.6']);
});

test('blank ladder: visible stops at the rung, still black at the end fails', () => {
  let s = blankStart({ maxBytes: 10240, quality: 0.9 });
  s = blankStep(blankStep(s, false), true);
  assert.equal(s.result, 'fixed');
  assert.deepEqual(s.rungs[s.i], { maxBytes: 5120, quality: 0.9 });
  assert.equal(blankStep(s, false), s);
  let black = blankStart({ maxBytes: 5120, quality: 0.7 });
  black = blankStep(blankStep(black, false), false);
  assert.equal(black.result, 'fail');
  assert.equal(blankStart({ maxBytes: 4096, quality: 0.6 }).result, 'fail');
});

summaryExit();
