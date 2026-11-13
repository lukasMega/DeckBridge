// Dev-only TTF helpers shared by font-sheet.mjs and (later) gen-font-atlas.mjs:
// opentype.js loader, download cache, and a deterministic anti-aliased glyph rasterizer.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const CACHE = join(tmpdir(), 'deckbridge-font-sheet');

/** Atlas glyph order: ASCII, Latin-1 (U+00A0–U+00FF), then U+2026 — fontGlyphIndex() order. */
export const ATLAS_CODEPOINTS = [
  ...Array.from({ length: 95 }, (_, i) => 32 + i),
  ...Array.from({ length: 96 }, (_, i) => 0xa0 + i),
  0x2026,
];

/** Fixed (not adaptive) so the committed atlas is byte-identical on every machine. */
const BEZIER_STEPS = 12;
const SUB = 8;
const LEVELS = 15;

export async function fetchCached(url) {
  mkdirSync(CACHE, { recursive: true });
  const file = join(CACHE, url.replace(/[^\w.-]+/g, '_'));
  if (!existsSync(file)) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  return file;
}

/** opentype.js is not a repo dependency: install it into the temp cache on first use. */
export function loadOpentype() {
  const dir = join(CACHE, 'npm');
  if (!existsSync(join(dir, 'node_modules/opentype.js'))) {
    mkdirSync(dir, { recursive: true });
    execFileSync('npm', ['i', '--silent', '--prefix', dir, 'opentype.js@1'], { stdio: 'inherit' });
  }
  return createRequire(join(dir, 'x.js'))('opentype.js');
}

export function loadFace(opentype, file) {
  const buf = readFileSync(file);
  return opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
}

/** Nonzero-winding point-in-polygon over flattened contours. */
export function inside(contours, px, py) {
  let wn = 0;
  for (const pts of contours) {
    for (let i = 0; i < pts.length; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[(i + 1) % pts.length];
      const cross = (x1 - x0) * (py - y0) - (px - x0) * (y1 - y0);
      if (y0 <= py && y1 > py && cross > 0) wn++;
      else if (y0 > py && y1 <= py && cross < 0) wn--;
    }
  }
  return wn !== 0;
}

/** Path commands (y down, baseline at y = 0) → closed polygons of fixed-step flattened curves. */
function flatten(commands) {
  const contours = [];
  let cur = [];
  let last = [0, 0];
  const lerp = (a, b, t) => a + (b - a) * t;
  for (const c of commands) {
    if (c.type === 'M') {
      cur = [[c.x, c.y]];
    } else if (c.type === 'L') {
      cur.push([c.x, c.y]);
    } else if (c.type === 'Q') {
      for (let i = 1; i <= BEZIER_STEPS; i++) {
        const t = i / BEZIER_STEPS;
        const ax = lerp(last[0], c.x1, t);
        const ay = lerp(last[1], c.y1, t);
        cur.push([lerp(ax, lerp(c.x1, c.x, t), t), lerp(ay, lerp(c.y1, c.y, t), t)]);
      }
    } else if (c.type === 'C') {
      for (let i = 1; i <= BEZIER_STEPS; i++) {
        const t = i / BEZIER_STEPS;
        const u = 1 - t;
        cur.push([
          u ** 3 * last[0] + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t ** 3 * c.x,
          u ** 3 * last[1] + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t ** 3 * c.y,
        ]);
      }
    } else if (c.type === 'Z') {
      if (cur.length > 0) contours.push(cur);
      cur = [];
    }
    if (c.x !== undefined) last = [c.x, c.y];
  }
  if (cur.length > 1) contours.push(cur);
  return contours;
}

/** Per-sub-row scanline (one sort per row, not one `inside()` per sample: the 64 px rung
 *  would otherwise cost billions of edge tests). Same nonzero rule as `inside()`. */
function coverage(contours, x0, y0, w, h) {
  const edges = [];
  for (const pts of contours) {
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[(i + 1) % pts.length];
      if (ay !== by) edges.push({ ax, ay, bx, by, lo: Math.min(ay, by), hi: Math.max(ay, by) });
    }
  }
  const cov = new Uint8Array(w * h);
  for (let j = 0; j < h * SUB; j++) {
    const yc = y0 + (j + 0.5) / SUB;
    const xs = [];
    for (const e of edges) {
      if (yc < e.lo || yc >= e.hi) continue;
      xs.push([e.ax + ((yc - e.ay) * (e.bx - e.ax)) / (e.by - e.ay), e.by > e.ay ? 1 : -1]);
    }
    xs.sort((a, b) => a[0] - b[0]);
    let wn = 0;
    for (let i = 0; i < xs.length - 1; i++) {
      wn += xs[i][1];
      if (wn === 0) continue;
      const k0 = Math.max(0, Math.ceil((xs[i][0] - x0) * SUB - 0.5));
      const k1 = Math.min(w * SUB - 1, Math.ceil((xs[i + 1][0] - x0) * SUB - 0.5) - 1);
      for (let k = k0; k <= k1; k++) cov[(j >> 3) * w + (k >> 3)]++;
    }
  }
  return cov;
}

/** Anti-aliased glyph at `px` size: 8×8 subsamples per pixel, nonzero winding, coverage
 *  quantized to 0..15. Tight box: `x` = left edge relative to the pen, `top` = rows above
 *  the baseline (baseline is an integer pixel row boundary). No ink → w = h = 0. */
export function rasterizeAA(face, px, cp, opts = {}) {
  const g = face.charToGlyph(String.fromCodePoint(cp));
  const advance = Math.max(0, Math.round((g.advanceWidth * px) / face.unitsPerEm));
  const empty = { advance, x: 0, top: 0, w: 0, h: 0, alpha: new Uint8Array(0) };
  if (!g || g.index === 0) return opts.missing === 'null' ? null : empty;
  const contours = flatten(g.getPath(0, 0, px).commands);
  const pts = contours.flat();
  if (pts.length === 0) return empty;
  const x0 = Math.floor(Math.min(...pts.map((p) => p[0])) + 1e-9);
  const x1 = Math.ceil(Math.max(...pts.map((p) => p[0])) - 1e-9);
  const y0 = Math.floor(Math.min(...pts.map((p) => p[1])) + 1e-9);
  const y1 = Math.ceil(Math.max(...pts.map((p) => p[1])) - 1e-9);
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return empty;
  const cov = coverage(contours, x0, y0, w, h);
  const alpha = Uint8Array.from(cov, (c) => Math.round((c * LEVELS) / (SUB * SUB)));
  return trim({ advance, x: x0, top: -y0, w, h, alpha });
}

/** Drop fully transparent edge rows/columns so atlas boxes stay tight. */
function trim(g) {
  const { w, h, alpha } = g;
  const colInk = (c) => alpha.some((a, i) => a > 0 && i % w === c);
  const rowInk = (r) => alpha.subarray(r * w, (r + 1) * w).some((a) => a > 0);
  let c0 = 0;
  let c1 = w - 1;
  let r0 = 0;
  let r1 = h - 1;
  while (c0 <= c1 && !colInk(c0)) c0++;
  while (c1 >= c0 && !colInk(c1)) c1--;
  while (r0 <= r1 && !rowInk(r0)) r0++;
  while (r1 >= r0 && !rowInk(r1)) r1--;
  if (c0 > c1 || r0 > r1) return { ...g, x: 0, top: 0, w: 0, h: 0, alpha: new Uint8Array(0) };
  const nw = c1 - c0 + 1;
  const nh = r1 - r0 + 1;
  const out = new Uint8Array(nw * nh);
  for (let r = 0; r < nh; r++)
    out.set(alpha.subarray((r0 + r) * w + c0, (r0 + r) * w + c0 + nw), r * nw);
  return { ...g, x: g.x + c0, top: g.top - r0, w: nw, h: nh, alpha: out };
}

/** Largest px (0.25 steps) whose whole-glyph-set ink — rows above + below the baseline —
 *  fits `lineHeight`, so no glyph of the rung is ever cut. */
export function fitPxForHeight(face, lineHeight, cps = ATLAS_CODEPOINTS) {
  let up = 0;
  let down = 0;
  for (const cp of cps) {
    const g = face.charToGlyph(String.fromCodePoint(cp));
    if (!g || g.index === 0) continue;
    const b = g.getBoundingBox();
    if (b.y2 === 0 && b.y1 === 0) continue;
    up = Math.max(up, b.y2);
    down = Math.max(down, -b.y1);
  }
  const rows = (px) => {
    const s = px / face.unitsPerEm;
    return Math.ceil(up * s - 1e-9) + Math.ceil(down * s - 1e-9);
  };
  for (let px = lineHeight * 2; px > 1; px -= 0.25) if (rows(px) <= lineHeight) return px;
  return 1;
}
