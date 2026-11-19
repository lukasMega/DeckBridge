// Main-page "Info window" section for the Ulanzi D200's wide slot: a live preview tile beside
// what the window shows, the clock format and where a press goes. Acts on the selected dock
// and renders only for a model that lists small-window modes; the outer component re-keys the
// body per dock so a dock switch re-reads that dock's settings. Content "Widget" turns the
// card into the side-key widget editor for the window's wire id (device-level config, never
// a page layout).
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { useStore } from '../lib/store.js';
import { postJson, useFetched } from '../lib/ui-api.js';
import { Feedback, useAsyncAction } from '../lib/ui-async.js';
import type { PluginsInfo } from '../ui-types.js';
import { NumberInput } from '../components/Fields.js';
import { ConfigSection } from './config-section.js';
import { SideKeyCard } from './side-key-card.js';
import { WideKeyPreview } from './wide-key-preview.js';
import type {
  WideKeyClockMode,
  WideKeyConfig,
  WideKeyContent,
  WideKeyElgatoImages,
  WideKeyElgatoSource,
  WideKeyHourFormat,
  WideKeyPress,
  WideKeyView,
} from '../../contract-wide-key.js';

const TITLE = 'Info window';
const CONTENT_LABELS: Readonly<Record<WideKeyContent, string>> = {
  clock: 'Clock',
  dial: 'Dial',
  stats: 'Stats',
  widget: 'Widget',
  elgato: 'Elgato app',
};
const SOURCES: readonly WideKeyElgatoSource[] = ['both', 'elgato-13', 'elgato-14'];
const SOURCE_LABELS: Readonly<Record<WideKeyElgatoSource, string>> = {
  both: 'Keys 14 + 15',
  'elgato-13': 'Key 14',
  'elgato-14': 'Key 15',
};
const ELGATO_IMAGES: readonly WideKeyElgatoImages[] = ['ignore', 'override'];
const ELGATO_IMAGES_LABELS: Readonly<Record<WideKeyElgatoImages, string>> = {
  ignore: 'Ignore',
  override: 'Show, then widget',
};
// Bounds mirror TOUCH_STRIP_REPAINT_MIN_MS / _MAX_MS (types.ts), in seconds.
const OVERRIDE_MIN_S = 1;
const OVERRIDE_MAX_S = 3600;
const HOUR_FORMATS: readonly WideKeyHourFormat[] = ['24H', '12H'];
const HOUR_LABELS: Readonly<Record<WideKeyHourFormat, string>> = {
  '24H': '24-hour',
  '12H': '12-hour',
};

const BUILT_IN = '';
const PLUGIN_STATUS_POLL_MS = 2000;

// One labelled select on the card's .xkey-row grid, like the side-key rows.
function Row<T extends string | number>({
  id,
  label,
  value,
  options,
  optionLabel,
  onChange,
}: Readonly<{
  id: string;
  label: string;
  value: T;
  options: readonly T[];
  optionLabel: (v: T) => string;
  onChange: (v: T) => void;
}>): preact.JSX.Element {
  return (
    <>
      <label class="xkey-press-label" for={id}>
        {label}
      </label>
      <div class="xkey-card-span">
        <select
          id={id}
          class="input xkey-select"
          value={String(value)}
          onChange={(e) => {
            const raw = (e.target as HTMLSelectElement).value;
            const match = options.find((o) => String(o) === raw);
            if (match !== undefined) onChange(match);
          }}
        >
          {options.map((o) => (
            <option key={String(o)} value={String(o)}>
              {optionLabel(o)}
            </option>
          ))}
        </select>
      </div>
    </>
  );
}

// Where Stats reads its figures: the built-in sampler, or a plugin file from the plugins dir
// (the same list the side-key plugin picker shows) that replies with JSON.
function StatsSource({
  file,
  onChange,
}: Readonly<{ file: string; onChange: (file: string) => void }>): preact.JSX.Element {
  const plugins = useFetched<PluginsInfo>('/api/plugins');
  const files = plugins.data?.files ?? [];
  // A stored file that left the plugins dir stays listed, flagged, like the side-key picker.
  const options = file === BUILT_IN || files.includes(file) ? files : [...files, file];
  return (
    <>
      <Row
        id="wide-key-stats-source"
        label="Source"
        value={file}
        options={[BUILT_IN, ...options]}
        optionLabel={(f) => {
          if (f === BUILT_IN) return 'Built-in (CPU, memory)';
          return files.includes(f) ? f : `${f} (missing)`;
        }}
        onChange={onChange}
      />
      <p class="multi-deck-note xkey-card-span">
        A plugin returns JSON such as {'{"cpu":12,"mem":34,"gpu":56}'}; its keys replace the
        built-in ones.
      </p>
    </>
  );
}

// The shared side-key card on the window's wire id, its image tile as the preview. It reads
// the device-level layout: the server routes a widget edit for this wire there whatever page
// layout the side-key panels edit.
function WideKeyWidget({
  wireId,
  press,
  lead,
}: Readonly<{ wireId: number; press: WideKeyPress; lead: ComponentChildren }>): preact.JSX.Element {
  const cfg = useStore((s) => s.extraKeys[String(wireId)]);
  const plugins = useFetched<PluginsInfo>('/api/plugins');
  const reloadRef = useRef(plugins.reload);
  reloadRef.current = plugins.reload;
  const isPlugin = cfg?.widget === 'plugin';
  // The plugin's live status badge needs a re-read; the other widgets have none.
  useEffect(
    function pollPluginStatus() {
      if (!isPlugin) return undefined;
      const timer = setInterval(function refresh() {
        void reloadRef.current();
      }, PLUGIN_STATUS_POLL_MS);
      return function stop() {
        clearInterval(timer);
      };
    },
    [isPlugin],
  );
  return (
    <SideKeyCard
      wireId={wireId}
      label="Widget"
      cfg={cfg}
      plugins={plugins.data ?? { files: [], dir: '' }}
      pluginStatus={plugins.data?.status[String(wireId)]}
      pressable={press === 'deckbridge'}
      wide
      lead={lead}
    />
  );
}

// Elgato keys are numbered from 1 in the WebUI; the two cells under the window are the
// last of the 5x3 grid.
const PRESS_LABELS: Readonly<Record<WideKeyPress, string>> = {
  'elgato-13': 'Elgato key 14 (row 3, column 4)',
  'elgato-14': 'Elgato key 15 (row 3, column 5)',
  deckbridge: 'DeckBridge action',
  none: 'Nothing',
};

/** 203 is the time-only clock DeckBridge always used; the others are named once measured. */
function clockLabel(mode: WideKeyClockMode): string {
  return mode === 203 ? 'Time only' : `Variant ${mode}`;
}

type Save = (change: Partial<WideKeyConfig>) => void;

// Where the Elgato app's images come from and, over a widget, how long they stay.
function ElgatoRows({
  config,
  save,
}: Readonly<{ config: WideKeyView['config']; save: Save }>): preact.JSX.Element {
  const isWidget = config.content === 'widget';
  const shows = !isWidget || config.elgatoImages === 'override';
  const handleSeconds = (e: Event): void => {
    const s = Number((e.target as HTMLInputElement).value);
    if (!Number.isFinite(s) || s < OVERRIDE_MIN_S || s > OVERRIDE_MAX_S) return;
    save({ overrideMs: Math.round(s * 1000) });
  };
  return (
    <>
      {isWidget && (
        <Row
          id="wide-key-elgato-images"
          label="Elgato images"
          value={config.elgatoImages}
          options={ELGATO_IMAGES}
          optionLabel={(v) => ELGATO_IMAGES_LABELS[v]}
          onChange={(elgatoImages) => save({ elgatoImages })}
        />
      )}
      {shows && (
        <Row
          id="wide-key-elgato-source"
          label="Source"
          value={config.elgatoSource}
          options={SOURCES}
          optionLabel={(v) => SOURCE_LABELS[v]}
          onChange={(elgatoSource) => save({ elgatoSource })}
        />
      )}
      {isWidget && shows && (
        <>
          <label class="xkey-press-label" for="wide-key-override-s">
            Widget after (s)
          </label>
          <div class="xkey-card-span">
            <NumberInput
              id="wide-key-override-s"
              min={OVERRIDE_MIN_S}
              max={OVERRIDE_MAX_S}
              value={config.overrideMs / 1000}
              onChange={handleSeconds}
            />
          </div>
        </>
      )}
    </>
  );
}

// The info window's own settings, as rows of the card grid.
function WideKeyRows({
  view,
  save,
}: Readonly<{ view: WideKeyView; save: Save }>): preact.JSX.Element {
  const { config } = view;
  return (
    <>
      <Row
        id="wide-key-content"
        label="Content"
        value={config.content}
        options={view.contents}
        optionLabel={(content) => CONTENT_LABELS[content]}
        onChange={(content) => save({ content })}
      />
      {config.content === 'clock' && (
        <>
          {view.clockModes.length > 1 && (
            <Row
              id="wide-key-clock-mode"
              label="Style"
              value={config.clockMode}
              options={view.clockModes}
              optionLabel={clockLabel}
              onChange={(clockMode) => save({ clockMode })}
            />
          )}
          <Row
            id="wide-key-hour-format"
            label="Hours"
            value={config.hourFormat}
            options={HOUR_FORMATS}
            optionLabel={(format) => HOUR_LABELS[format]}
            onChange={(hourFormat) => save({ hourFormat })}
          />
        </>
      )}
      {(config.content === 'elgato' || config.content === 'widget') && (
        <ElgatoRows config={config} save={save} />
      )}
      {config.content === 'stats' && (
        <StatsSource
          file={config.statsPlugin ?? BUILT_IN}
          onChange={(statsPlugin) => save({ statsPlugin })}
        />
      )}
      <Row
        id="wide-key-press"
        label="Sends to"
        value={config.press}
        options={view.presses}
        optionLabel={(press) => PRESS_LABELS[press]}
        onChange={(press) => save({ press })}
      />
    </>
  );
}

function WideKeyBody({ wireId }: Readonly<{ wireId: number | undefined }>): preact.JSX.Element {
  const fetched = useFetched<WideKeyView>('/api/wide-key');
  const [live, setLive] = useState<WideKeyView | null>(null);
  const action = useAsyncAction();
  const view = live ?? fetched.data;

  // Only the changed keys are posted (the server merges); local state follows at once and
  // rolls back on error.
  const save: Save = (change) => {
    if (view === null) return;
    const before = { ...view.config };
    const apply = (cur: WideKeyView | null, next: Partial<WideKeyConfig>): WideKeyView => {
      const base = cur ?? view;
      return { ...base, config: { ...base.config, ...next } };
    };
    setLive((cur) => apply(cur, change));
    void action.run(async () => {
      try {
        const saved = await postJson<WideKeyView>('/api/wide-key', { config: change });
        setLive((cur) => ({ ...saved, config: apply(cur, change).config }));
      } catch (e) {
        setLive((cur) => apply(cur, before));
        throw e;
      }
    }, 'Could not save info window settings.');
  };

  let card: preact.JSX.Element | null = null;
  if (view !== null) {
    const rows = <WideKeyRows view={view} save={save} />;
    card =
      view.config.content === 'widget' && wireId !== undefined ? (
        <WideKeyWidget wireId={wireId} press={view.config.press} lead={rows} />
      ) : (
        <div class="xkey-card">
          <WideKeyPreview content={view.config.content} hourFormat={view.config.hourFormat} />
          <div class="xkey-row xkey-card-fields">{rows}</div>
        </div>
      );
  }
  return (
    <ConfigSection title={TITLE} compact>
      {card ?? <p class="multi-deck-note">{fetched.error ?? 'Loading…'}</p>}
      <Feedback error={action.error} status={action.status} />
    </ConfigSection>
  );
}

export function WideKeyPanel(): preact.JSX.Element | null {
  const selected = useStore((s) => s.status.selectedDock);
  const hasWindow = useStore(
    (s) =>
      s.status.docks.find((d) => d.index === s.status.selectedDock)?.smallWindowModes !== undefined,
  );
  const wireId = useStore(
    (s) => s.status.docks.find((d) => d.index === s.status.selectedDock)?.wideKeyWire,
  );
  if (!hasWindow) return null;
  return <WideKeyBody key={selected} wireId={wireId} />;
}
