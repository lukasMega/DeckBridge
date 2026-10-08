// Image fit applicability + the `?` modal explaining source vs device key size.
import { DocsLink } from '../components/DocsLink.js';
import { useState } from 'preact/hooks';
import { ICON } from '../components/Icon.js';
import { Modal } from '../components/Modal.js';
import type { DeviceImageOverride } from '../ui-types.js';

export interface Size {
  width: number;
  height: number;
}

export interface FitApplicability {
  /** Source after Crop / Crop region — what the fit step receives. */
  source: Size;
  target: Size;
  /** 'pad' changes the output: source fits inside target and is smaller on an axis. */
  padApplies: boolean;
  /** 'crop' differs from 'pad': source is larger than target on an axis. */
  cropApplies: boolean;
}

/** Source size after the pre-fit crop, mirroring transform.rs: a complete region wins
 *  and is clamped to the source; the symmetric crop is skipped if it leaves nothing. */
function croppedSource(
  sourceSize: Size,
  trim: Pick<DeviceImageOverride, 'crop' | 'cropRect'>,
): Size {
  const r = trim.cropRect;
  if (r?.x !== undefined && r.y !== undefined && r.width && r.height) {
    const x = Math.min(r.x, sourceSize.width - 1);
    const y = Math.min(r.y, sourceSize.height - 1);
    return {
      width: Math.min(r.width, sourceSize.width - x),
      height: Math.min(r.height, sourceSize.height - y),
    };
  }
  const crop = trim.crop ?? 0;
  const cropped = sourceSize.width > 2 * crop && sourceSize.height > 2 * crop;
  return cropped
    ? { width: sourceSize.width - 2 * crop, height: sourceSize.height - 2 * crop }
    : sourceSize;
}

/** Which fit modes change the output for `source` → `target`, mirroring pad.rs. */
export function fitApplicability(
  sourceSize: Size,
  target: Size,
  trim: Pick<DeviceImageOverride, 'crop' | 'cropRect'>,
): FitApplicability {
  const source = croppedSource(sourceSize, trim);
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
  return (
    <Modal id="image-fit-help" title="Image fit" titleId="image-fit-help-title" onClose={onClose}>
      <dl class="image-fit-sizes">
        <dt>Image from Elgato app</dt>
        <dd id="image-fit-source">{px(fit.source)}</dd>
        <dt>Device key expects</dt>
        <dd id="image-fit-target">{px(fit.target)}</dd>
      </dl>
      <p>
        <strong>resize</strong> scales to the key; slight blur.
      </p>
      <p>
        <strong>pad</strong> keeps pixels 1:1 and fills the border. Needs an image smaller than the
        key{fit.padApplies ? '.' : ' — not the case here.'}
      </p>
      <p>
        <strong>crop</strong> keeps pixels 1:1 and trims the centre. Needs an image larger than the
        key{fit.cropApplies ? '.' : ' — not the case here.'}
      </p>
      <p>
        <DocsLink topic="image-fit" />
      </p>
    </Modal>
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
