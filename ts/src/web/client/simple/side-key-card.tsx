// One side key: live preview tile (the widget image the server painted on the
// device) beside its settings — widget, value, press action + command.
import { useStore } from '../store.js';
import type { ExtraKeyCfg, PluginStatus } from '../ui-types.js';
import {
  hasWidgetValue,
  PressControls,
  WidgetSelect,
  WidgetValue,
  type PluginFiles,
} from './extra-key-fields.js';
import { ClippedBadge, TextSizeControl } from './text-size-control.js';

function SideKeyTile({
  wireId,
  label,
}: Readonly<{ wireId: number; label: string }>): preact.JSX.Element {
  const image = useStore((s) => s.extraKeyImages[String(wireId)]);
  return (
    <div class="xkey-tile">
      {image !== undefined ? (
        <img src={`data:image/bmp;base64,${image}`} alt={`${label} side key preview`} />
      ) : (
        <span class="xkey-tile-empty">{label}</span>
      )}
      <ClippedBadge wireId={wireId} />
    </div>
  );
}

export function SideKeyCard({
  wireId,
  label,
  cfg,
  plugins,
  pluginStatus,
  pressable,
}: Readonly<{
  wireId: number;
  label: string;
  cfg?: ExtraKeyCfg;
  plugins: PluginFiles;
  pluginStatus?: PluginStatus;
  pressable: boolean;
}>): preact.JSX.Element {
  return (
    <div class="xkey-card" role="group" aria-label={`${label} side key`}>
      <SideKeyTile wireId={wireId} label={label} />
      <div class="xkey-row xkey-card-fields">
        <span class="xkey-pos">{label}</span>
        <div class="xkey-card-span">
          <WidgetSelect wireId={wireId} label={label} cfg={cfg} />
        </div>
        {hasWidgetValue(cfg?.widget ?? 'none') && (
          <>
            <span class="xkey-press-label">Value</span>
            <WidgetValue
              wireId={wireId}
              label={label}
              cfg={cfg}
              plugins={plugins}
              pluginStatus={pluginStatus}
            />
          </>
        )}
        {(cfg?.widget ?? 'none') !== 'none' && (
          <>
            <span class="xkey-press-label">Size</span>
            <TextSizeControl wireId={wireId} label={label} cfg={cfg} />
          </>
        )}
        {pressable && (
          <>
            <span class="xkey-press-label">On press</span>
            <PressControls wireId={wireId} label={label} cfg={cfg} />
          </>
        )}
      </div>
    </div>
  );
}
