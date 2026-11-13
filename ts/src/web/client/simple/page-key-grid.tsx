// A page's keys as toggles: pressed = left out of matching (ignored). Reuses the crop
// editor's key buttons; the snapshot form shows the live key images on them.
import { useEffect, useReducer } from 'preact/hooks';
import { getImageEntry, imageSrc, subscribeImages } from '../key-preview.js';

export function PageKeyGrid({
  label,
  keyCount,
  columns,
  ignored,
  changed,
  liveImages = false,
  onToggle,
}: Readonly<{
  label: string;
  keyCount: number;
  columns: number;
  ignored: ReadonlySet<number>;
  /** Keys whose image differs from the saved page right now. */
  changed?: ReadonlySet<number>;
  liveImages?: boolean;
  onToggle: (key: number) => void;
}>): preact.JSX.Element {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  useEffect(
    function watchLiveImages() {
      if (!liveImages) return undefined;
      return subscribeImages(() => rerender(undefined));
    },
    [liveImages],
  );
  const keys = Array.from({ length: keyCount }, (_, i) => i);
  return (
    <div
      class="crop-keys page-keys"
      role="group"
      aria-label={label}
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${Math.max(1, columns)}, minmax(0, 40px))`,
      }}
    >
      {keys.map((i) => {
        const entry = liveImages ? getImageEntry(i) : undefined;
        const isChanged = changed?.has(i) === true;
        const cls = [
          'crop-key',
          ignored.has(i) && 'page-key--ignored',
          isChanged && 'page-key--changed',
        ]
          .filter(Boolean)
          .join(' ');
        return (
          <button
            key={i}
            type="button"
            class={cls}
            aria-pressed={ignored.has(i)}
            aria-label={`Key ${i + 1}`}
            title={isChanged ? 'Differs from the snapshot now' : `Key ${i + 1}`}
            onClick={() => onToggle(i)}
          >
            {entry ? <img src={imageSrc(entry)} alt="" /> : i + 1}
          </button>
        );
      })}
    </div>
  );
}
