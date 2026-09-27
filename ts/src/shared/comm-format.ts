/** " 00".." ff", precomputed. The leading space is baked in so the loop does one
 *  concat per byte, not two; the first byte's space is sliced off at the end. */
const HEX = Array.from({ length: 256 }, (_, b) => ` ${b.toString(16).padStart(2, '0')}`);

/** Shared formatting for the 'comm' event hex preview: the first 16 bytes as
 *  space-separated two-hex-digit pairs (e.g. "43 52 54 00 ..."). Used by every
 *  emitComm() so the wire-trace UI renders identically across protocols.
 *
 *  Indexes `data` directly instead of `subarray(0, 16).toString('hex')` + a regex
 *  replace (each subarray species-constructs a shim instance). Runs twice per CORA
 *  image chunk on the ACK-paced path; 32.85 us -> 3.40 us per call. */
export function formatCommHex(data: Buffer): string {
  const n = data.length < 16 ? data.length : 16;
  let s = '';
  for (let i = 0; i < n; i++) s += HEX[data[i]!]!;
  return s.slice(1);
}
