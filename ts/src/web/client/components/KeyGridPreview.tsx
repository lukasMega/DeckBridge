// Key-grid preview card — shared by the simple stages/dock cards and the
// advanced grid section. Wraps the imperative KeyPreview renderer; the extra
// options (showIndex/flash/onKeyClick/clickable) default off so the simple
// view's behavior is unchanged.
import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { KeyPreview } from '../key-preview.js';
import { attachTouchCanvas } from '../touch-strip-preview.js';
import type { TouchStripSize } from '../ui-types.js';
import { previewLayout } from '../ui-helpers.js';

/** Live strip under the keys; the canvas keeps the app's native pixel size and
 *  CSS scales it, so frame regions map 1:1. */
function TouchStripPreview({ width, height }: Readonly<TouchStripSize>): preact.JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null);
  // Re-attach on a size change: resizing a canvas wipes it.
  useEffect(
    function attachStrip() {
      const el = ref.current;
      return el ? attachTouchCanvas(el) : undefined;
    },
    [width, height],
  );
  return (
    <canvas
      ref={ref}
      class="touch-strip-preview"
      width={width}
      height={height}
      style={`aspect-ratio:${width}/${height}`}
      aria-label="Touch strip preview"
    />
  );
}

export function KeyGridPreview({
  keyCount: deviceKeyCount,
  columns: deviceColumns,
  dimmed,
  modelId,
  coraProfile,
  label = 'Live preview',
  showIndex,
  flash,
  onKeyClick,
  gesture,
  clickable,
  clickTitle,
  touchStrip,
  footer,
}: Readonly<{
  keyCount: number;
  columns: number;
  dimmed: boolean;
  modelId?: string;
  /** Re-paired CORA profile; selects the preview orientation for that desktop profile. */
  coraProfile?: string;
  /** Header label (left side of the card head). */
  label?: string;
  /** Render the key index in each cell (advanced grid). */
  showIndex?: boolean;
  /** Flash a cell border on key press (advanced grid). */
  flash?: boolean;
  /** Cell click handler (advanced grid, simple-view selected dock). */
  onKeyClick?: (index: number) => void;
  /** Which gesture fires `onKeyClick`; default 'click'. */
  gesture?: 'click' | 'dblclick';
  /** Toggle the clickable cell state; undefined = never touched. */
  clickable?: boolean;
  /** Tooltip for every cell ('' clears it); undefined leaves titles alone. */
  clickTitle?: string;
  /** Advertised touch-strip size; shows the live strip under the keys. */
  touchStrip?: TouchStripSize;
  /** Controls displayed below the keys and touch strip. */
  footer?: ComponentChildren;
}>): preact.JSX.Element {
  const { keyCount, columns } = previewLayout(deviceKeyCount, deviceColumns, modelId);
  const isCompact = keyCount === 6;
  const gridRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<KeyPreview | null>(null);

  /* eslint-disable @eslint-react/exhaustive-deps -- intentional mount-only: creates KeyPreview once; prop changes handled by the effect below */
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    // Create the KeyPreview instance once; broadcast() auto-prunes on disconnect
    const kp = new KeyPreview(el, { showIndex, flash, onKeyClick, gesture });
    previewRef.current = kp;
    kp.setModel(modelId, coraProfile);
    kp.rebuild(keyCount, columns);
    if (clickable !== undefined) kp.setClickable(clickable, clickTitle);
  }, []);
  /* eslint-enable @eslint-react/exhaustive-deps */

  // Update model + rebuild on prop changes (rebuild recreates the cells, so
  // the clickable state must be re-applied afterwards, in the same effect)
  useEffect(() => {
    const kp = previewRef.current;
    if (!kp) return;
    kp.setModel(modelId, coraProfile);
    kp.rebuild(keyCount, columns);
    if (clickable !== undefined) kp.setClickable(clickable, clickTitle);
  }, [keyCount, columns, modelId, coraProfile, clickable, clickTitle]);

  const cls = 'preview panel-inset' + (isCompact ? ' compact' : '') + (dimmed ? ' dimmed' : '');

  return (
    <div class={cls}>
      <div class="preview-head">
        <span class="preview-label">{label}</span>
        <span class="live-dot">{dimmed ? 'Paused' : 'Live'}</span>
      </div>
      <div ref={gridRef} />
      {touchStrip && <TouchStripPreview width={touchStrip.width} height={touchStrip.height} />}
      {footer}
    </div>
  );
}

/** Inert grid of the device's key layout: a thumbnail with no live images. */
export function KeyGridSkeleton({
  keyCount,
  columns,
  modelId,
}: Readonly<{ keyCount: number; columns: number; modelId?: string }>): preact.JSX.Element {
  const layout = previewLayout(keyCount, columns, modelId);
  return (
    <span class="key-grid" style={`grid-template-columns:repeat(${layout.columns},1fr)`}>
      {Array.from({ length: layout.keyCount }, (_, i) => (
        <span class="key-cell" key={i} />
      ))}
    </span>
  );
}
