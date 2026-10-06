const FNV_PRIME = 0x01000193;

function fnv1aRange(buf: Uint8Array, start: number, end: number, h: number): number {
  for (let i = start; i < end; i++) {
    h ^= buf[i]!;
    h = Math.imul(h, FNV_PRIME) >>> 0;
  }
  return h;
}

// murmur3 fmix32
function fmix32(h: number): number {
  h = (h ^ (h >>> 16)) >>> 0;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

// Hashes the FULL buffer, word-wise. Sampling was tried and reverted (black-icon
// collision); byte-wise was slower than the transform it guards. Both, plus the
// xorshift caveat: docs/image-flow.md#image-cache-hash
export function hashJpeg(bytes: Uint8Array): string {
  // Persisted page fingerprints must not depend on pooled-buffer alignment.
  const buf = (bytes.byteOffset & 3) === 0 ? bytes : new Uint8Array(bytes);
  // Length mixed in so same-prefix buffers of different lengths differ.
  let h = Math.imul(0x811c9dc5 ^ buf.length, FNV_PRIME) >>> 0;

  const words = buf.length >>> 2;
  const u32 = new Uint32Array(buf.buffer, buf.byteOffset, words);
  for (let w = 0; w < words; w++) {
    h = Math.imul(h ^ u32[w]!, FNV_PRIME) >>> 0;
    // Load-bearing: FNV_PRIME carries bits upward only, so without this a word's
    // top-byte delta never leaves its lane. 5053 collisions per 20k without, 0 with.
    h = (h ^ (h >>> 15)) >>> 0;
  }
  h = fnv1aRange(buf, words << 2, buf.length, h);

  return fmix32(h).toString(16).padStart(8, '0');
}
