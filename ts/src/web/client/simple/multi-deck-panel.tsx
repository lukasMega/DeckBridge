// Settings-page block for the multi-deck opt-in. DeckBridge runs a single deck
// by default and stops scanning USB once it is connected; this turns on a second
// dock (and the 3 s discovery tick that finds it).
//
// Kept out of overlays.tsx to stay under the 500-line check-loc gate.
import { useState } from 'preact/hooks';
import { Collapsible } from '../components/Collapsible.js';
import { CheckField } from '../components/Fields.js';
import { postJson } from '../ui-api.js';
import { Feedback, useAsyncAction } from '../ui-async.js';

/** `enabled` null = the settings page hasn't read /api/state yet (the toggle is
 *  disabled until then), same contract as DiagnosticsPanel's logLevel. */
export function MultiDeckPanel({
  enabled,
}: Readonly<{ enabled: boolean | null }>): preact.JSX.Element {
  const [toggled, setToggled] = useState<boolean | null>(null);
  const action = useAsyncAction();

  const on = toggled ?? enabled ?? false;

  const toggle = (next: boolean): Promise<void> =>
    action.run(async () => {
      await postJson('/api/multi-deck', { enabled: next });
      setToggled(next);
      return next
        ? 'Multiple decks on — plug in a second deck and it appears as its own dock.'
        : 'Multiple decks off — only one deck is used.';
    });

  return (
    <Collapsible title="Multiple decks" bodyId="multi-deck-body">
      <p class="help-lead">
        By default DeckBridge uses one deck and stops looking for further USB devices once it is
        connected. Turn this on to use a second supported deck at the same time — it gets its own
        Network Dock entry in the Elgato app. Maximum two decks.
      </p>
      <CheckField
        id="toggle-multi-deck"
        label="Use two decks at once"
        checked={on}
        onChange={(next) => void toggle(next)}
      />
      <p class="fine small">
        Turning this off disconnects the second deck. Its settings are kept, so turning it back on
        restores the dock.
      </p>
      <Feedback error={action.error} status={action.status} />
    </Collapsible>
  );
}
