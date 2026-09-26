// Image fit applicability + the `?` modal explaining source vs device key size.
import { useState } from 'preact/hooks';
import { ICON } from '../ui-icons.js';
import { useDismiss } from '../ui-hooks.js';

export interface Size {
  width: number;
  height: number;
}

export interface FitApplicability {
  /** Source after the symmetric Crop setting — what the fit step receives. */
  source: Size;
  target: Size;
  /** 'pad' changes the output: source fits inside target and is smaller on an axis. */
  padApplies: boolean;
  /** 'crop' differs from 'pad': source is larger than target on an axis. */
  cropApplies: boolean;
}

/** Which fit modes change the output for `source` → `target`, mirroring pad.rs. */
export function fitApplicability(
  sourceSize: Size,
  target: Size,
  cropPx: number | undefined,
): FitApplicability {
  const crop = cropPx ?? 0;
  // transform.rs skips a crop that would leave nothing.
  const cropped = sourceSize.width > 2 * crop && sourceSize.height > 2 * crop;
  const source = cropped
    ? { width: sourceSize.width - 2 * crop, height: sourceSize.height - 2 * crop }
    : sourceSize;
  const larger = source.width > target.width || source.height > target.height;
  const smaller = source.width < target.width || source.height < target.height;
  return { source, target, padApplies: smaller && !larger, cropApplies: larger };
}

/** Pad fill matters only for a 1:1 mode with an axis smaller than the key. */
export function padFillApplies(
  fit: FitApplicability | undefined,
  mode: 'resize' | 'pad' | 'crop',
): boolean {
  if (mode === 'resize') return false;
  return !fit || fit.source.width < fit.target.width || fit.source.height < fit.target.height;
}

const px = (s: Size): string => `${s.width}×${s.height} px`;

function ImageFitDialog({
  fit,
  onClose,
}: Readonly<{ fit: FitApplicability; onClose: () => void }>): preact.JSX.Element {
  useDismiss(onClose);

  const handleScrimClick = (e: MouseEvent): void => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <div class="scrim" onClick={handleScrimClick}>
      <div
        class="popover floating-surface"
        id="image-fit-help"
        role="dialog"
        aria-modal="true"
        aria-labelledby="image-fit-help-title"
      >
        <button
          class="pop-close circle"
          aria-label="Close"
          type="button"
          onClick={onClose}
          // eslint-disable-next-line @eslint-react/dom-no-dangerously-set-innerhtml -- static trusted SVG icon markup
          dangerouslySetInnerHTML={{ __html: ICON.close }}
        />
        <h2 id="image-fit-help-title">Image fit</h2>
        <dl class="image-fit-sizes">
          <dt>Image from Elgato app</dt>
          <dd id="image-fit-source">{px(fit.source)}</dd>
          <dt>Device key expects</dt>
          <dd id="image-fit-target">{px(fit.target)}</dd>
        </dl>
        <p>
          <strong>resize</strong> scales the image to the key. Always works; adds slight blur.
        </p>
        <p>
          <strong>pad</strong> keeps pixels 1:1 and fills the border. Only when the image is smaller
          than the key{fit.padApplies ? '.' : ' — not the case here.'}
        </p>
        <p>
          <strong>crop</strong> keeps pixels 1:1 and trims the centre to the key; smaller axes are
          padded. Only when the image is larger than the key
          {fit.cropApplies ? '.' : ' — not the case here.'}
        </p>
      </div>
    </div>
  );
}

export function ImageFitHelp({ fit }: Readonly<{ fit: FitApplicability }>): preact.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        class="tuning-help"
        id="image-fit-help-btn"
        type="button"
        aria-label="Image fit help"
        title="Image sizes"
        onClick={() => setOpen(true)}
        // eslint-disable-next-line @eslint-react/dom-no-dangerously-set-innerhtml -- static trusted SVG icon markup
        dangerouslySetInnerHTML={{ __html: ICON.help }}
      />
      {open && <ImageFitDialog fit={fit} onClose={() => setOpen(false)} />}
    </>
  );
}
