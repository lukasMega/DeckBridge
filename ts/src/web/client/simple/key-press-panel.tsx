// Settings-page block for click-to-press: lets the dock preview fire key presses on the
// Elgato app. Off by default, because anyone who can open the WebUI could press your keys.
import { DocsLink } from '../components/DocsLink.js';
import { Collapsible } from '../components/Collapsible.js';
import { ToggleRow } from '../components/Fields.js';
import { Feedback, useServerToggle } from '../lib/ui-async.js';
import { patch } from '../lib/store.js';

/** `enabled` null = the settings page hasn't read /api/state yet (toggle disabled until then). */
export function KeyPressPanel({
  enabled,
}: Readonly<{ enabled: boolean | null }>): preact.JSX.Element {
  const { value, action, toggle } = useServerToggle('/api/webui-key-press', enabled, (next) => {
    // The dock cards read the store, not this panel's one-shot state read.
    patch({ keyPressEnabled: next });
    return next ? 'Click to press is on.' : 'Click to press is off.';
  });

  return (
    <Collapsible title="Click to press" bodyId="key-press-body" status={value}>
      <ToggleRow
        id="toggle-key-press"
        label="Click to press"
        checked={value ?? false}
        disabled={enabled === null}
        onChange={(next) => void toggle(next)}
      />
      <p class="multi-deck-note">
        Double-click a preview key to press it. Anyone who can open this page can press your keys.{' '}
        <DocsLink topic="click-to-press" />
      </p>
      <Feedback error={action.error} status={action.status} />
    </Collapsible>
  );
}
