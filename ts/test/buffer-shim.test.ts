import assert from 'tjs:assert';

// Exercises the hand-rolled Buffer shim (src/platform/buffer-shim.ts). `Buffer` here is the global
// injected by esbuild (ts/build.mjs `shared.inject`), i.e. the shim itself — so this validates the
// real wiring, not a separate import. Covers the full surface deckbridge relies on; the protocol
// builders (cora-frame, feature-response, packets, pairing) lean on copy/writeUInt*/toString being
// byte-exact.

let passed = 0;
let failed = 0;

function tst(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${(e as Error).message}`);
    failed++;
  }
}

// Calls with an intentionally-unsupported encoding (type-erased) to test the throw paths.
// eslint-disable-next-line @typescript-eslint/unbound-method -- Buffer.from is a static method; no this-binding risk
const fromLoose = Buffer.from as unknown as (v: string, enc: string) => Buffer;
const toStringLoose = (b: Buffer, enc: string): string =>
  (b as unknown as { toString(e: string): string }).toString(enc);

function expectThrow(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

console.log('\nbuffer-shim: identity / wiring');

tst('alloc/from produce real Uint8Array instances (pass to FFI/TextDecoder)', () => {
  assert.ok(Buffer.alloc(1) instanceof Uint8Array);
  assert.ok(Buffer.from([1]) instanceof Uint8Array);
  assert.ok(Buffer.from('x') instanceof Uint8Array);
});

tst('subarray returns a Buffer (shim methods survive the view)', () => {
  const view = Buffer.from([0xde, 0xad, 0xbe, 0xef]).subarray(0, 2);
  // species ctor → subclass, not a plain Uint8Array (lib types subarray as Uint8Array, hence cast).
  assert.ok(view instanceof Buffer);
  assert.equal((view as Buffer).toString('hex'), 'dead'); // shim method works on the view
});

console.log('\nbuffer-shim: alloc');

tst('alloc(size) is zero-filled and correct length', () => {
  const b = Buffer.alloc(4);
  assert.equal(b.length, 4);
  assert.deepEqual(Array.from(b), [0, 0, 0, 0]);
});

tst('alloc(size, 0) equals alloc(size)', () => {
  assert.deepEqual(Array.from(Buffer.alloc(3, 0)), [0, 0, 0]);
});

tst('alloc(size, fill) fills every byte', () => {
  assert.deepEqual(Array.from(Buffer.alloc(3, 0xab)), [0xab, 0xab, 0xab]);
});

tst('alloc(0) is empty', () => {
  assert.equal(Buffer.alloc(0).length, 0);
});

console.log('\nbuffer-shim: from');

tst('from(number[]) copies the bytes', () => {
  assert.deepEqual(Array.from(Buffer.from([1, 2, 3])), [1, 2, 3]);
});

tst('from(string) defaults to utf8', () => {
  assert.deepEqual(Array.from(Buffer.from('Hi')), [0x48, 0x69]);
});

tst('from(string) utf8 encodes multi-byte chars', () => {
  const b = Buffer.from('café'); // é = 0xC3 0xA9
  assert.equal(b.length, 5);
  assert.deepEqual(Array.from(b), [0x63, 0x61, 0x66, 0xc3, 0xa9]);
});

tst('from(string, "ascii") masks to low byte', () => {
  assert.deepEqual(Array.from(Buffer.from('AB', 'ascii')), [0x41, 0x42]);
});

tst('from(string, "hex") parses byte pairs', () => {
  assert.deepEqual(Array.from(Buffer.from('48656c6c6f', 'hex')), [0x48, 0x65, 0x6c, 0x6c, 0x6f]);
  assert.deepEqual(Array.from(Buffer.from('00ff80', 'hex')), [0x00, 0xff, 0x80]);
});

tst('from(string, "base64") decodes', () => {
  assert.equal(Buffer.from('SGVsbG8=', 'base64').toString(), 'Hello');
});

tst('from(Uint8Array) copies (no aliasing)', () => {
  const src = new Uint8Array([1, 2, 3]);
  const b = Buffer.from(src);
  src[0] = 99;
  assert.deepEqual(Array.from(b), [1, 2, 3]); // unchanged by src mutation
});

tst('from(Buffer) copies', () => {
  const a = Buffer.from([5, 6, 7]);
  const b = Buffer.from(a);
  a[1] = 0;
  assert.deepEqual(Array.from(b), [5, 6, 7]);
});

tst('from(ArrayBuffer) wraps whole buffer', () => {
  const ab = new Uint8Array([10, 20, 30]).buffer;
  assert.deepEqual(Array.from(Buffer.from(ab)), [10, 20, 30]);
});

tst('from(ArrayBuffer, offset, length) honors window', () => {
  const ab = new Uint8Array([10, 20, 30, 40]).buffer;
  assert.deepEqual(Array.from(Buffer.from(ab, 1, 2)), [20, 30]);
});

console.log('\nbuffer-shim: concat');

tst('concat joins in order', () => {
  const out = Buffer.concat([Buffer.from([1, 2]), Buffer.from([3, 4, 5])]);
  assert.deepEqual(Array.from(out), [1, 2, 3, 4, 5]);
});

tst('concat with empty list is empty', () => {
  assert.equal(Buffer.concat([]).length, 0);
});

tst('concat(list, totalLength) truncates', () => {
  const out = Buffer.concat([Buffer.from([1, 2]), Buffer.from([3, 4])], 3);
  assert.deepEqual(Array.from(out), [1, 2, 3]);
});

tst('concat(list, totalLength) zero-pads when short', () => {
  const out = Buffer.concat([Buffer.from([1, 2]), Buffer.from([3, 4])], 6);
  assert.deepEqual(Array.from(out), [1, 2, 3, 4, 0, 0]);
});

console.log('\nbuffer-shim: copy');

tst('copy(target, targetStart) writes at offset, returns count', () => {
  const t = Buffer.alloc(5);
  const n = Buffer.from([1, 2, 3]).copy(t, 1);
  assert.equal(n, 3);
  assert.deepEqual(Array.from(t), [0, 1, 2, 3, 0]);
});

tst('copy with sourceStart/sourceEnd copies a window', () => {
  const t = Buffer.alloc(4);
  const n = Buffer.from([1, 2, 3, 4]).copy(t, 0, 1, 3);
  assert.equal(n, 2);
  assert.deepEqual(Array.from(t), [2, 3, 0, 0]);
});

tst('copy clamps to remaining target space and returns clamped count', () => {
  const t = Buffer.alloc(2);
  const n = Buffer.from([1, 2, 3, 4]).copy(t, 1); // only 1 byte of room
  assert.equal(n, 1);
  assert.deepEqual(Array.from(t), [0, 1]);
});

console.log('\nbuffer-shim: slice (must be a VIEW, like Node Buffer)');

tst('slice returns a view — mutations propagate to the parent', () => {
  const b = Buffer.from([1, 2, 3, 4]);
  const s = b.slice(1, 3);
  assert.deepEqual(Array.from(s), [2, 3]);
  s[0] = 0x99;
  assert.equal(b[1], 0x99); // view, not copy
});

tst('slice with no args views the whole buffer', () => {
  const b = Buffer.from([7, 8]);
  assert.deepEqual(Array.from(b.slice()), [7, 8]);
});

console.log('\nbuffer-shim: indexOf');

tst('indexOf(byte) finds first match', () => {
  assert.equal(Buffer.from([1, 2, 3, 2]).indexOf(2), 1);
});

tst('indexOf(byte, fromIndex) respects offset', () => {
  assert.equal(Buffer.from([1, 2, 3, 2]).indexOf(2, 2), 3);
});

tst('indexOf(byte) returns -1 when absent', () => {
  assert.equal(Buffer.from([1, 2, 3]).indexOf(9), -1);
});

tst('indexOf(0) finds NUL terminator', () => {
  assert.equal(Buffer.from([0x41, 0x42, 0x00, 0x43]).indexOf(0), 2);
});

tst('indexOf(subsequence) finds a multi-byte needle', () => {
  const hay = Buffer.from([0, 1, 2, 3, 1, 2]);
  assert.equal(hay.indexOf(Buffer.from([1, 2])), 1);
});

tst('indexOf(subsequence, fromIndex) finds the later match', () => {
  const hay = Buffer.from([0, 1, 2, 3, 1, 2]);
  assert.equal(hay.indexOf(Buffer.from([1, 2]), 2), 4);
});

tst('indexOf(subsequence) returns -1 when absent', () => {
  assert.equal(Buffer.from([1, 2, 3]).indexOf(Buffer.from([4, 5])), -1);
});

tst('indexOf(empty subsequence) returns clamped offset', () => {
  assert.equal(Buffer.from([1, 2, 3]).indexOf(Buffer.from([]), 1), 1);
});

console.log('\nbuffer-shim: integer reads');

tst('readUInt16LE', () => {
  assert.equal(Buffer.from([0x34, 0x12]).readUInt16LE(0), 0x1234);
});

tst('readUInt32LE', () => {
  assert.equal(Buffer.from([0x78, 0x56, 0x34, 0x12]).readUInt32LE(0), 0x12345678);
});

tst('readUInt32LE is unsigned (high bit set)', () => {
  assert.equal(Buffer.from([0x00, 0x00, 0x00, 0x80]).readUInt32LE(0), 0x80000000);
  assert.equal(Buffer.from([0xff, 0xff, 0xff, 0xff]).readUInt32LE(0), 0xffffffff);
});

tst('readUInt32BE', () => {
  assert.equal(Buffer.from([0x12, 0x34, 0x56, 0x78]).readUInt32BE(0), 0x12345678);
});

tst('readUInt32BE is unsigned (high bit set)', () => {
  assert.equal(Buffer.from([0xff, 0xff, 0xff, 0xff]).readUInt32BE(0), 0xffffffff);
});

tst('read at a non-zero offset', () => {
  assert.equal(Buffer.from([0, 0, 0x34, 0x12]).readUInt16LE(2), 0x1234);
});

console.log('\nbuffer-shim: integer writes');

tst('writeUInt8 writes byte and returns next offset', () => {
  const b = Buffer.alloc(2);
  assert.equal(b.writeUInt8(0xab, 1), 2);
  assert.equal(b[1], 0xab);
});

tst('writeUInt8 masks to one byte', () => {
  const b = Buffer.alloc(1);
  b.writeUInt8(0x1ff, 0);
  assert.equal(b[0], 0xff);
});

tst('writeUInt16LE round-trips via readUInt16LE', () => {
  const b = Buffer.alloc(4);
  assert.equal(b.writeUInt16LE(0xbeef, 1), 3);
  assert.deepEqual(Array.from(b), [0x00, 0xef, 0xbe, 0x00]);
  assert.equal(b.readUInt16LE(1), 0xbeef);
});

tst('writeUInt32LE round-trips via readUInt32LE', () => {
  const b = Buffer.alloc(4);
  assert.equal(b.writeUInt32LE(0xdeadbeef, 0), 4);
  assert.deepEqual(Array.from(b), [0xef, 0xbe, 0xad, 0xde]);
  assert.equal(b.readUInt32LE(0), 0xdeadbeef);
});

tst('writeInt32LE writes two’s complement for negatives', () => {
  const b = Buffer.alloc(4);
  b.writeInt32LE(-1, 0);
  assert.deepEqual(Array.from(b), [0xff, 0xff, 0xff, 0xff]);
  b.writeInt32LE(-2, 0);
  assert.deepEqual(Array.from(b), [0xfe, 0xff, 0xff, 0xff]);
});

tst('writeInt32LE positive matches writeUInt32LE', () => {
  const a = Buffer.alloc(4);
  const c = Buffer.alloc(4);
  a.writeInt32LE(0x01020304, 0);
  c.writeUInt32LE(0x01020304, 0);
  assert.deepEqual(Array.from(a), Array.from(c));
});

console.log('\nbuffer-shim: write(string)');

tst('write(str, offset) writes utf8 bytes, returns count', () => {
  const b = Buffer.alloc(8);
  assert.equal(b.write('AB', 2), 2);
  assert.equal(b[2], 0x41);
  assert.equal(b[3], 0x42);
  assert.equal(b[0], 0x00); // untouched
});

tst('write(str, encoding) overload', () => {
  const b = Buffer.alloc(4);
  assert.equal(b.write('ff', 'hex'), 1);
  assert.equal(b[0], 0xff);
});

tst('write(str, offset, length) caps bytes written', () => {
  const b = Buffer.alloc(8);
  assert.equal(b.write('ABCD', 0, 2), 2);
  assert.deepEqual(Array.from(b.subarray(0, 4)), [0x41, 0x42, 0x00, 0x00]);
});

tst('write clamps at end of buffer', () => {
  const b = Buffer.alloc(4);
  assert.equal(b.write('ABCD', 2), 2); // only 2 bytes of room
  assert.deepEqual(Array.from(b), [0x00, 0x00, 0x41, 0x42]);
});

console.log('\nbuffer-shim: toString');

tst('toString() defaults to utf8', () => {
  assert.equal(Buffer.from([0x48, 0x69]).toString(), 'Hi');
});

tst('toString() decodes multi-byte utf8', () => {
  assert.equal(Buffer.from([0x63, 0x61, 0x66, 0xc3, 0xa9]).toString(), 'café');
});

tst('toString("ascii")', () => {
  assert.equal(Buffer.from([0x41, 0x42, 0x43]).toString('ascii'), 'ABC');
});

tst('toString("hex")', () => {
  assert.equal(Buffer.from([0xde, 0xad, 0xbe, 0xef]).toString('hex'), 'deadbeef');
  assert.equal(Buffer.from([0x00, 0x0f]).toString('hex'), '000f'); // zero-padded nibbles
});

tst('toString("base64")', () => {
  assert.equal(Buffer.from('Hello').toString('base64'), 'SGVsbG8=');
});

tst('toString(encoding, start, end) slices first', () => {
  assert.equal(Buffer.from([0xaa, 0xbb, 0xcc]).toString('hex', 1, 2), 'bb');
});

console.log('\nbuffer-shim: round-trips');

tst('hex round-trip', () => {
  const hex = '00ff8001fe';
  assert.equal(Buffer.from(hex, 'hex').toString('hex'), hex);
});

tst('base64 round-trip over binary bytes', () => {
  const bytes = Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x80, 0x7f]);
  const b64 = bytes.toString('base64');
  assert.deepEqual(Array.from(Buffer.from(b64, 'base64')), Array.from(bytes));
});

tst('base64 round-trip over a larger buffer (chunked fromCharCode path)', () => {
  const big = Buffer.alloc(40000);
  for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 0xff;
  const round = Buffer.from(big.toString('base64'), 'base64');
  assert.deepEqual(Array.from(round), Array.from(big));
});

tst('utf8 round-trip', () => {
  const s = 'mira2el — café ☕';
  assert.equal(Buffer.from(s).toString(), s);
});

console.log('\nbuffer-shim: error handling');

tst('toString rejects an unsupported encoding', () => {
  assert.ok(expectThrow(() => toStringLoose(Buffer.from([1]), 'utf16le')));
});

tst('from rejects an unsupported encoding', () => {
  assert.ok(expectThrow(() => fromLoose('xx', 'utf16le')));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) tjs.exit(1);
