// Text size of one widget: A− / A / A+ steps on the font ladder, Fit, and a picker
// showing the widget at every size. The server repaints on each change, so the
// side-key tile is the live preview; the picker thumbnails are server-rendered too.
import { useEffect, useRef, useState } from 'preact/hooks';
import { useStore } from '../store.js';
import type {
  ExtraKeyCfg,
  ExtraKeyPreview,
  ExtraKeyPreviewResponse,
  ExtraKeyTextSize,
  ExtraKeyWidget,
  ExtraKeyWrap,
} from '../ui-types.js';
import { postJson } from '../ui-api.js';
import { useDismiss } from '../ui-hooks.js';
import { postExtraKey } from './extra-keys-popovers.js';

// Mirrors EXTRA_KEY_TEXT_SIZES / WRAPPABLE_WIDGETS (extra-key-config.ts).
const MIN_STEP = -2;
const MAX_STEP = 2;
const WRAPPABLE: readonly ExtraKeyWidget[] = ['text', 'command', 'plugin'];

const WRAP_OPTIONS: ReadonlyArray<{ value: ExtraKeyWrap | 'off'; label: string }> = [
  { value: 'off', label: 'Wrap: off' },
  { value: 'words', label: 'Wrap: words' },
  { value: 'chars', label: 'Wrap: characters' },
];

function sizeLabel(size: ExtraKeyTextSize): string {
  if (size === 'fit') return 'Fit';
  if (size === 0) return 'Default';
  return size > 0 ? `+${size}` : `−${-size}`;
}

function SizePicker({
  wireId,
  label,
  cfg,
  current,
  anchorRef,
  onClose,
}: Readonly<{
  wireId: number;
  label: string;
  cfg: ExtraKeyCfg;
  current: ExtraKeyTextSize;
  anchorRef: { current: HTMLDivElement | null };
  onClose: () => void;
}>): preact.JSX.Element {
  useDismiss(onClose, anchorRef);
  const [previews, setPreviews] = useState<ExtraKeyPreview[] | null | 'loading'>('loading');
  // Refetch when the config or the painted content changes while open.
  const cfgKey = JSON.stringify(cfg);
  const image = useStore((s) => s.extraKeyImages[String(wireId)]);
  useEffect(
    function loadPreviews() {
      let alive = true;
      postJson<ExtraKeyPreviewResponse>('/api/extra-key/preview', { wireId })
        .then((res) => {
          if (alive) setPreviews(res.previews);
          return undefined;
        })
        .catch(() => {
          if (alive) setPreviews(null);
        });
      return function cancel() {
        alive = false;
      };
    },
    [wireId, cfgKey, image],
  );

  const pick = (size: ExtraKeyTextSize): void => {
    postExtraKey(wireId, cfg, { ...cfg, textSize: size });
    onClose();
  };

  return (
    <div
      class="xkey-popover xkey-size-picker floating-surface"
      role="dialog"
      aria-label={`${label} text sizes`}
    >
      {previews === 'loading' && <span class="xkey-size-note">Rendering…</span>}
      {previews === null && <span class="xkey-size-note">Nothing to preview yet</span>}
      {Array.isArray(previews) && (
        <div class="xkey-size-grid">
          {previews.map((p) => (
            <button
              key={String(p.textSize)}
              type="button"
              class={p.textSize === current ? 'xkey-size-thumb is-current' : 'xkey-size-thumb'}
              aria-label={`Text size ${sizeLabel(p.textSize)}${p.clipped ? ' (clipped)' : ''}`}
              aria-pressed={p.textSize === current}
              onClick={() => pick(p.textSize)}
            >
              <img src={`data:image/bmp;base64,${p.data}`} alt="" />
              <span>
                {sizeLabel(p.textSize)}
                {p.clipped && <em class="xkey-clipped-mark"> clipped</em>}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function TextSizeControl({
  wireId,
  label,
  cfg,
}: Readonly<{ wireId: number; label: string; cfg?: ExtraKeyCfg }>): preact.JSX.Element | null {
  const [showPicker, setShowPicker] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  if (!cfg || cfg.widget === 'none') return null;
  const size = cfg.textSize ?? 0;
  const step = size === 'fit' ? 0 : size;
  const post = (next: ExtraKeyTextSize): void =>
    postExtraKey(wireId, cfg, { ...cfg, textSize: next });
  return (
    <div class="xkey-display">
      <div
        class="xkey-size xkey-config-anchor"
        ref={anchorRef}
        role="group"
        aria-label={`${label} text size`}
        title={`Text size: ${sizeLabel(size)}`}
      >
        <button
          type="button"
          class="xkey-size-btn"
          aria-label="Smaller text"
          disabled={size !== 'fit' && step <= MIN_STEP}
          onClick={() => post(Math.max(step - 1, MIN_STEP) as ExtraKeyTextSize)}
        >
          A−
        </button>
        <button
          type="button"
          class="xkey-size-btn"
          aria-label="Default text size"
          aria-pressed={size === 0}
          onClick={() => post(0)}
        >
          A
        </button>
        <button
          type="button"
          class="xkey-size-btn"
          aria-label="Larger text"
          disabled={size !== 'fit' && step >= MAX_STEP}
          onClick={() => post(Math.min(step + 1, MAX_STEP) as ExtraKeyTextSize)}
        >
          A+
        </button>
        <button
          type="button"
          class="xkey-size-btn"
          aria-label="Fit text"
          aria-pressed={size === 'fit'}
          onClick={() => post('fit')}
        >
          Fit
        </button>
        <button
          type="button"
          class="xkey-size-btn"
          aria-label={`${label} text size previews`}
          aria-expanded={showPicker}
          onClick={() => setShowPicker((v) => !v)}
        >
          ▦
        </button>
        {showPicker && (
          <SizePicker
            wireId={wireId}
            label={label}
            cfg={cfg}
            current={size}
            anchorRef={anchorRef}
            onClose={() => setShowPicker(false)}
          />
        )}
      </div>
      {WRAPPABLE.includes(cfg.widget) && <WrapSelect wireId={wireId} label={label} cfg={cfg} />}
    </div>
  );
}

function WrapSelect({
  wireId,
  label,
  cfg,
}: Readonly<{ wireId: number; label: string; cfg: ExtraKeyCfg }>): preact.JSX.Element {
  const handleWrap = (e: Event): void => {
    const value = (e.target as HTMLSelectElement).value;
    const wrap = value === 'off' ? undefined : (value as ExtraKeyWrap);
    postExtraKey(wireId, cfg, { textSize: cfg.textSize, wrap });
  };
  return (
    <select
      class="input xkey-select xkey-wrap"
      value={cfg.wrap ?? 'off'}
      aria-label={`${label} line wrapping`}
      title="Split lines too wide for the display"
      onChange={handleWrap}
    >
      {WRAP_OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** Corner badge on a widget whose text does not fit at its size. */
export function ClippedBadge({ wireId }: Readonly<{ wireId: number }>): preact.JSX.Element | null {
  const clipped = useStore((s) => s.extraKeyClipped[String(wireId)] === true);
  if (!clipped) return null;
  return (
    <span class="xkey-clipped" title="Text does not fit — try a smaller size or Fit">
      clipped
    </span>
  );
}
