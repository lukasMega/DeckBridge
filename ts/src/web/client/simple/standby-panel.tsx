// Settings-page panel for idle dim, screen off, standby clock, night mode and pixel shift
// (main/dock-standby.ts). Acts on the selected dock; the outer component re-keys the body
// per dock so a dock switch re-reads that dock's settings.
import { useState } from 'preact/hooks';
import { Collapsible } from '../components/Collapsible.js';
import { NumberField, SelectField, ToggleRow } from '../components/Fields.js';
import { useStore } from '../lib/store.js';
import { postJson, useFetched } from '../lib/ui-api.js';
import { Feedback, useAsyncAction } from '../lib/ui-async.js';
import type { DockUi } from '../ui-types.js';
import type {
  StandbyAppGoneAction,
  StandbyOffMode,
  StandbyView,
  StandbyWakePress,
} from '../../contract-standby.js';

type Settings = StandbyView['settings'];
type Save = (change: Partial<Settings>) => void;

const TITLE = 'Standby & burn-in care';
const OFF_MODES: readonly StandbyOffMode[] = ['auto', 'brightness0'];
const OFF_MODE_LABELS: Readonly<Record<StandbyOffMode, string>> = {
  auto: 'Sleep if supported, else brightness 0',
  brightness0: 'Brightness 0',
};
const WAKE_PRESSES: readonly StandbyWakePress[] = ['swallow', 'forward'];
const WAKE_LABELS: Readonly<Record<StandbyWakePress, string>> = {
  swallow: 'Only wakes the deck',
  forward: 'Wakes and runs the key',
};
const APP_GONE_LABELS: Readonly<Record<StandbyAppGoneAction, string>> = {
  none: 'Keep showing the last images',
  clock: 'Show a dim clock',
  off: 'Turn the screen off',
};

/** One string per dock, so the selector stays primitive (no fresh object per render). */
function nowText(dock: DockUi | undefined): string | null {
  const state = dock?.displayState;
  if (dock === undefined || state === undefined) return null;
  const level = dock.effectiveBrightness ?? dock.brightness;
  if (state === 'dimmed') return `Dimmed to ${level}% (requested ${dock.brightness}%)`;
  if (state === 'night') return `Night (${level}%)`;
  if (state === 'standby') return 'Standby clock';
  if (state === 'off') return 'Screen off';
  return `Active (${level}%)`;
}

function Level({
  label,
  field,
  s,
  max = 100,
  disabled,
  save,
}: Readonly<{
  label: string;
  field: 'idleMinutes' | 'idleLevel' | 'offMinutes' | 'clockLevel' | 'nightLevel';
  s: Settings;
  max?: number;
  disabled: boolean;
  save: Save;
}>): preact.JSX.Element {
  // Out-of-range input is ignored, not clamped: the field would fight the user mid-typing.
  const commit = (v: number | undefined): void => {
    if (v !== undefined && Number.isInteger(v) && v >= 1 && v <= max) save({ [field]: v });
  };
  return (
    <NumberField
      label={label}
      value={s[field]}
      min={1}
      max={max}
      disabled={disabled}
      onChange={commit}
    />
  );
}

function TimeField({
  label,
  value,
  disabled,
  onChange,
}: Readonly<{
  label: string;
  value: string;
  disabled: boolean;
  onChange: (v: string) => void;
}>): preact.JSX.Element {
  return (
    <label class="tuning-field">
      <span>{label}</span>
      <input
        class="input"
        type="time"
        step={60}
        value={value}
        disabled={disabled}
        onChange={(e) => {
          const next = (e.target as HTMLInputElement).value;
          if (next !== '') onChange(next);
        }}
      />
    </label>
  );
}

function IdleGroups({
  view,
  save,
}: Readonly<{ view: StandbyView; save: Save }>): preact.JSX.Element {
  const s = view.settings;
  return (
    <>
      <div class="tuning-group">
        <p class="tuning-group-label">Dim when idle</p>
        <ToggleRow
          id="toggle-standby-idle-dim"
          label="Dim the deck when idle"
          checked={s.idleDim}
          onChange={(idleDim) => save({ idleDim })}
        />
        <Level
          label="After (minutes)"
          field="idleMinutes"
          max={240}
          s={s}
          disabled={!s.idleDim}
          save={save}
        />
        <Level
          label="Dimmed brightness (%)"
          field="idleLevel"
          s={s}
          disabled={!s.idleDim}
          save={save}
        />
      </div>
      <div class="tuning-group">
        <p class="tuning-group-label">Screen off</p>
        <ToggleRow
          id="toggle-standby-off"
          label="Turn the screen off when idle"
          checked={s.offWhenIdle}
          onChange={(offWhenIdle) => save({ offWhenIdle })}
        />
        <Level
          label="After (minutes)"
          field="offMinutes"
          max={1440}
          s={s}
          disabled={!s.offWhenIdle}
          save={save}
        />
        <SelectField
          label="How to turn it off"
          value={s.offMode}
          options={OFF_MODES}
          optionLabel={(mode) => OFF_MODE_LABELS[mode]}
          disabled={!s.offWhenIdle}
          onChange={(offMode) => save({ offMode })}
        />
        <p class="multi-deck-note">
          {view.canSleep ? 'This device: sleep mode' : 'This device: brightness 0 (no sleep mode)'}
        </p>
      </div>
      <div class="tuning-group">
        <p class="tuning-group-label">Wake press</p>
        <SelectField
          label="First press on a dimmed or dark deck"
          value={s.wakePress}
          options={WAKE_PRESSES}
          optionLabel={(mode) => WAKE_LABELS[mode]}
          onChange={(wakePress) => save({ wakePress })}
        />
        {view.hasCommands && (
          <p class="multi-deck-note">Sleep/wake commands are set in settings.json</p>
        )}
      </div>
    </>
  );
}

function AwayGroups({
  view,
  save,
}: Readonly<{ view: StandbyView; save: Save }>): preact.JSX.Element {
  const s = view.settings;
  const actions: StandbyAppGoneAction[] = view.canShowClock
    ? ['none', 'clock', 'off']
    : ['none', 'off'];
  return (
    <>
      <div class="tuning-group">
        <p class="tuning-group-label">When the Elgato app is away</p>
        <SelectField
          label="Deck shows"
          value={s.appGoneAction}
          options={actions}
          optionLabel={(action) => APP_GONE_LABELS[action]}
          onChange={(appGoneAction) => save({ appGoneAction })}
        />
        <Level
          label="Clock brightness (%)"
          field="clockLevel"
          s={s}
          disabled={s.appGoneAction !== 'clock'}
          save={save}
        />
      </div>
      <div class="tuning-group">
        <p class="tuning-group-label">Night mode</p>
        <ToggleRow
          id="toggle-standby-night"
          label="Night mode"
          checked={s.night}
          onChange={(night) => save({ night })}
        />
        <TimeField
          label="From"
          value={s.nightStart}
          disabled={!s.night}
          onChange={(nightStart) => save({ nightStart })}
        />
        <TimeField
          label="To"
          value={s.nightEnd}
          disabled={!s.night}
          onChange={(nightEnd) => save({ nightEnd })}
        />
        <p class="multi-deck-note">DeckBridge time now: {view.serverTime}</p>
        <Level
          label="Night brightness (%)"
          field="nightLevel"
          s={s}
          disabled={!s.night}
          save={save}
        />
        <ToggleRow
          id="toggle-standby-night-off"
          label="Turn the screen off when idle at night"
          checked={s.nightOffWhenIdle}
          disabled={!s.night}
          onChange={(nightOffWhenIdle) => save({ nightOffWhenIdle })}
        />
      </div>
      <div class="tuning-group">
        <p class="tuning-group-label">Pixel shift</p>
        <ToggleRow
          id="toggle-standby-pixel-shift"
          label="Shift DeckBridge widgets by 1 px (reduces image retention)"
          checked={s.pixelShift}
          onChange={(pixelShift) => save({ pixelShift })}
        />
      </div>
    </>
  );
}

function StandbyBody({
  modelName,
}: Readonly<{ modelName: string | undefined }>): preact.JSX.Element {
  const fetched = useFetched<StandbyView>('/api/standby');
  const [live, setLive] = useState<StandbyView | null>(null);
  const action = useAsyncAction();
  const now = useStore((s) =>
    nowText(s.status.docks.find((d) => d.index === s.status.selectedDock)),
  );
  const view = live ?? fetched.data;

  // Only the changed keys are posted (the server merges), so two quick edits can't
  // revert each other from a stale view; local state follows at once and rolls back on error.
  const save: Save = (change) => {
    if (view === null) return;
    const before = { ...(live ?? view).settings };
    const apply = (cur: StandbyView | null, next: Partial<Settings>): StandbyView => {
      const base = cur ?? view;
      return { ...base, settings: { ...base.settings, ...next } };
    };
    setLive((cur) => apply(cur, change));
    void action.run(async () => {
      try {
        const saved = await postJson<StandbyView>('/api/standby', { settings: change });
        setLive((cur) => ({ ...saved, settings: apply(cur, change).settings }));
      } catch (e) {
        const undo: Record<string, unknown> = {};
        for (const key of Object.keys(change)) undo[key] = before[key as keyof Settings];
        setLive((cur) => apply(cur, undo));
        throw e;
      }
    }, 'Could not save standby settings.');
  };

  return (
    <Collapsible
      title={modelName === undefined ? TITLE : `${TITLE} — ${modelName}`}
      bodyId="standby-body"
      status={now ?? undefined}
    >
      {now !== null && <p class="multi-deck-note">Now: {now}</p>}
      {view === null ? (
        <p class="multi-deck-note">{fetched.error ?? 'Loading…'}</p>
      ) : (
        <>
          <IdleGroups view={view} save={save} />
          <AwayGroups view={view} save={save} />
        </>
      )}
      <Feedback error={action.error} status={action.status} />
    </Collapsible>
  );
}

export function StandbyPanel(): preact.JSX.Element {
  const selected = useStore((s) => s.status.selectedDock);
  const modelName = useStore(
    (s) => s.status.docks.find((d) => d.index === s.status.selectedDock)?.modelName,
  );
  return <StandbyBody key={selected} modelName={modelName} />;
}
