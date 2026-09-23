// Key-grid preview card — shared by the simple stages/dock cards and the
// advanced grid section. Wraps the imperative KeyPreview renderer; the extra
// options (showIndex/flash/onKeyClick/clickable) default off so the simple
// view's behavior is unchanged.
//
// `live={false}` renders the same card chrome with inert cells and no renderer:
// the server mirrors only the selected dock's images, so unselected dock cards
// need the shell but not a KeyPreview instance.
import { useEffect, useRef } from 'preact/hooks';
import { KeyPreview } from '../key-preview.js';

export function KeyGridPreview({
  keyCount,
  columns,
  dimmed,
  modelId,
  coraProfile,
  label = 'Live preview',
  live = true,
  badge,
  showIndex,
  flash,
  onKeyClick,
  clickable,
}: Readonly<{
  keyCount: number;
  columns: number;
  dimmed: boolean;
  modelId?: string;
  /** Re-paired CORA profile; selects the preview orientation for that desktop profile. */
  coraProfile?: string;
  /** Header label (left side of the card head). */
  label?: string;
  /** false = inert cells, no KeyPreview instance (unselected dock cards). */
  live?: boolean;
  /** Overrides the default Live/Paused head badge. */
  badge?: string;
  /** Render the key index in each cell (advanced grid). */
  showIndex?: boolean;
  /** Flash a cell border on key press (advanced grid). */
  flash?: boolean;
  /** Cell click handler (advanced grid, mock mode). */
  onKeyClick?: (index: number) => void;
  /** Toggle the clickable cell state; undefined = never touched (simple view). */
  clickable?: boolean;
}>): preact.JSX.Element {
  const isCompact = keyCount === 6;
  const gridRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<KeyPreview | null>(null);

  /* eslint-disable @eslint-react/exhaustive-deps -- intentional mount-only: creates KeyPreview once; prop changes handled by the effect below */
  useEffect(() => {
    const el = gridRef.current;
    if (!el || !live) return;
    // Create the KeyPreview instance once; broadcast() auto-prunes on disconnect
    const kp = new KeyPreview(el, { showIndex, flash, onKeyClick });
    previewRef.current = kp;
    kp.setModel(modelId, coraProfile);
    kp.rebuild(keyCount, columns);
    if (clickable !== undefined) kp.setClickable(clickable);
  }, []);
  /* eslint-enable @eslint-react/exhaustive-deps */

  // Update model + rebuild on prop changes (rebuild recreates the cells, so
  // the clickable state must be re-applied afterwards, in the same effect)
  useEffect(() => {
    const kp = previewRef.current;
    if (!kp) return;
    kp.setModel(modelId, coraProfile);
    kp.rebuild(keyCount, columns);
    if (clickable !== undefined) kp.setClickable(clickable);
  }, [keyCount, columns, modelId, coraProfile, clickable]);

  const cls = 'preview panel-inset' + (isCompact ? ' compact' : '') + (dimmed ? ' dimmed' : '');

  return (
    <div class={cls}>
      <div class="preview-head">
        <span class="preview-label">{label}</span>
        <span class="live-dot">{badge ?? (dimmed ? 'Paused' : 'Live')}</span>
      </div>
      {live ? (
        <div ref={gridRef} />
      ) : (
        <div class="key-grid" style={`grid-template-columns:repeat(${columns},1fr)`}>
          {Array.from({ length: keyCount }, (_, i) => (
            <div class="key-cell" key={i} />
          ))}
        </div>
      )}
    </div>
  );
}
