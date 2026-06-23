// Minimal Node-Buffer-compatible shim for the txiki.js runtime.
//
// Replaces the npm `buffer` polyfill (~27 kB minified, previously bundled into BOTH the
// main bundle and the embedded USB-worker string). Implements ONLY the Buffer surface
// deckbridge uses (verified across ts/src + ts/test). Backed by a Uint8Array subclass so
// instances pass straight to FFI / TextDecoder / postMessage with no copy.
//
// Codecs use txiki runtime globals: TextEncoder/TextDecoder (utf8) and btoa/atob (base64).
//
// Wired in two ways by ts/build.mjs `shared`:
//   - inject: ['./src/platform/buffer-shim.ts'] → provides the global `Buffer`
//   - alias:  'node:buffer' → this file
// Do NOT rename the exported `Buffer` binding or esbuild's inject will break.

type Encoding = 'utf8' | 'utf-8' | 'ascii' | 'latin1' | 'binary' | 'hex' | 'base64';

const td = new TextDecoder();
const te = new TextEncoder();

function bytesFromString(s: string, enc: Encoding): Uint8Array {
  switch (enc) {
    case 'utf8':
    case 'utf-8':
      return te.encode(s);
    case 'ascii':
    case 'latin1':
    case 'binary': {
      const out = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
      return out;
    }
    case 'hex': {
      const n = s.length >> 1;
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) out[i] = parseInt(s.substring(i * 2, i * 2 + 2), 16);
      return out;
    }
    case 'base64': {
      const bin = atob(s);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    default:
      throw new Error(`buffer-shim: unsupported encoding '${enc as string}'`);
  }
}

// Instance behaviour only. Static factories are attached below (see `Buffer`), NOT declared
// here: declaring a static `from` on a Uint8Array subclass triggers TS2417 (incompatible with
// Uint8Array's generic static `from`).
class BufferClass extends Uint8Array {
  copy(target: Uint8Array, targetStart = 0, sourceStart = 0, sourceEnd = this.length): number {
    const src = this.subarray(sourceStart, sourceEnd);
    const writable = target.length - targetStart;
    const slice = src.length > writable ? src.subarray(0, writable) : src;
    target.set(slice, targetStart);
    return slice.length;
  }

  // Node's Buffer.slice is a VIEW (alias of subarray); Uint8Array.slice COPIES. The previous
  // npm `buffer` polyfill used view semantics, so preserve them.
  override slice(start?: number, end?: number): BufferClass {
    return this.subarray(start, end) as BufferClass;
  }

  // Accepts a single byte (number) OR a subsequence (Uint8Array/Buffer), unlike Uint8Array.indexOf
  // which only takes a number. cora-frame.ts searches for CORA_MAGIC, a 4-byte Buffer.
  override indexOf(value: number | Uint8Array, byteOffset = 0): number {
    if (typeof value === 'number') return super.indexOf(value, byteOffset);
    if (value.length === 0) return Math.min(Math.max(byteOffset, 0), this.length);
    const last = this.length - value.length;
    for (let i = Math.max(byteOffset, 0); i <= last; i++) {
      let j = 0;
      while (j < value.length && this[i + j] === value[j]) j++;
      if (j === value.length) return i;
    }
    return -1;
  }

  readUInt16LE(offset: number): number {
    return this[offset]! | (this[offset + 1]! << 8);
  }

  readUInt32LE(offset: number): number {
    return (
      (this[offset]! |
        (this[offset + 1]! << 8) |
        (this[offset + 2]! << 16) |
        (this[offset + 3]! << 24)) >>>
      0
    );
  }

  readUInt32BE(offset: number): number {
    return (
      ((this[offset]! << 24) |
        (this[offset + 1]! << 16) |
        (this[offset + 2]! << 8) |
        this[offset + 3]!) >>>
      0
    );
  }

  writeUInt8(value: number, offset: number): number {
    this[offset] = value & 0xff;
    return offset + 1;
  }

  writeUInt16LE(value: number, offset: number): number {
    this[offset] = value & 0xff;
    this[offset + 1] = (value >>> 8) & 0xff;
    return offset + 2;
  }

  writeUInt32LE(value: number, offset: number): number {
    this[offset] = value & 0xff;
    this[offset + 1] = (value >>> 8) & 0xff;
    this[offset + 2] = (value >>> 16) & 0xff;
    this[offset + 3] = (value >>> 24) & 0xff;
    return offset + 4;
  }

  // Two's-complement bytes are identical to the unsigned write.
  writeInt32LE(value: number, offset: number): number {
    return this.writeUInt32LE(value >>> 0, offset);
  }

  // Node overloads: write(str, encoding) | write(str, offset, encoding) | write(str, offset, length,
  // encoding). Returns the number of bytes written (clamped to the buffer). Defaults to utf8.
  write(
    value: string,
    offset?: number | Encoding,
    length?: number | Encoding,
    encoding?: Encoding,
  ): number {
    let off = 0;
    let len: number | undefined;
    let enc: Encoding = 'utf8';
    if (typeof offset === 'string') {
      enc = offset;
    } else {
      if (offset !== undefined) off = offset;
      if (typeof length === 'string') enc = length;
      else {
        if (length !== undefined) len = length;
        if (encoding !== undefined) enc = encoding;
      }
    }
    const bytes = bytesFromString(value, enc);
    const writable = Math.max(this.length - off, 0);
    const max = len === undefined ? writable : Math.min(len, writable);
    const n = Math.min(bytes.length, max);
    this.set(bytes.subarray(0, n), off);
    return n;
  }

  override toString(encoding: Encoding = 'utf8', start = 0, end = this.length): string {
    const view = this.subarray(start, end);
    switch (encoding) {
      case 'utf8':
      case 'utf-8':
        return td.decode(view);
      case 'ascii':
      case 'latin1':
      case 'binary': {
        let s = '';
        for (let i = 0; i < view.length; i++) s += String.fromCharCode(view[i]!);
        return s;
      }
      case 'hex': {
        let s = '';
        for (let i = 0; i < view.length; i++) s += view[i]!.toString(16).padStart(2, '0');
        return s;
      }
      case 'base64': {
        let bin = '';
        const CHUNK = 0x8000;
        for (let i = 0; i < view.length; i += CHUNK)
          bin += String.fromCharCode(...view.subarray(i, i + CHUNK));
        return btoa(bin);
      }
      default:
        throw new Error(`buffer-shim: unsupported toString encoding '${encoding as string}'`);
    }
  }
}

function alloc(size: number, fill = 0): BufferClass {
  const b = new BufferClass(size);
  if (fill !== 0) b.fill(fill);
  return b;
}

function from(
  value: string | ArrayBuffer | ArrayLike<number> | Uint8Array,
  arg2?: Encoding | number,
  arg3?: number,
): BufferClass {
  if (typeof value === 'string') {
    const bytes = bytesFromString(value, typeof arg2 === 'string' ? arg2 : 'utf8');
    const b = new BufferClass(bytes.length);
    b.set(bytes);
    return b;
  }
  if (value instanceof ArrayBuffer) {
    const offset = typeof arg2 === 'number' ? arg2 : 0;
    const length = arg3 ?? value.byteLength - offset;
    const b = new BufferClass(length);
    b.set(new Uint8Array(value, offset, length));
    return b;
  }
  const src = value instanceof Uint8Array ? value : Uint8Array.from(value);
  const b = new BufferClass(src.length);
  b.set(src);
  return b;
}

function concat(list: readonly Uint8Array[], totalLength?: number): BufferClass {
  let total = totalLength;
  if (total === undefined) {
    total = 0;
    for (const x of list) total += x.length;
  }
  const out = new BufferClass(total);
  let off = 0;
  for (const x of list) {
    if (off >= total) break;
    if (off + x.length <= total) {
      out.set(x, off);
      off += x.length;
    } else {
      out.set(x.subarray(0, total - off), off);
      break;
    }
  }
  return out;
}

interface BufferConstructor {
  new (length: number): BufferClass;
  new (buffer: ArrayBufferLike, byteOffset?: number, length?: number): BufferClass;
  alloc(size: number, fill?: number): BufferClass;
  from(
    value: string | ArrayBuffer | ArrayLike<number> | Uint8Array,
    arg2?: Encoding | number,
    arg3?: number,
  ): BufferClass;
  concat(list: readonly Uint8Array[], totalLength?: number): BufferClass;
  readonly prototype: BufferClass;
}

// The instance type (the codebase refers to `Buffer` as a type widely).
/** @public — re-exported as the ambient global `Buffer` type via globals.d.ts; knip can't trace ambient re-exports */
export type Buffer = BufferClass;

// The runtime value: constructor + static factories. Object.assign shadows Uint8Array's inherited
// static `from`/`of` with ours at runtime; the cast narrows to the public shape and sidesteps the
// Uint8Array static-side mismatch.
export const Buffer = Object.assign(BufferClass, {
  alloc,
  from,
  concat,
}) as unknown as BufferConstructor;
