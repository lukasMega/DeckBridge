// Settings-page block for the Elgato-app auto-restart feature (see
// infra/elgato-app.ts, main/elgato-auto-restart.ts, §4.4 of the plan). Kept out
// of overlays.tsx to stay under the 500-line check-loc gate, same reason as
// UpdatePanel.
import { useState } from 'preact/hooks';
import { Collapsible } from '../components/Collapsible.js';
import { NumberField, ToggleRow } from '../components/Fields.js';
import { postJson } from '../lib/ui-api.js';
import { Feedback, useAsyncAction } from '../lib/ui-async.js';
import type { ElgatoAutoRestartState } from '../ui-types.js';

const UNSUPPORTED_NOTE = 'Only on macOS and Windows, and only for an Elgato app on this computer.';

interface RestartReply {
  ok: boolean;
  killed?: boolean;
  reason?: string;
}

/** `state` null = the settings page hasn't read /api/state yet. */
export function ElgatoAppPanel({
  state,
}: Readonly<{ state: ElgatoAutoRestartState | null }>): preact.JSX.Element {
  const [live, setLive] = useState<ElgatoAutoRestartState | null>(null);
  const action = useAsyncAction();

  const current = live ?? state;
  const enabled = current?.enabled ?? true;
  const delayS = current?.delayS ?? 10;
  const supported = current?.supported ?? true;

  const toggle = (next: boolean): Promise<void> =>
    action.run(async () => {
      const reply = await postJson<{ enabled: boolean; delayS: number }>(
        '/api/elgato-auto-restart',
        { enabled: next },
      );
      setLive({ ...(current as ElgatoAutoRestartState), ...reply });
    });

  const changeDelay = (next: number | undefined): Promise<void> => {
    if (next === undefined) return Promise.resolve();
    return action.run(async () => {
      const reply = await postJson<{ enabled: boolean; delayS: number }>(
        '/api/elgato-auto-restart',
        { enabled, delayS: next },
      );
      setLive({ ...(current as ElgatoAutoRestartState), ...reply });
    });
  };

  const restartNow = (): Promise<void> =>
    action.run(async () => {
      const result = await postJson<RestartReply>(
        '/api/elgato-app/restart',
        undefined,
        'Restart failed',
      );
      if (!result.ok) throw new Error(`Restart failed: ${result.reason ?? 'unknown reason'}`);
      return result.killed
        ? 'Elgato app restarted (had to force-quit it).'
        : 'Elgato app restarted.';
    }, 'Restart failed.');

  return (
    <Collapsible title="Elgato app" bodyId="elgato-app-body">
      {!supported && <p class="multi-deck-note">{UNSUPPORTED_NOTE}</p>}
      <ToggleRow
        id="toggle-elgato-auto-restart"
        label="Restart the Elgato app when a paired deck connects"
        checked={enabled}
        disabled={!supported}
        onChange={(next) => void toggle(next)}
      />
      <NumberField
        label="Wait before restarting (seconds)"
        value={delayS}
        min={3}
        max={120}
        disabled={!supported || !enabled}
        onChange={(next) => void changeDelay(next)}
      />
      <button
        class="ghostbtn"
        type="button"
        disabled={!supported || action.busy}
        onClick={() => void restartNow()}
      >
        {action.busy ? 'Restarting…' : 'Restart Elgato app now'}
      </button>
      <Feedback error={action.error} status={action.status} />
    </Collapsible>
  );
}
