import assert from 'tjs:assert';
import {
  imageSrc,
  applyImage,
  clearImage,
  getImageEntry,
  clearImageStore,
} from '../src/web/client/key-preview.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${(e as Error).message}`);
    failed++;
  }
}

// ── imageSrc ──────────────────────────────────────────────────────────────────

console.log('\nimageSrc');

test('no data → versioned server URL', () => {
  assert.ok(imageSrc(3, { v: 7 }) === '/api/image/3?v=7');
});

test('data without format → jpeg data URL', () => {
  assert.ok(imageSrc(0, { v: 1, data: 'AAAA' }) === 'data:image/jpeg;base64,AAAA');
});

test('data with format jpeg → jpeg data URL', () => {
  assert.ok(imageSrc(0, { v: 1, data: 'AAAA', format: 'jpeg' }) === 'data:image/jpeg;base64,AAAA');
});

test('data with format bmp → bmp data URL', () => {
  assert.ok(imageSrc(5, { v: 2, data: 'QkF0', format: 'bmp' }) === 'data:image/bmp;base64,QkF0');
});

test('empty-string data falls back to server URL', () => {
  assert.ok(imageSrc(1, { v: 4, data: '' }) === '/api/image/1?v=4');
});

// ── image store ───────────────────────────────────────────────────────────────

console.log('\nimage store');

test('applyImage stores the entry', () => {
  clearImageStore();
  applyImage(2, { v: 1, data: 'xyz', format: 'jpeg' });
  const e = getImageEntry(2);
  assert.ok(e !== undefined && e.v === 1 && e.data === 'xyz' && e.format === 'jpeg');
});

test('applyImage overwrites an existing entry', () => {
  clearImageStore();
  applyImage(2, { v: 1, data: 'xyz' });
  applyImage(2, { v: 2 });
  const e = getImageEntry(2);
  assert.ok(e !== undefined && e.v === 2 && e.data === undefined);
});

test('clearImage removes the entry', () => {
  clearImageStore();
  applyImage(4, { v: 1 });
  clearImage(4);
  assert.ok(getImageEntry(4) === undefined);
});

test('clearImage on a missing key is a no-op', () => {
  clearImageStore();
  clearImage(9);
  assert.ok(getImageEntry(9) === undefined);
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) tjs.exit(1);
