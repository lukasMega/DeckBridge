// Settings-page block for click-to-press: lets the dock preview fire key presses on the
// Elgato app. Off by default, because anyone who can open the WebUI could press your keys.
import { useState } from 'preact/hooks';
import { Collapsible } from '../components/Collapsible.js';
import { ToggleRow } from '../components/Fields.js';
import { postJson } from '../lib/ui-api.js';
import { Feedback, useAsyncAction } from '../lib/ui-async.js';
import { patch } from '../lib/store.js';

/** `enabled` null = the settings page hasn't read /api/state yet (toggle disabled until then). */
export function KeyPressPanel({
  enabled,
}: Readonly<{ enabled: boolean | null }>): preact.JSX.Element {
  const [toggled, setToggled] = useState<boolean | null>(null);
  const action = useAsyncAction();

  const on = toggled ?? enabled ?? false;

  const toggle = (next: boolean): Promise<void> =>
    action.run(async () => {
      await postJson('/api/webui-key-press', { enabled: next });
      setToggled(next);
      // The dock cards read the store, not this panel's one-shot state read.
      patch({ keyPressEnabled: next });
      return next ? 'Click to press is on.' : 'Click to press is off.';
    });

  return (
    <Collapsible title="Click to press" bodyId="key-press-body" status={toggled ?? enabled}>
      <ToggleRow
        id="toggle-key-press"
        label="Click to press"
        checked={on}
        disabled={enabled === null}
        onChange={(next) => void toggle(next)}
      />
      <p class="multi-deck-note">
        Double-click a key in the preview to press it on the Elgato app. Anyone who can open this
        page can press your keys.
      </p>
      <Feedback error={action.error} status={action.status} />
    </Collapsible>
  );
}
