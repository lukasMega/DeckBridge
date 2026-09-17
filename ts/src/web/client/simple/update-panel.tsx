// Settings-page block for the GitHub-release update check (see update-check.ts).
// Notify only — no download/self-update. Kept out of overlays.tsx to stay under
// the 500-line check-loc gate, same reason as MultiDeckPanel.
import { useState } from 'preact/hooks';
import { Collapsible } from '../components/Collapsible.js';
import { CheckField } from '../components/Fields.js';
import { postJson } from '../ui-api.js';
import { Feedback, useAsyncAction } from '../ui-async.js';
import type { UpdateInfo } from '../ui-types.js';

/** `info` null = the settings page hasn't read /api/state yet. */
export function UpdatePanel({ info }: Readonly<{ info: UpdateInfo | null }>): preact.JSX.Element {
  const [live, setLive] = useState<UpdateInfo | null>(null);
  const action = useAsyncAction();

  const current = live ?? info;
  const enabled = current?.enabled ?? true;

  const check = (): Promise<void> =>
    action.run(async () => {
      const result = await postJson<UpdateInfo>('/api/update/check', undefined, 'Check failed');
      setLive(result);
      return result.updateAvailable
        ? `v${result.latest} is available.`
        : 'You’re on the latest version.';
    }, 'Check failed.');

  const toggle = (next: boolean): Promise<void> =>
    action.run(async () => {
      await postJson('/api/update-check-enabled', { enabled: next });
      setLive({ ...(current as UpdateInfo), enabled: next });
    });

  return (
    <Collapsible title="Updates" bodyId="update-body">
      <div class="multi-deck-row">
        <CheckField
          id="toggle-update-check"
          label="Check for updates"
          checked={enabled}
          onChange={(next) => void toggle(next)}
        />
      </div>
      {current?.updateAvailable && (
        <p class="multi-deck-note">
          <a href={current.releaseUrl} target="_blank" rel="noopener">
            v{current.latest} available — release notes ↗
          </a>
        </p>
      )}
      <button
        class="ghostbtn"
        type="button"
        disabled={!enabled || action.busy}
        onClick={() => void check()}
      >
        {action.busy ? 'Checking…' : 'Check now'}
      </button>
      <Feedback error={action.error} status={action.status} />
    </Collapsible>
  );
}
