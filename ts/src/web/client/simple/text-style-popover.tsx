// "Aa" Text style popover of one widget: font, colours, alignment, padding, line gap,
// bold/outline, ellipsis. Each change posts at once; the server repaints the key.
import { useRef, useState } from 'preact/hooks';
import type { ExtraKeyCfg, ExtraKeyTextStyle } from '../ui-types.js';
import { useDismiss } from '../ui-hooks.js';
import { CheckField } from '../components/Fields.js';
import { postExtraKey } from './extra-keys-popovers.js';

// Mirror DEFAULT_TEXT_COLOR / DEFAULT_TEXT_BACKGROUND / TEXT_PADDING_MAX /
// TEXT_LINE_GAP_MAX (extra-key-config.ts).
const DEFAULT_COLOR = '#e8e8ec';
const DEFAULT_BACKGROUND = '#101014';
const PADDING_MAX = 16;
const LINE_GAP_MAX = 8;
const DEFAULT_OUTLINE = '#000000';
const SWATCHES = [
  DEFAULT_COLOR,
  DEFAULT_BACKGROUND,
  '#ffd60a',
  '#30d158',
  '#0a84ff',
  '#ff453a',
  '#bf5af2',
  '#000000',
];

type Option<T> = readonly [value: T, label: string];

function Segmented<T extends string>({
  label,
  value,
  options,
  onPick,
}: Readonly<{
  label: string;
  value: T;
  options: ReadonlyArray<Option<T>>;
  onPick: (v: T) => void;
}>): preact.JSX.Element {
  return (
    <div class="xkey-style-row">
      <span>{label}</span>
      <div class="xkey-size" role="group" aria-label={label}>
        {options.map(([v, text]) => (
          <button
            key={v}
            type="button"
            class="xkey-size-btn"
            aria-pressed={v === value}
            onClick={() => onPick(v)}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

function ColorRow({
  label,
  value,
  onPick,
}: Readonly<{ label: string; value: string; onPick: (hex: string) => void }>): preact.JSX.Element {
  return (
    <div class="xkey-style-row xkey-style-colors" role="group" aria-label={label}>
      <span>{label}</span>
      <div class="xkey-swatches">
        {SWATCHES.map((hex) => (
          <button
            key={hex}
            type="button"
            class="xkey-swatch"
            style={{ background: hex }}
            aria-label={`${label} ${hex}`}
            aria-pressed={hex === value}
            onClick={() => onPick(hex)}
          />
        ))}
        <input
          class="xkey-swatch xkey-swatch-custom"
          type="color"
          value={value}
          aria-label={`${label} custom colour`}
          onChange={(e) => onPick((e.target as HTMLInputElement).value.toLowerCase())}
        />
      </div>
    </div>
  );
}

/** Integer px input; out-of-range values are ignored, not clamped (see SecondsField). */
function PxField({
  label,
  max,
  value,
  onCommit,
}: Readonly<{
  label: string;
  max: number;
  value: number;
  onCommit: (px: number) => void;
}>): preact.JSX.Element {
  const handleChange = (e: Event): void => {
    const n = Number((e.target as HTMLInputElement).value);
    if (Number.isInteger(n) && n >= 0 && n <= max) onCommit(n);
  };
  return (
    <label class="xkey-popover-field">
      <span>{label}</span>
      <input class="input" type="number" min={0} max={max} value={value} onChange={handleChange} />
    </label>
  );
}

function TextStylePopover({
  wireId,
  label,
  cfg,
  anchorRef,
  onClose,
}: Readonly<{
  wireId: number;
  label: string;
  cfg: ExtraKeyCfg;
  anchorRef: { current: HTMLDivElement | null };
  onClose: () => void;
}>): preact.JSX.Element {
  useDismiss(onClose, anchorRef);
  const style = cfg.style ?? {};
  const update = (patch: ExtraKeyTextStyle): void =>
    postExtraKey(wireId, cfg, { style: { ...style, ...patch } });
  return (
    <div
      class="xkey-popover xkey-style-popover floating-surface"
      role="dialog"
      aria-label={`${label} text style`}
    >
      <Segmented
        label="Font"
        value={style.font ?? 'regular'}
        options={[
          ['regular', 'Regular'],
          ['narrow', 'Narrow'],
        ]}
        onPick={(font) => update({ font })}
      />
      <ColorRow
        label="Text colour"
        value={style.color ?? DEFAULT_COLOR}
        onPick={(color) => update({ color })}
      />
      <ColorRow
        label="Background"
        value={style.background ?? DEFAULT_BACKGROUND}
        onPick={(background) => update({ background })}
      />
      <Segmented
        label="Align"
        value={style.align ?? 'center'}
        options={[
          ['left', 'Left'],
          ['center', 'Center'],
          ['right', 'Right'],
        ]}
        onPick={(align) => update({ align })}
      />
      <Segmented
        label="Vertical"
        value={style.valign ?? 'middle'}
        options={[
          ['top', 'Top'],
          ['middle', 'Middle'],
          ['bottom', 'Bottom'],
        ]}
        onPick={(valign) => update({ valign })}
      />
      <PxField
        label="Padding (px)"
        max={PADDING_MAX}
        value={style.padding ?? 0}
        onCommit={(padding) => update({ padding })}
      />
      <PxField
        label="Line gap (px)"
        max={LINE_GAP_MAX}
        value={style.lineGap ?? 0}
        onCommit={(lineGap) => update({ lineGap })}
      />
      <CheckField
        label="Bold"
        checked={style.bold === true}
        onChange={(bold) => update({ bold })}
      />
      <div class="xkey-style-outline">
        <CheckField
          label="Outline"
          checked={style.outline !== undefined}
          onChange={(on) => update({ outline: on ? DEFAULT_OUTLINE : undefined })}
        />
        {style.outline !== undefined && (
          <input
            class="xkey-swatch xkey-swatch-custom"
            type="color"
            value={style.outline}
            aria-label="Outline colour"
            onChange={(e) =>
              update({ outline: (e.target as HTMLInputElement).value.toLowerCase() })
            }
          />
        )}
      </div>
      <CheckField
        label="Ellipsis on cut text"
        checked={style.ellipsis !== false}
        onChange={(ellipsis) => update({ ellipsis })}
      />
      <button
        class="ghostbtn xkey-popover-run"
        type="button"
        onClick={() => postExtraKey(wireId, cfg, { style: {} })}
      >
        Reset style
      </button>
    </div>
  );
}

/** The "Aa" button beside the size control; the popover is per key. */
export function TextStyleButton({
  wireId,
  label,
  cfg,
}: Readonly<{ wireId: number; label: string; cfg: ExtraKeyCfg }>): preact.JSX.Element {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  return (
    <div class="xkey-size xkey-config-anchor" ref={anchorRef}>
      <button
        type="button"
        class="xkey-size-btn"
        aria-label={`${label} text style`}
        aria-expanded={open}
        title="Text style: font, colours, alignment…"
        onClick={() => setOpen((v) => !v)}
      >
        Aa
      </button>
      {open && (
        <TextStylePopover
          wireId={wireId}
          label={label}
          cfg={cfg}
          anchorRef={anchorRef}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}
