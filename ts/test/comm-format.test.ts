import assert from 'tjs:assert';
import { formatCommHex } from '../src/comm-format.js';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e: unknown) {
    console.error(`  ✗ ${name}: ${(e as Error).message}`);
    failed++;
  }
}

// The implementation formatCommHex replaced, kept so the faster lookup-table version
// is pinned to byte-identical output rather than a few hardcoded strings.
const reference = (data: Buffer): string =>
  (data.subarray(0, 16) as Buffer).toString('hex').replace(/(..)/g, '$1 ').trim();

await test('formats the first 16 bytes as space-separated hex pairs', () => {
  const b = Buffer.from([0x43, 0x52, 0x54, 0x00, 0x0f]);
  assert.equal(formatCommHex(b), '43 52 54 00 0f');
});

await test('pads single-digit bytes to two hex digits', () => {
  assert.equal(formatCommHex(Buffer.from([0x00, 0x01, 0xff])), '00 01 ff');
});

await test('truncates to 16 bytes, with no trailing space', () => {
  const b = Buffer.from(Array.from({ length: 64 }, (_, i) => i));
  const out = formatCommHex(b);
  assert.equal(out.split(' ').length, 16);
  assert.equal(out.endsWith('0f'), true);
});

await test('empty buffer yields an empty string', () => {
  assert.equal(formatCommHex(Buffer.alloc(0)), '');
});

await test('matches the reference implementation across every byte value and length', () => {
  for (let len = 0; len <= 20; len++) {
    const b = Buffer.from(Array.from({ length: len }, (_, i) => (i * 37 + len) & 0xff));
    assert.equal(formatCommHex(b), reference(b), `len=${len}`);
  }
  // every single byte value, in isolation
  for (let v = 0; v < 256; v++) {
    const b = Buffer.from([v]);
    assert.equal(formatCommHex(b), reference(b), `byte=${v}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
tjs.exit(failed > 0 ? 1 : 0);
