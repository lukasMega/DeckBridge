// Configure display widgets on selected dock's extra keys (293S 6th column, AKP05E
// right column as a Stream Deck +) and touch strip. The server renders content and
// refreshes it, so this panel only picks the widget + its parameter — plus, for keys
// with a switch, what a press does (refresh the widget / run a shell command / both).
import { useEffect, useState } from 'preact/hooks';
import { useStore } from '../store.js';
import type { DockUi, PluginsInfo, WidgetDisplayInfo } from '../ui-types.js';
import {
  EncodersSection,
  RepaintIntervalField,
  TouchStripModeSelect,
  touchStripModeDescription,
} from './touch-strip-panel.js';
import { ConfigSection } from './config-section.js';
import { SideKeysHelp } from './side-keys-help.js';
import { SideKeyCard } from './side-key-card.js';
import { StripZones } from './strip-zones.js';

const POSITION_LABELS: Readonly<Record<number, readonly string[]>> = {
  2: ['Top', 'Bottom'],
  3: ['Top', 'Middle', 'Bottom'],
};
const PLUGIN_STATUS_POLL_MS = 2000;

interface WidgetSection {
  wireIds: readonly number[];
  labels: ReadonlyMap<number, string>;
  title: string;
  /** Absent on the touch strip — its subtitle describes the selected mode. */
  subtitle?: string;
  touchStrip: boolean;
  /** Touch-strip zones, sorted by wireId. */
  displays: readonly WidgetDisplayInfo[];
  encoderCount: number;
  pressable: ReadonlySet<number>;
}

/** Side keys first (they sit above the AKP05E strip), then the touch strip. */
function widgetSections(dock: DockUi | undefined): WidgetSection[] {
  const sections: WidgetSection[] = [];
  const sideKeys = dock?.extraKeys ?? [];
  if (sideKeys.length > 0) {
    const pressable = new Set(dock?.pressableExtraKeys ?? []);
    const positions = POSITION_LABELS[sideKeys.length];
    sections.push({
      wireIds: sideKeys,
      labels: new Map(sideKeys.map((id, i) => [id, positions?.[i] ?? `Key ${id}`])),
      title: 'Side keys',
      subtitle:
        pressable.size > 0
          ? 'Right column outside the Elgato grid — show a value; a press refreshes it or runs a command'
          : 'Display-only right column — show a value on each key',
      touchStrip: false,
      displays: [],
      encoderCount: 0,
      pressable,
    });
  }
  const displays = dock?.widgetDisplays;
  if (displays) {
    const sorted = displays.toSorted((a, b) => a.wireId - b.wireId);
    sections.push({
      wireIds: sorted.map((display) => display.wireId),
      labels: new Map(displays.map((display) => [display.wireId, display.label])),
      title: 'Touch strip',
      touchStrip: true,
      displays: sorted,
      encoderCount: dock.encoderCount ?? 0,
      pressable: new Set(),
    });
  }
  return sections;
}

// Renders nothing unless selected dock has extra keys in real mode.
export function ExtraKeysPanel(): preact.JSX.Element | null {
  const status = useStore((s) => s.status);
  const configs = useStore((s) => s.extraKeys);
  const stripMode = useStore((s) => s.touchStripMode);

  // Fetch plugin file list + live per-key status; re-poll while any key runs a plugin.
  const [plugins, setPlugins] = useState<PluginsInfo>({ dir: '', files: [], status: {} });
  const hasPlugin = Object.values(configs).some((c) => c.widget === 'plugin');
  useEffect(() => {
    let alive = true;
    const load = (): void => {
      fetch('/api/plugins')
        .then((r) => r.json())
        .then((info: PluginsInfo) => {
          if (alive) setPlugins(info);
          return undefined;
        })
        .catch(() => undefined);
    };
    load();
    const timer = hasPlugin ? setInterval(load, PLUGIN_STATUS_POLL_MS) : undefined;
    return () => {
      alive = false;
      if (timer !== undefined) clearInterval(timer);
    };
  }, [hasPlugin]);

  if (status.driverMode === 'mock') return null;
  const selected = status.selectedDock ?? 0;
  const dock = status.docks.find((d) => d.index === selected) ?? status.docks[0];
  const sections = widgetSections(dock);
  if (sections.length === 0) return null;

  return (
    <>
      {sections.map((section) => {
        // Knob commands are only DeckBridge's in an override mode.
        const knobOverride = stripMode !== 'elgato';
        return (
          <ConfigSection
            key={section.title}
            title={section.title}
            compact={!section.touchStrip}
            subtitle={section.touchStrip ? touchStripModeDescription(stripMode) : undefined}
            aside={
              section.touchStrip ? (
                <TouchStripModeSelect mode={stripMode} />
              ) : (
                dock && <SideKeysHelp dock={dock} description={section.subtitle} />
              )
            }
          >
            {section.touchStrip && stripMode === 'deckbridge-repaint' && <RepaintIntervalField />}
            {section.touchStrip && (
              <StripZones
                key={dock?.index ?? 0}
                displays={section.displays}
                mode={stripMode}
                configs={configs}
                plugins={plugins}
              />
            )}
            {!section.touchStrip &&
              section.wireIds.map((wireId) => (
                <SideKeyCard
                  key={wireId}
                  wireId={wireId}
                  label={section.labels.get(wireId) ?? `Key ${wireId}`}
                  cfg={configs[String(wireId)]}
                  plugins={plugins}
                  pluginStatus={plugins.status[String(wireId)]}
                  pressable={section.pressable.has(wireId)}
                />
              ))}
            {section.encoderCount > 0 && (
              <EncodersSection count={section.encoderCount} overrideEnabled={knobOverride} />
            )}
          </ConfigSection>
        );
      })}
    </>
  );
}
