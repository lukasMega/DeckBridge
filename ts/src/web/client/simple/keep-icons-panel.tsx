// Settings-page block for the saved icons: after a restart the deck shows the last icons,
// each with a red "!", until the Elgato app repaints it. On by default.
import { DocsLink } from '../components/DocsLink.js';
import { Collapsible } from '../components/Collapsible.js';
import { ToggleRow } from '../components/Fields.js';
import { Feedback, useServerToggle } from '../lib/ui-async.js';

/** `enabled` null = the settings page hasn't read /api/state yet (toggle disabled until then). */
export function KeepIconsPanel({
  enabled,
}: Readonly<{ enabled: boolean | null }>): preact.JSX.Element {
  const { value, action, toggle } = useServerToggle('/api/keep-last-icons', enabled, (next) =>
    next ? 'Last icons are kept.' : 'Last icons are off. Saved icons were deleted.',
  );

  return (
    <Collapsible title="Last icons" bodyId="keep-icons-body" status={value}>
      <ToggleRow
        id="toggle-keep-icons"
        label="Show the last icons after a restart"
        checked={value ?? true}
        disabled={enabled === null}
        onChange={(next) => void toggle(next)}
      />
      <p class="multi-deck-note">
        Keys show a red &quot;!&quot; until the Elgato app sends a fresh icon. Icons are saved on
        this computer for up to 24 hours. They can show private text, so turn this off to delete
        them. <DocsLink topic="last-icons" />
      </p>
      <Feedback error={action.error} status={action.status} />
    </Collapsible>
  );
}
