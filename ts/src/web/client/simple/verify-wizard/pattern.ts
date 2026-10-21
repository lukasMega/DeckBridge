// Verify-wizard test patterns (plan "Test patterns"): drawn upright, then oriented by the
// same canvas matrix for device frames (P, as the app pre-orients) and thumbnails (g).
import type { VerifyPaintBody, VerifySpec } from '../../../contract-verify.js';
import { invertOrder, orientMatrix, type RawOrientation } from './verify-math.js';

export type PatternKind = 'index' | 'rgb' | 'rings';

/** Background of key number n, so a WebUI mini-grid can match what the deck shows. */
export const tileColor = (n: number, count: number): string =>
  `hsl(${Math.round((n * 360) / count)},70%,38%)`;

function drawUpright(
  g: CanvasRenderingContext2D,
  kind: PatternKind,
  n: number,
  count: number,
  s: number,
): void {
  if (kind === 'rgb') {
    ['#f00', '#0f0', '#00f'].forEach((c, i) => {
      g.fillStyle = c;
      g.fillRect(Math.floor((i * s) / 3), 0, Math.ceil(s / 3), s);
    });
    return;
  }
  g.fillStyle = kind === 'rings' ? '#000' : tileColor(n, count);
  g.fillRect(0, 0, s, s);
  g.fillStyle = '#fff';
  if (kind === 'rings') {
    g.lineWidth = 2;
    ['#f00', '#ff0', '#0f0', '#0ff'].forEach((c, i) => {
      g.strokeStyle = c;
      g.strokeRect(i * 4 + 1, i * 4 + 1, s - i * 8 - 2, s - i * 8 - 2);
    });
    g.fillRect(s / 2 - 1, s / 3, 2, s / 3);
    g.fillRect(s / 3, s / 2 - 1, s / 3, 2);
    return;
  }
  // Arrow + "F" at the top: no symmetry, so each of the 8 orientations looks different.
  g.beginPath();
  g.moveTo(s * 0.1, s * 0.32);
  g.lineTo(s * 0.24, s * 0.06);
  g.lineTo(s * 0.38, s * 0.32);
  g.fill();
  g.textAlign = 'center';
  g.font = `bold ${Math.round(s * 0.3)}px sans-serif`;
  g.fillText('F', s * 0.7, s * 0.32);
  g.font = `bold ${Math.round(s * 0.42)}px sans-serif`;
  g.fillText(String(n + 1), s / 2, s * 0.86);
}

/** o(tile) for 0-based key number n as a JPEG data URL: device frames and thumbnails
 *  alike. Keys are square (non-square sizes are out of scope). Null without a 2D canvas
 *  (headless test browsers). `zoom` (option pictures) scales about the centre: above 1
 *  the edges are cut off, below 1 a black border shows (JPEG has no alpha). */
export function tileUrl(
  kind: PatternKind,
  n: number,
  count: number,
  size: number,
  o: RawOrientation,
  zoom = 1,
): string | null {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  if (!g) return null;
  const c = size / 2;
  g.setTransform(...orientMatrix(o, size, size));
  g.translate(c, c);
  g.scale(zoom, zoom);
  g.translate(-c, -c);
  drawUpright(g, kind, n, count, size);
  return canvas.toDataURL('image/jpeg', 0.92);
}

/** VerifyPaintBody keys: base64 JPEG frames pre-oriented by P. With an order σ, CORA key
 *  σ[p] shows number p (key order simulated, I1). Null without a 2D canvas. */
export function patternKeys(
  kind: PatternKind,
  spec: Pick<VerifySpec, 'keyCount' | 'sourceSize' | 'frameOrientation'>,
  order?: readonly number[],
): VerifyPaintBody['keys'] | null {
  const inv = order && invertOrder(order);
  const keys: VerifyPaintBody['keys'] = [];
  for (let key = 0; key < spec.keyCount; key++) {
    const url = tileUrl(
      kind,
      inv?.[key] ?? key,
      spec.keyCount,
      spec.sourceSize.width,
      spec.frameOrientation,
    );
    if (!url) return null;
    keys.push({ key, data: url.slice(url.indexOf(',') + 1) });
  }
  return keys;
}
