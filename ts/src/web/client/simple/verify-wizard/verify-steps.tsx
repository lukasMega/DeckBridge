// Verify wizard parts the steps share (plan "Wizard flow" 1–8): the question and picture
// tables, the key-number mini grid and small helpers. The step logic is in verify-modal.tsx.
import type { VerifyRotate, VerifySpec } from '../../../contract-verify.js';
import { tileColor, tileUrl, type PatternKind } from './pattern.js';

export type VerifyImage = VerifySpec['image'];

/** Question, then `pick:label:picture` options (picture optional, from PICTURES). The pick
 *  is what the report records. */
export const ASK: Record<string, string> = {
  visible:
    'Do all keys show a number?|all:Yes:ok|some:Some are black:dark|none:All are black:black|garbled:Garbled:noise',
  blank: 'All keys show a number now?|yes:Yes:ok|no:No:dark',
  orient: 'Which one matches your keys?',
  upright: 'Upright now?|yes:Yes:tile|no:No:turned',
  colours: 'Colours, left to right?|rgb:Red, green, blue:rgb|bgr:Blue, green, red:bgr|other:Other',
  order: 'Which layout matches your deck?|tap:None',
  ordered: 'Numbers in order now?|yes:Yes:ok|no:No:mixed',
  size: 'What do the rings show?|fits:All rings, no gap:rings|cut:Outer ring cut off:cut|gap:Black gap outside:gap|other:Other',
  confirm: 'All keys look right?|yes:Yes, save:ok|no:No:one',
  redo: 'What is wrong?|visible:Black keys:dark|orient:Rotated:turned|order:Order:mixed|size:Edges:cut',
  real: 'Do your Stream Deck images look right?|yes:Yes:tile|cut:Edges cut:zoomed|wrong:Wrong place:mixed',
  buttons: 'Does each press act on the right key?|yes:Yes|no:No|skip:Skip',
};

type Tile = [PatternKind, VerifyRotate?, number?, boolean?];

/** Option pictures. Strings are 3×3 key grids (digit = key number, k = black key,
 *  x = garbled key); arrays are tiles: pattern, rotate, zoom, mirrored. */
const PICTURES: Record<string, string | Tile> = {
  ok: '012345678',
  dark: '0k234k67k',
  black: 'kkkkkkkkk',
  noise: 'xxxxxxxxx',
  mixed: '201534867',
  one: '0123k5678',
  tile: ['index'],
  turned: ['index', 90],
  zoomed: ['index', 0, 1.5],
  rgb: ['rgb'],
  bgr: ['rgb', 0, 1, true],
  rings: ['rings'],
  cut: ['rings', 0, 1.2],
  gap: ['rings', 0, 0.7],
};

/** Grid cell codes → MiniGrid cell value: x −3 (garbled), k −2 (black), _ −1 (empty). */
const CELLS = 'xk_0123456789';
/** Styles of cell values −3 and −2. */
const CELL_LOOK = [
  'background:repeating-linear-gradient(45deg,#000 0 2px,#999 0 4px)',
  'background:#000',
];

const THUMBS = new Map<string, string>();

/** A 48 px tile as a data URL, cached: toDataURL per render is wasteful. Null without a
 *  canvas (not cached, so a later canvas still gets drawn). */
export function thumb(
  kind: PatternKind,
  rotate: VerifyRotate = 0,
  zoom = 1,
  flipH = false,
): string | null {
  const key = `${kind}${rotate}${zoom}${flipH}`;
  const url = THUMBS.get(key) ?? tileUrl(kind, 0, 1, 48, { rotate, flipH }, zoom);
  if (url) THUMBS.set(key, url);
  return url;
}

/** An option's picture (PICTURES name); its caption is the label, so `alt` stays empty. */
export function picture(name?: string): preact.JSX.Element | null {
  const p = name ? PICTURES[name] : undefined;
  if (typeof p === 'string')
    return (
      <MiniGrid count={9} columns={3} cls="verify-thumb" at={(i) => CELLS.indexOf(p[i]!) - 3} />
    );
  const url = p && thumb(...p);
  return url ? <img class="verify-thumb" src={url} alt="" /> : null;
}

/** Schematic of the deck (intro): the app's keys numbered and coloured as the test
 *  pattern; DeckBridge keys (the right column), dials and touch strip dashed, not checked. */
export function DeckPicture({ spec }: Readonly<{ spec: VerifySpec }>): preact.JSX.Element {
  const { rows, columns, keyCount: n, extraKeys, encoders, touchStrip } = spec;
  const keysWide = columns * 24 - 4;
  const strip = touchStrip ? 14 : 0;
  const width = (columns + Math.ceil(extraKeys / rows)) * 24;
  const height = rows * 24 + strip + (encoders ? 20 : 0);
  const parts = [
    extraKeys && 'DeckBridge keys',
    encoders && 'dials',
    touchStrip && 'touch strip',
  ].filter(Boolean);
  const off = parts.length ? `Dashed: ${parts.join(', ')}. Not part of this check.` : '';
  return (
    <>
      <svg
        class="verify-deck"
        viewBox={`-2 -2 ${width} ${height}`}
        width={width * 2}
        role="img"
        aria-label={`Keys 1–${n} in ${rows} rows of ${columns}. ${off}`}
      >
        {Array.from({ length: n + extraKeys }, (_, i) => {
          // Extra keys fill the column(s) right of the app's grid, top to bottom.
          const x = (i < n ? i % columns : columns + Math.floor((i - n) / rows)) * 24;
          const y = (i < n ? Math.floor(i / columns) : (i - n) % rows) * 24;
          return i < n ? (
            <g key={i}>
              <rect x={x} y={y} width="20" height="20" rx="3" fill={tileColor(i, n)} />
              <text x={x + 10} y={y + 14}>
                {i + 1}
              </text>
            </g>
          ) : (
            <rect key={i} class="verify-off" x={x} y={y} width="20" height="20" rx="3" />
          );
        })}
        {touchStrip && (
          <rect class="verify-off" x="0" y={rows * 24} width={keysWide} height="10" rx="3" />
        )}
        {Array.from({ length: encoders }, (_, i) => (
          <circle
            key={i}
            class="verify-off"
            cx={((i + 0.5) * keysWide) / encoders}
            cy={rows * 24 + strip + 8}
            r="8"
          />
        ))}
      </svg>
      <p class="survey-hint">
        The Stream Deck app draws keys 1–{n}. This check tests those. {off}
      </p>
    </>
  );
}

/** Report-friendly name of an orientation: degrees, `m` = mirrored. */
export const tag = (g: { rotate: number; flipH: boolean }): string =>
  `${g.rotate}${g.flipH ? 'm' : ''}`;

/** The patterns need a 2D canvas that encodes JPEG; some headless browsers return no
 *  context or fall back to PNG. */
export const canDraw = (): boolean =>
  tileUrl('index', 0, 1, 8, { rotate: 0, flipH: false })?.startsWith('data:image/jpeg') === true;

/** Fields that differ from the effective image: the rest stays inherited. */
export function changed(base: VerifyImage, next: VerifyImage): Partial<VerifyImage> {
  return Object.fromEntries(
    Object.entries(next).filter(([k, v]) => base[k as keyof VerifyImage] !== v),
  );
}

/** Key numbers as the deck shows them: cell p shows number at(p); −1 = none yet (tap
 *  mode), −2 = black, −3 = garbled. */
export function MiniGrid({
  count,
  columns,
  at,
  cls,
  onTap,
}: Readonly<{
  count: number;
  columns: number;
  at: (cell: number) => number;
  /** Extra class beside `verify-grid`. */
  cls?: string;
  onTap?: (cell: number) => void;
}>): preact.JSX.Element {
  return (
    <span
      class={cls === undefined ? 'verify-grid' : `verify-grid ${cls}`}
      style={`grid-template-columns:repeat(${columns},1fr)`}
    >
      {Array.from({ length: count }, (_, p) => {
        const n = at(p);
        const style = n < 0 ? CELL_LOOK[n + 3] : `background:${tileColor(n, count)}`;
        const label = n < 0 ? '' : n + 1;
        return onTap ? (
          <button key={p} type="button" style={style} onClick={() => onTap(p)}>
            {label}
          </button>
        ) : (
          <i key={p} style={style}>
            {label}
          </i>
        );
      })}
    </span>
  );
}
