// Touch-strip ownership (AKP05E) and the knob override that rides on it. The
// knobs can only leave the Elgato app while DeckBridge owns the strip — see
// docs/side-keys.md.
import { useStore } from '../store.js';
import type { EncoderCommands, TouchStripMode } from '../ui-types.js';
import { CheckField } from '../components/Fields.js';
import { fire } from '../ui-api.js';

const ENCODER_COMMAND_MAX = 512; // mirrors ENCODER_COMMAND_MAX (types.ts)

const MODE_OPTIONS: ReadonlyArray<{ value: TouchStripMode; label: string; title: string }> = [
  {
    value: 'elgato',
    label: 'Elgato app only',
    title: 'The Elgato app paints the whole strip; DeckBridge widgets are off',
  },
  {
    value: 'deckbridge-ignore',
    label: 'DeckBridge overrides (ignore)',
    title: 'DeckBridge widgets; everything the Elgato app sends to the strip is dropped',
  },
  {
    value: 'deckbridge-repaint',
    label: 'DeckBridge overrides (repaint)',
    title: 'DeckBridge widgets on assigned zones; the Elgato app keeps the rest',
  },
];

const COMMAND_FIELDS: ReadonlyArray<{ key: keyof EncoderCommands; label: string; hint: string }> = [
  { key: 'press', label: 'press', hint: 'on press' },
  { key: 'rotateCw', label: 'turn right', hint: 'on clockwise turn' },
  { key: 'rotateCcw', label: 'turn left', hint: 'on counter-clockwise turn' },
];

export function TouchStripModePicker({
  mode,
}: Readonly<{ mode: TouchStripMode }>): preact.JSX.Element {
  return (
    <div
      class="pad-fill-options strip-mode-options"
      role="radiogroup"
      aria-label="Touch strip mode"
    >
      {MODE_OPTIONS.map(({ value, label, title }) => (
        <label key={value} class="pad-fill-option" title={title}>
          <input
            type="radio"
            name="touch-strip-mode"
            value={value}
            checked={mode === value}
            onChange={() => fire('/api/touch-strip-mode', { mode: value })}
          />
          <span>{label}</span>
        </label>
      ))}
    </div>
  );
}

// change (not input) — commits on blur/Enter, like the extra-key ParamInput.
function KnobRow({
  index,
  commands,
}: Readonly<{ index: number; commands: EncoderCommands }>): preact.JSX.Element {
  const label = `Knob ${index + 1}`;
  return (
    <div class="xkey-row">
      <span class="xkey-pos">{label}</span>
      {COMMAND_FIELDS.map(({ key, label: field, hint }) => (
        <input
          key={key}
          class="input xkey-select xkey-param"
          type="text"
          maxLength={ENCODER_COMMAND_MAX}
          value={commands[key] ?? ''}
          placeholder={`${field} command`}
          title={`Shell command run ${hint}`}
          aria-label={`${label} ${field} command`}
          onChange={(e) =>
            fire('/api/encoders', {
              commands: {
                [index]: { ...commands, [key]: (e.target as HTMLInputElement).value },
              },
            })
          }
        />
      ))}
    </div>
  );
}

/** Knob section — the caller renders it only in a deckbridge-* strip mode. */
export function EncodersSection({ count }: Readonly<{ count: number }>): preact.JSX.Element {
  const encoders = useStore((s) => s.encoders);
  const connected = encoders.connectToApp ?? true;
  return (
    <div class="xkeys-knobs">
      <div class="xkeys-head">
        <span class="xkeys-label">Knobs</span>
        <CheckField
          label="Connect knobs to Elgato app"
          checked={connected}
          onChange={(v) => fire('/api/encoders', { connectToApp: v })}
        />
      </div>
      {!connected &&
        Array.from({ length: count }, (_, i) => (
          <KnobRow key={i} index={i} commands={encoders.commands?.[String(i)] ?? {}} />
        ))}
    </div>
  );
}
