// Touch-strip ownership (AKP05E) and the knob override that rides on it. The
// knobs can only leave the Elgato app while DeckBridge owns the strip — see
// docs/side-keys.md.
import { useStore } from '../store.js';
import type { EncoderCommands, TouchStripMode } from '../ui-types.js';
import { CheckField, SecondsField } from '../components/Fields.js';
import { fire } from '../ui-api.js';
import { CommandInput } from './command-input.js';
import { GridHeader } from './config-section.js';

const MODE_OPTIONS: ReadonlyArray<{ value: TouchStripMode; label: string; description: string }> = [
  {
    value: 'elgato',
    label: 'Elgato app only',
    description: 'The Elgato app paints the whole strip; DeckBridge widgets are off.',
  },
  {
    value: 'deckbridge-ignore',
    label: 'DeckBridge overrides (ignore)',
    description: 'DeckBridge widgets; everything the Elgato app sends to the strip is dropped.',
  },
  {
    value: 'deckbridge-repaint',
    label: 'DeckBridge overrides (repaint)',
    description:
      'Elgato app images always show; a widget comes back once the app stops drawing on its zone.',
  },
];

const COMMAND_FIELDS: ReadonlyArray<{ key: keyof EncoderCommands; label: string; hint: string }> = [
  { key: 'press', label: 'Press', hint: 'on press' },
  { key: 'rotateCw', label: 'Turn right', hint: 'on clockwise turn' },
  { key: 'rotateCcw', label: 'Turn left', hint: 'on counter-clockwise turn' },
];

const KNOB_COLUMNS = [{ label: 'Knob' }, ...COMMAND_FIELDS.map(({ label }) => ({ label }))];

export function touchStripModeDescription(mode: TouchStripMode): string {
  return MODE_OPTIONS.find((o) => o.value === mode)?.description ?? '';
}

export function TouchStripModeSelect({
  mode,
}: Readonly<{ mode: TouchStripMode }>): preact.JSX.Element {
  return (
    <select
      class="input xkey-select xkey-mode"
      value={mode}
      aria-label="Touch strip mode"
      onChange={(e) =>
        fire('/api/touch-strip-mode', { mode: (e.target as HTMLSelectElement).value })
      }
    >
      {MODE_OPTIONS.map(({ value, label }) => (
        <option key={value} value={value}>
          {label}
        </option>
      ))}
    </select>
  );
}

function KnobRow({
  index,
  commands,
}: Readonly<{ index: number; commands: EncoderCommands }>): preact.JSX.Element {
  const label = `Knob ${index + 1}`;
  return (
    <div class="xkey-row xkey-knob-row">
      <span class="xkey-pos">{label}</span>
      {COMMAND_FIELDS.map(({ key, label: field, hint }) => (
        <CommandInput
          key={key}
          value={commands[key] ?? ''}
          label={`${label} ${field.toLowerCase()} command`}
          placeholder="command"
          title={`Shell command run ${hint}`}
          onCommit={(command) =>
            fire('/api/encoders', { commands: { [index]: { ...commands, [key]: command } } })
          }
        />
      ))}
    </div>
  );
}

// Bounds mirror TOUCH_STRIP_REPAINT_MIN_MS / _MAX_MS (types.ts), in seconds.
const REPAINT_MIN_S = 1;
const REPAINT_MAX_S = 3600;

/** 'deckbridge-repaint' only: how long the app's image stays before the widget returns. */
export function RepaintIntervalField(): preact.JSX.Element {
  const ms = useStore((s) => s.touchStripRepaintMs);
  return (
    <SecondsField
      class="xkeys-option"
      label="Repaint after (s)"
      min={REPAINT_MIN_S}
      max={REPAINT_MAX_S}
      value={ms / 1000}
      onCommit={(next) => fire('/api/touch-strip-repaint', { ms: next })}
    />
  );
}

/** Knob sub-block — the caller renders it only in a deckbridge-* strip mode. */
export function EncodersSection({ count }: Readonly<{ count: number }>): preact.JSX.Element {
  const encoders = useStore((s) => s.encoders);
  const connected = encoders.connectToApp ?? true;
  return (
    <div class="xkeys-knobs">
      <div class="preview-head xkeys-head">
        <span class="preview-label">Knobs</span>
        <CheckField
          label="Connect knobs to Elgato app"
          checked={connected}
          onChange={(v) => fire('/api/encoders', { connectToApp: v })}
        />
      </div>
      {!connected && (
        <>
          <GridHeader class="xkey-knob-row" columns={KNOB_COLUMNS} />
          {Array.from({ length: count }, (_, i) => (
            <KnobRow key={i} index={i} commands={encoders.commands?.[String(i)] ?? {}} />
          ))}
        </>
      )}
    </div>
  );
}
