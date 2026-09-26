// Touch-strip zones: one row of live previews (the device's own strip pixels, see
// strip-zone-preview.ts) acting as tabs, and one settings panel for the selected zone.
import { useEffect, useRef, useState } from 'preact/hooks';
import type {
  ExtraKeyCfg,
  ExtraKeyWidget,
  PluginsInfo,
  TouchStripMode,
  WidgetDisplayInfo,
} from '../ui-types.js';
import { attachZoneCanvas } from '../strip-zone-preview.js';
import { hasWidgetValue, WidgetSelect, WidgetValue } from './extra-key-fields.js';
import { ClippedBadge, TextSizeControl } from './text-size-control.js';

// Under an override mode 'none' decides what an unassigned strip zone shows.
const NONE_LABEL: Partial<Record<TouchStripMode, string>> = {
  'deckbridge-ignore': 'Blank',
  'deckbridge-repaint': 'App controls',
};

const ZONE_TYPE_LABEL: Record<Exclude<ExtraKeyWidget, 'none'>, string> = {
  clock: 'Clock',
  date: 'Date',
  text: 'Text',
  weather: 'Weather',
  command: 'Command',
  plugin: 'Plugin',
};

const PANEL_ID = 'strip-zone-panel';
const tabId = (wireId: number): string => `strip-zone-tab-${wireId}`;

function zoneIndicator(mode: TouchStripMode, cfg: ExtraKeyCfg | undefined): string {
  if (mode === 'elgato') return 'Elgato app';
  const widget = cfg?.widget ?? 'none';
  return widget === 'none' ? (NONE_LABEL[mode] ?? '') : ZONE_TYPE_LABEL[widget];
}

function ZoneCanvas({
  zone,
  ariaLabel,
}: Readonly<{ zone: WidgetDisplayInfo; ariaLabel?: string }>): preact.JSX.Element {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const { wireId, label, width, height, stripX, rotate, flipH, flipV } = zone;
  // Re-attach on a geometry change: the mirror slices and un-rotates by it.
  useEffect(
    function attachZone() {
      const canvas = ref.current;
      if (!canvas) return undefined;
      return attachZoneCanvas(canvas, {
        wireId,
        label,
        width,
        height,
        ...(stripX !== undefined ? { stripX } : {}),
        rotate,
        flipH,
        flipV,
      });
    },
    [wireId, label, width, height, stripX, rotate, flipH, flipV],
  );
  return (
    <canvas
      ref={ref}
      class="strip-zone-canvas"
      width={width}
      height={height}
      style={`aspect-ratio:${width}/${height}`}
      {...(ariaLabel ? { role: 'img', 'aria-label': ariaLabel } : { 'aria-hidden': 'true' })}
    />
  );
}

function ZonePanel({
  zone,
  mode,
  cfg,
  plugins,
}: Readonly<{
  zone: WidgetDisplayInfo;
  mode: TouchStripMode;
  cfg?: ExtraKeyCfg;
  plugins: PluginsInfo;
}>): preact.JSX.Element {
  const { wireId, label } = zone;
  const widget = cfg?.widget ?? 'none';
  return (
    <div role="tabpanel" id={PANEL_ID} aria-labelledby={tabId(wireId)} class="strip-zone-panel">
      <div class="strip-zone-title">
        {label} zone
        <ClippedBadge wireId={wireId} />
      </div>
      <div class="xkey-row xkey-card-fields">
        <span class="xkey-press-label">Shows</span>
        <div class="xkey-card-span">
          <WidgetSelect wireId={wireId} label={label} cfg={cfg} noneLabel={NONE_LABEL[mode]} />
        </div>
        {hasWidgetValue(widget) && (
          <>
            <span class="xkey-press-label">Value</span>
            <WidgetValue
              wireId={wireId}
              label={label}
              cfg={cfg}
              plugins={plugins}
              pluginStatus={plugins.status[String(wireId)]}
            />
          </>
        )}
        {widget !== 'none' && (
          <>
            <span class="xkey-press-label">Size</span>
            <TextSizeControl wireId={wireId} label={label} cfg={cfg} />
          </>
        )}
      </div>
    </div>
  );
}

const NAV_KEYS: Readonly<Record<string, (index: number, count: number) => number>> = {
  ArrowRight: (i, n) => (i + 1) % n,
  ArrowDown: (i, n) => (i + 1) % n,
  ArrowLeft: (i, n) => (i - 1 + n) % n,
  ArrowUp: (i, n) => (i - 1 + n) % n,
  Home: () => 0,
  End: (_i, n) => n - 1,
};

/** `displays` sorted by wireId. Remount per dock (key) so selection resets on a switch. */
export function StripZones({
  displays,
  mode,
  configs,
  plugins,
}: Readonly<{
  displays: readonly WidgetDisplayInfo[];
  mode: TouchStripMode;
  configs: Readonly<Record<string, ExtraKeyCfg>>;
  plugins: PluginsInfo;
}>): preact.JSX.Element | null {
  const [picked, setPicked] = useState<number | undefined>(undefined);
  if (displays.length === 0) return null;
  const style = `--zones:${displays.length}`;
  const cfgOf = (wireId: number): ExtraKeyCfg | undefined => configs[String(wireId)];

  if (mode === 'elgato') {
    return (
      <div class="strip-zones" style={style} role="list" aria-label="Touch strip zones">
        {displays.map((zone) => (
          <div key={zone.wireId} class="strip-zone" role="listitem">
            <ZoneCanvas zone={zone} ariaLabel={`${zone.label} zone preview`} />
            <span class="strip-zone-type">{zoneIndicator(mode, undefined)}</span>
          </div>
        ))}
      </div>
    );
  }

  // A zone that vanished (model change) falls back to the first one.
  const selected = displays.find((zone) => zone.wireId === picked) ?? displays[0]!;
  const handleKeyDown = (e: KeyboardEvent): void => {
    const next = NAV_KEYS[e.key];
    if (!next) return;
    e.preventDefault();
    const zone = displays[next(displays.indexOf(selected), displays.length)]!;
    setPicked(zone.wireId);
    (e.currentTarget as HTMLElement).querySelector<HTMLElement>(`#${tabId(zone.wireId)}`)?.focus();
  };

  return (
    <>
      <div
        class="strip-zones"
        style={style}
        role="tablist"
        aria-label="Touch strip zones"
        onKeyDown={handleKeyDown}
      >
        {displays.map((zone) => {
          const isSelected = zone === selected;
          const indicator = zoneIndicator(mode, cfgOf(zone.wireId));
          return (
            <button
              key={zone.wireId}
              type="button"
              class="strip-zone strip-zone-tab"
              role="tab"
              id={tabId(zone.wireId)}
              aria-selected={isSelected}
              aria-controls={PANEL_ID}
              tabIndex={isSelected ? 0 : -1}
              aria-label={`${zone.label} zone: ${indicator}`}
              onClick={() => setPicked(zone.wireId)}
            >
              <ZoneCanvas zone={zone} />
              <span class="strip-zone-type">{indicator}</span>
            </button>
          );
        })}
      </div>
      <ZonePanel
        key={selected.wireId}
        zone={selected}
        mode={mode}
        cfg={cfgOf(selected.wireId)}
        plugins={plugins}
      />
    </>
  );
}
