// Crop editor: pick the part of a real Elgato-app key frame that lands on the device key.
// The preview is upright: rotate/flip only compensate how the panel is mounted.
import { useEffect, useRef, useState } from 'preact/hooks';
import { NumberField } from '../components/Fields.js';
import { getImageEntry, imageSrc } from '../key-preview.js';
import { useStore } from '../store.js';
import { postJson } from '../ui-api.js';
import { useDismiss } from '../ui-hooks.js';
import { ICON } from '../ui-icons.js';
import type { DeviceCropRect, DeviceImageOverride, DeviceOverridesView } from '../ui-types.js';
import {
  centredRect,
  clampRect,
  initialRect,
  moveRect,
  previewDrawOp,
  resizeFromCorner,
  wholeImage,
  withAspect,
} from './crop-geometry.js';
import type { Corner } from './crop-geometry.js';
import type { Size } from './image-fit-help.js';

const CORNERS: readonly Corner[] = ['nw', 'ne', 'sw', 'se'];
const RECT_FIELDS: ReadonlyArray<{ key: keyof DeviceCropRect; label: string }> = [
  { key: 'x', label: 'X' },
  { key: 'y', label: 'Y' },
  { key: 'width', label: 'Width' },
  { key: 'height', label: 'Height' },
];
const MAX_SOURCE_PX = 480;
const PREVIEW_SCALE = 2;

interface Drag {
  pointerX: number;
  pointerY: number;
  start: DeviceCropRect;
  corner?: Corner;
}

interface EditorProps {
  view: DeviceOverridesView;
  image: DeviceImageOverride;
  keySize: Size;
  onSaved: () => void;
}

/** The draft form image plus the rect. A region replaces the symmetric crop, and
 *  passthrough never transforms — both would be rejected by the server otherwise. */
function overridesWith(
  view: DeviceOverridesView,
  image: DeviceImageOverride,
  cropRect: DeviceCropRect,
): Record<string, unknown> {
  const next: DeviceImageOverride = { ...image, cropRect };
  if ((image.crop ?? 0) > 0) next.crop = 0;
  if ((image.transform ?? view.effective.image.transform) === 'passthrough') {
    next.transform = 'sidecar';
  }
  return { ...view.overrides, image: next };
}

function keysWithFrames(keyCount: number): number[] {
  return Array.from({ length: keyCount }, (_, i) => i).filter((i) => getImageEntry(i));
}

function useFrame(key: number | undefined): HTMLImageElement | null {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  useEffect(
    function loadFrame() {
      const entry = key === undefined ? undefined : getImageEntry(key);
      if (key === undefined || !entry) return undefined;
      const el = new Image();
      const onLoad = (): void => setImg(el);
      el.addEventListener('load', onLoad);
      el.src = imageSrc(key, entry);
      return function dropFrame() {
        el.removeEventListener('load', onLoad);
      };
    },
    [key],
  );
  return img;
}

function drawSource(canvas: HTMLCanvasElement | null, img: HTMLImageElement): void {
  const ctx = canvas?.getContext('2d');
  if (!canvas || !ctx) return;
  // Pixelated zoom, so single source pixels stay visible.
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
}

function drawPreview(
  canvas: HTMLCanvasElement | null,
  img: HTMLImageElement,
  rect: DeviceCropRect,
  key: Size,
  mode: 'resize' | 'pad' | 'crop',
): void {
  const ctx = canvas?.getContext('2d');
  if (!canvas || !ctx) return;
  const op = previewDrawOp(rect, key, mode);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, key.width, key.height);
  ctx.drawImage(img, op.sx, op.sy, op.sw, op.sh, op.dx, op.dy, op.dw, op.dh);
}

function CropDialog({
  view,
  image,
  keySize,
  onSaved,
  onClose,
}: Readonly<EditorProps & { onClose: () => void }>): preact.JSX.Element {
  const keyCount = useStore((s) => s.status.keyCount ?? 0);
  const [keys] = useState(() => keysWithFrames(keyCount));
  const [key, setKey] = useState<number | undefined>(keys[0]);
  const img = useFrame(key);
  const src: Size = img
    ? { width: img.naturalWidth, height: img.naturalHeight }
    : (view.sourceSize ?? keySize);
  const [rect, setRect] = useState(() => initialRect(image.cropRect, keySize, src));
  const [aspectLock, setAspectLock] = useState(true);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dragRef = useRef<Drag | null>(null);
  const sourceCanvasRef = useRef<HTMLCanvasElement>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const scale = Math.max(1, Math.min(4, Math.floor(MAX_SOURCE_PX / src.width)));
  const aspect = aspectLock ? keySize.width / keySize.height : undefined;
  const mode = image.resizeMode ?? 'resize';

  useEffect(
    function paintCanvases() {
      if (!img) return;
      drawSource(sourceCanvasRef.current, img);
      drawPreview(previewCanvasRef.current, img, rect, keySize, mode);
    },
    [img, rect, keySize, mode, scale],
  );

  const post = async (overrides: unknown): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      await postJson('/api/device-overrides', { modelId: view.modelId, overrides }, 'Save failed');
    } finally {
      setBusy(false);
    }
  };
  const run = (fn: () => Promise<void>): void => {
    fn().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  const tryOnDevice = (): void =>
    run(async () => {
      await post(overridesWith(view, image, rect));
      setTried(true);
    });
  const save = (): void =>
    run(async () => {
      await post(overridesWith(view, image, rect));
      onSaved();
      onClose();
    });
  const cancel = (): void =>
    run(async () => {
      if (tried) await post(view.overrides);
      onClose();
    });
  useDismiss(cancel);

  const startDrag = (e: PointerEvent, corner?: Corner): void => {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = {
      pointerX: e.clientX,
      pointerY: e.clientY,
      start: rect,
      ...(corner ? { corner } : {}),
    };
  };
  const onPointerMove = (e: PointerEvent): void => {
    const d = dragRef.current;
    if (!d) return;
    const dx = Math.round((e.clientX - d.pointerX) / scale);
    const dy = Math.round((e.clientY - d.pointerY) / scale);
    setRect(
      d.corner
        ? resizeFromCorner(d.start, d.corner, dx, dy, src, aspect)
        : moveRect(d.start, dx, dy, src),
    );
  };
  const endDrag = (): void => {
    dragRef.current = null;
  };
  const onKeyDown = (e: KeyboardEvent): void => {
    const step = e.shiftKey ? 10 : 1;
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const move = delta[e.key];
    if (!move) return;
    e.preventDefault();
    setRect(moveRect(rect, move[0], move[1], src));
  };
  const setField = (field: keyof DeviceCropRect, v: number | undefined): void => {
    if (v === undefined) return;
    const next = { ...rect, [field]: v };
    setRect(
      aspect && (field === 'width' || field === 'height')
        ? withAspect(next, field, src, aspect)
        : clampRect(next, src),
    );
  };

  const handleScrimClick = (e: MouseEvent): void => {
    if (e.target === e.currentTarget) cancel();
  };

  return (
    <div class="scrim" onClick={handleScrimClick}>
      <div
        class="popover floating-surface crop-editor"
        id="image-crop-editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby="image-crop-title"
      >
        <button
          class="pop-close circle"
          aria-label="Close"
          type="button"
          onClick={cancel}
          // eslint-disable-next-line @eslint-react/dom-no-dangerously-set-innerhtml -- static trusted SVG icon markup
          dangerouslySetInnerHTML={{ __html: ICON.close }}
        />
        <h2 id="image-crop-title">Crop key image</h2>
        {keys.length === 0 ? (
          <p id="crop-no-frames">
            No key image yet. Open a profile in the Stream Deck app, then try again.
          </p>
        ) : (
          <>
            <div class="crop-keys" role="group" aria-label="Key image to crop on">
              {keys.map((i) => (
                <button
                  key={i}
                  type="button"
                  class="crop-key"
                  aria-pressed={i === key}
                  aria-label={`Key ${i + 1}`}
                  onClick={() => setKey(i)}
                >
                  <img src={imageSrc(i, getImageEntry(i)!)} alt="" />
                </button>
              ))}
            </div>
            <div class="crop-stage">
              <div class="crop-source" onPointerMove={onPointerMove} onPointerUp={endDrag}>
                <canvas
                  ref={sourceCanvasRef}
                  width={src.width * scale}
                  height={src.height * scale}
                />
                <div
                  class="crop-rect"
                  id="crop-rect"
                  tabIndex={0}
                  role="application"
                  aria-label="Crop region: drag to move, arrow keys move 1 px, Shift+arrow 10 px"
                  style={{
                    left: `${rect.x * scale}px`,
                    top: `${rect.y * scale}px`,
                    width: `${rect.width * scale}px`,
                    height: `${rect.height * scale}px`,
                  }}
                  onPointerDown={(e) => startDrag(e)}
                  onKeyDown={onKeyDown}
                >
                  {CORNERS.map((c) => (
                    <span
                      key={c}
                      class={`crop-handle crop-handle-${c}`}
                      onPointerDown={(e) => startDrag(e, c)}
                    />
                  ))}
                </div>
              </div>
              <figure class="crop-preview">
                <canvas
                  ref={previewCanvasRef}
                  width={keySize.width}
                  height={keySize.height}
                  style={{
                    width: `${keySize.width * PREVIEW_SCALE}px`,
                    height: `${keySize.height * PREVIEW_SCALE}px`,
                  }}
                />
                <figcaption>
                  Key preview, {keySize.width}×{keySize.height} px — approximate. Use Try on device
                  for the exact result.
                </figcaption>
              </figure>
            </div>
            <div class="tuning-dimensions tuning-crop-rect crop-fields">
              {RECT_FIELDS.map((f) => (
                <NumberField
                  key={f.key}
                  label={f.label}
                  value={rect[f.key]}
                  min={0}
                  onChange={(v) => setField(f.key, v)}
                />
              ))}
            </div>
            <div class="crop-tools">
              <label class="settings-checkbox">
                <input
                  type="checkbox"
                  checked={aspectLock}
                  onChange={(e) => setAspectLock((e.target as HTMLInputElement).checked)}
                />
                Keep key shape
              </label>
              <button
                type="button"
                class="ghostbtn"
                onClick={() => setRect(centredRect(rect, src))}
              >
                Centre
              </button>
              <button
                type="button"
                class="ghostbtn"
                onClick={() => setRect(centredRect(keySize, src))}
              >
                Key size 1:1
              </button>
              <button
                type="button"
                class="ghostbtn"
                onClick={() => {
                  setAspectLock(false);
                  setRect(wholeImage(src));
                }}
              >
                Whole image
              </button>
            </div>
            {(image.crop ?? 0) > 0 && <p>Replaces Crop ({image.crop} px per side).</p>}
            {(image.transform ?? view.effective.image.transform) === 'passthrough' && (
              <p>Switches Transform to sidecar: passthrough sends the image unchanged.</p>
            )}
          </>
        )}
        {error && <p class="settings-error">{error}</p>}
        <div class="settings-actions">
          <button
            id="crop-try"
            type="button"
            class="ghostbtn"
            disabled={busy || keys.length === 0}
            onClick={tryOnDevice}
          >
            Try on device
          </button>
          <button
            id="crop-save"
            type="button"
            class="ghostbtn"
            disabled={busy || keys.length === 0}
            onClick={save}
          >
            Save
          </button>
          <button id="crop-cancel" type="button" class="ghostbtn" disabled={busy} onClick={cancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/** "Crop…" button + the editor dialog it opens. */
export function ImageCropEditor(props: Readonly<EditorProps>): preact.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button id="crop-open" type="button" class="ghostbtn crop-open" onClick={() => setOpen(true)}>
        Crop…
      </button>
      {open && <CropDialog {...props} onClose={() => setOpen(false)} />}
    </>
  );
}
