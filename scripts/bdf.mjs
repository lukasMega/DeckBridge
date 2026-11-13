// Minimal BDF reader shared by gen-font-atlas.mjs and font-sheet.mjs (dev-only).

/** Parse a BDF into its font metrics and glyphs. Each glyph keeps its own box:
 *  `rows` are `h` arrays of `w` booleans, top→bottom; `x`/`y` are the BBX offsets
 *  from the pen origin (y up from the baseline); `advance` is DWIDTH. */
export function parseBdf(text) {
  const lines = text.split('\n');
  const font = { fbb: null, ascent: 0, descent: 0, pixelSize: 0, glyphs: new Map() };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('FONTBOUNDINGBOX ')) {
      font.fbb = line.split(/\s+/).slice(1, 5).map(Number);
    } else if (line.startsWith('FONT_ASCENT ')) font.ascent = Number(line.slice(12));
    else if (line.startsWith('FONT_DESCENT ')) font.descent = Number(line.slice(13));
    else if (line.startsWith('PIXEL_SIZE ')) font.pixelSize = Number(line.slice(11));
    else if (line.startsWith('STARTCHAR')) {
      let encoding = -1;
      let bbx = null;
      let advance = 0;
      const hex = [];
      for (i++; !lines[i].startsWith('ENDCHAR'); i++) {
        const l = lines[i];
        if (l.startsWith('ENCODING ')) encoding = Number(l.split(/\s+/)[1]);
        else if (l.startsWith('DWIDTH ')) advance = Number(l.split(/\s+/)[1]);
        else if (l.startsWith('BBX ')) bbx = l.split(/\s+/).slice(1, 5).map(Number);
        else if (l.trim() === 'BITMAP') {
          for (i++; !lines[i].startsWith('ENDCHAR'); i++) hex.push(lines[i].trim());
          break;
        }
      }
      if (encoding < 0 || !bbx) continue;
      const [w, h, x, y] = bbx;
      const rows = hex.slice(0, h).map((r) => {
        const bits = BigInt(`0x${r || '0'}`)
          .toString(2)
          .padStart(r.length * 4, '0');
        return Array.from({ length: w }, (_, c) => bits[c] === '1');
      });
      font.glyphs.set(encoding, { advance, w, h, x, y, rows });
    }
  }
  if (!font.fbb) throw new Error('no FONTBOUNDINGBOX');
  if (!font.ascent) font.ascent = font.fbb[1] + font.fbb[3];
  if (!font.descent) font.descent = -font.fbb[3];
  return font;
}
