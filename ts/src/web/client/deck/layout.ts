// Key grid geometry. Keys are square with a gap of 6 % of the key size, the grid is centred
// and fits the viewport minus safe-area insets. No CSS aspect-ratio / ResizeObserver: both
// are newer than the oldest supported Safari.
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface DeckGeometry {
  size: number;
  gap: number;
  /** Grid origin and extent in viewport pixels. */
  left: number;
  top: number;
  width: number;
  height: number;
}

export const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
const GAP_RATIO = 0.06;
/** Breathing room between the glass edge and the grid. */
const PADDING = 8;

export function computeDeckLayout(
  vw: number,
  vh: number,
  columns: number,
  rows: number,
  insets: Insets = NO_INSETS,
): DeckGeometry {
  const availW = Math.max(1, vw - insets.left - insets.right - PADDING * 2);
  const availH = Math.max(1, vh - insets.top - insets.bottom - PADDING * 2);
  const unitsW = columns + (columns - 1) * GAP_RATIO;
  const unitsH = rows + (rows - 1) * GAP_RATIO;
  const size = Math.max(1, Math.floor(Math.min(availW / unitsW, availH / unitsH)));
  const gap = size * GAP_RATIO;
  const width = columns * size + (columns - 1) * gap;
  const height = rows * size + (rows - 1) * gap;
  return {
    size,
    gap,
    width,
    height,
    left: insets.left + (vw - insets.left - insets.right - width) / 2,
    top: insets.top + (vh - insets.top - insets.bottom - height) / 2,
  };
}

/** Position of key `index` (row-major) inside the grid. */
export function keyOrigin(
  g: DeckGeometry,
  columns: number,
  index: number,
): { x: number; y: number } {
  const col = index % columns;
  const row = Math.floor(index / columns);
  return { x: g.left + col * (g.size + g.gap), y: g.top + row * (g.size + g.gap) };
}
