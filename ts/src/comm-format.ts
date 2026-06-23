/** Shared formatting for the 'comm' event hex preview: the first 16 bytes as
 *  space-separated two-hex-digit pairs (e.g. "43 52 54 00 ..."). Used by every
 *  emitComm() so the wire-trace UI renders identically across protocols. */
export function formatCommHex(data: Buffer): string {
  return (data.subarray(0, 16) as Buffer).toString('hex').replace(/(..)/g, '$1 ').trim();
}
