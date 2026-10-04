import { useCallback, useEffect, useState } from 'preact/hooks';
import { HelpButton } from '../components/Icon.js';
import { Feedback, useAsyncAction } from '../lib/ui-async.js';
import { getJson, postJson } from '../lib/ui-api.js';
import type { ElgatoAppStatus } from '../ui-types.js';
import { ManualAddPanel } from './controls.js';

function PairedAppAction({
  onHelp,
}: Readonly<{ onHelp: (id: string) => void }>): preact.JSX.Element {
  const [app, setApp] = useState<ElgatoAppStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const action = useAsyncAction();
  const load = useCallback(async (signal?: AbortSignal): Promise<void> => {
    try {
      const status = await getJson<ElgatoAppStatus>('/api/elgato-app/status', signal);
      if (signal?.aborted) return;
      setApp(status);
      setError(null);
    } catch {
      if (!signal?.aborted) setError('Cannot check Elgato app.');
    }
  }, []);

  useEffect(
    function watchApp() {
      const ctrl = new AbortController();
      const refresh = (): void => void load(ctrl.signal);
      refresh();
      const timer = window.setInterval(refresh, 3000);
      window.addEventListener('focus', refresh);
      return () => {
        ctrl.abort();
        window.clearInterval(timer);
        window.removeEventListener('focus', refresh);
      };
    },
    [load],
  );

  const label = app?.running ? 'Restart Elgato app' : 'Open Elgato app';
  let buttonLabel = app ? label : 'Checking Elgato app…';
  if (action.busy) buttonLabel = 'Please wait…';
  const activate = (): Promise<void> =>
    action.run(async () => {
      const result = await postJson<{ ok: boolean; reason?: string }>(
        '/api/elgato-app/restart',
        undefined,
        `${label} failed`,
      );
      if (!result.ok) throw new Error(`${label} failed: ${result.reason ?? 'unknown reason'}`);
      await load();
      return app?.running ? 'Elgato app restarted.' : 'Elgato app opened.';
    });

  if (app && !app.supported) {
    return <p class="step-sub">Open or restart Elgato app on its computer.</p>;
  }

  return (
    <>
      <div class="addr-row pairing-action-row">
        {error ? (
          <button class="ghostbtn" type="button" onClick={() => void load()}>
            Retry
          </button>
        ) : (
          <button
            class="ctabtn pairing-action"
            type="button"
            disabled={!app || action.busy}
            title="Controls the Elgato app on the computer running DeckBridge"
            onClick={() => void activate()}
          >
            {buttonLabel}
          </button>
        )}
        <HelpButton
          helpId="open-app"
          onHelp={onHelp}
          ariaLabel="Help: open the Elgato app"
          title="Show me how"
        />
      </div>
      <div aria-live="polite">
        <Feedback error={error ?? action.error} status={action.status} />
      </div>
    </>
  );
}

export function PairingFlow({
  onHelp,
  port,
}: Readonly<{ onHelp: (id: string) => void; port?: string }>): preact.JSX.Element {
  const [paired, setPaired] = useState<boolean | null>(null);
  return (
    <div class="pairing-flow">
      <p class="pairing-question">Already paired?</p>
      <div class="pairing-answers" role="group" aria-label="Already paired?">
        <button
          class="ghostbtn"
          type="button"
          aria-pressed={paired === true}
          onClick={() => setPaired(true)}
        >
          Yes
        </button>
        <button
          class="ghostbtn"
          type="button"
          aria-pressed={paired === false}
          onClick={() => setPaired(false)}
        >
          No
        </button>
      </div>
      {paired === true && <PairedAppAction onHelp={onHelp} />}
      {paired === false && <ManualAddPanel onHelp={onHelp} port={port} expanded />}
    </div>
  );
}
