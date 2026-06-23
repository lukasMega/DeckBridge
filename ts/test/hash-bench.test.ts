// Benchmark: BigInt FNV-64 (current) vs plain-number FNV-32 (candidate)
// Run via: node build.mjs --test hash-bench && $TJS run dist/test/hash-bench.js

// ── Implementations under test ────────────────────────────────────────────────

function hashBigInt(buf: Uint8Array): string {
  let h = 0xcbf29ce484222325n;
  for (const b of buf) h = BigInt.asUintN(64, (h ^ BigInt(b)) * 0x100000001b3n);
  return h.toString(16).padStart(16, '0');
}

function hashFnv32(buf: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < buf.length; i++) {
    h ^= buf[i]!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// ── Buffers: small (test fixture), medium (light key JPEG), large (heavy key JPEG) ──

const S = 570; // 16×16 JPEG
const M = 16_000; // ~16 KB — typical 120×120 key image
const L = 40_000; // ~40 KB — high-quality 120×120 key image

const bufs = [new Uint8Array(S), new Uint8Array(M), new Uint8Array(L)];
for (const b of bufs) for (let i = 0; i < b.length; i++) b[i] = (i * 31 + 17) & 0xff;

// ── Benchmark harness ─────────────────────────────────────────────────────────

function bench(label: string, fn: () => void, iters: number): number {
  // warm-up
  for (let i = 0; i < Math.min(iters >> 2, 10); i++) fn();
  const t0 = Date.now();
  for (let i = 0; i < iters; i++) fn();
  const ms = Date.now() - t0;
  const perOp = ms / iters;
  console.log(
    `  ${label.padEnd(22)}: ${String(ms).padStart(5)}ms / ${iters} iters = ${perOp.toFixed(2)}ms/op`,
  );
  return ms;
}

// ── Run ───────────────────────────────────────────────────────────────────────

console.log('\n=== hashJpeg benchmark (QuickJS / txiki.js) ===\n');

const ITERS_S = 500;
const ITERS_M = 100;
const ITERS_L = 50;

console.log(`[${S} B — small test JPEG]`);
const sB = bench('BigInt FNV-64 (before)', () => hashBigInt(bufs[0]!), ITERS_S);
const sF = bench('Number FNV-32 (after) ', () => hashFnv32(bufs[0]!), ITERS_S);
console.log(`  speedup: ${(sB / sF).toFixed(1)}×\n`);

console.log(`[${M / 1000} KB — medium key JPEG]`);
const mB = bench('BigInt FNV-64 (before)', () => hashBigInt(bufs[1]!), ITERS_M);
const mF = bench('Number FNV-32 (after) ', () => hashFnv32(bufs[1]!), ITERS_M);
console.log(`  speedup: ${(mB / mF).toFixed(1)}×\n`);

console.log(`[${L / 1000} KB — large key JPEG]`);
const lB = bench('BigInt FNV-64 (before)', () => hashBigInt(bufs[2]!), ITERS_L);
const lF = bench('Number FNV-32 (after) ', () => hashFnv32(bufs[2]!), ITERS_L);
console.log(`  speedup: ${(lB / lF).toFixed(1)}×\n`);

// 15-key burst: simulates a full scene switch
console.log('[15-key burst × large JPEG — scene switch simulation]');
const BURST_ITERS = 20;
const bB = bench(
  'BigInt FNV-64 (before)',
  () => {
    for (let k = 0; k < 15; k++) hashBigInt(bufs[2]!);
  },
  BURST_ITERS,
);
const bF = bench(
  'Number FNV-32 (after) ',
  () => {
    for (let k = 0; k < 15; k++) hashFnv32(bufs[2]!);
  },
  BURST_ITERS,
);
console.log(`  speedup: ${(bB / bF).toFixed(1)}×\n`);

// ── Correctness: both must be deterministic and collision-resistant enough ────

let failed = 0;

function pass(label: string): void {
  console.log(`  ${label}: OK`);
}
function fail(label: string): void {
  console.log(`  ${label}: FAIL`);
  failed++;
}

console.log('correctness:');
const hA = hashBigInt(bufs[1]!);
const hB = hashFnv32(bufs[1]!);
const hA2 = hashBigInt(bufs[1]!);
const hB2 = hashFnv32(bufs[1]!);
(hA === hA2 ? pass : fail)('BigInt deterministic ');
(hB === hB2 ? pass : fail)('FNV-32 deterministic ');
// Different buffers must hash differently
const hA_other = hashBigInt(bufs[2]!);
const hB_other = hashFnv32(bufs[2]!);
(hA !== hA_other ? pass : fail)('BigInt collision-free');
(hB !== hB_other ? pass : fail)('FNV-32 collision-free');

tjs.exit(failed > 0 ? 1 : 0);
