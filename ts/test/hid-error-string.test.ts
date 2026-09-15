/** readWideString() decodes hidapi's `wchar_t*` error strings. Read as a C string
 *  they truncate at the first NUL byte ("Device disconnected" → "D"), which is what
 *  this guards against. Pointers come from real TypedArray memory via
 *  FFI.bufferToPointer, so the reads exercise the same path as a live hid_error(). */
import assert from 'tjs:assert';
import FFI from 'tjs:ffi';
import { readWideString } from '../src/ffi/wide-string.js';

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

/** Encode `text` the way the host platform's libc would: UTF-32LE everywhere except
 *  Windows (UTF-16LE). Matches WCHAR_BYTES in hidapi.ts. */
function wide(text: string): Uint8Array {
  const bytes = FFI.suffix === 'dll' ? 2 : 4;
  const buf = new Uint8Array((text.length + 1) * bytes);
  const view = new DataView(buf.buffer);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (bytes === 2) view.setUint16(i * 2, code, true);
    else view.setUint32(i * 4, code, true);
  }
  return buf;
}

console.log('\nhidapi: wide error-string decoding');

test('a full message survives (no truncation at the first NUL byte)', () => {
  const buf = wide('Device disconnected');
  assert.equal(readWideString(FFI.bufferToPointer(buf)), 'Device disconnected');
});

test('empty string reads as null, not ""', () => {
  const buf = wide('');
  assert.equal(readWideString(FFI.bufferToPointer(buf)), null);
});

test('maxChars caps the scan', () => {
  const buf = wide('abcdef');
  assert.equal(readWideString(FFI.bufferToPointer(buf), 3), 'abc');
});

test('null pointer reads as null', () => {
  assert.equal(readWideString(null), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
tjs.exit(failed > 0 ? 1 : 0);
