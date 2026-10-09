import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { HelpButton } from '../components/Icon.js';
import { Feedback, useAsyncAction } from '../lib/ui-async.js';
import { getJson, postJson } from '../lib/ui-api.js';
import { useStore } from '../lib/store.js';
import { useNow } from '../lib/ui-hooks.js';
import type { ElgatoAppStatus, Status } from '../ui-types.js';
import { ManualAddPanel } from './controls.js';
import { StatusChip } from '../components/StatusChip.js';
import { GhostButton } from '../components/GhostButton.js';

type AutoRestartPending = NonNullable<Status['elgatoAutoRestartPending']>;

function AutoRestartNotice({
  pending,
}: Readonly<{ pending: AutoRestartPending }>): preact.JSX.Element {
  const now = useNow();
  // Anchor the server's relative remainingMs to our clock at receipt; a new
  // snapshot object means a fresh remainingMs, so re-anchor.
  const anchor = useMemo(() => ({ remainingMs: pending.remainingMs, at: Date.now() }), [pending]);
  const remaining = Math.max(0, Math.ceil((anchor.remainingMs - (now - anchor.at)) / 1000));
  return (
    <div class="pairing-auto" role="status" aria-atomic="true">
      <div class="pairing-auto-head">
        <strong>{remaining > 0 ? 'Reconnecting your deck' : 'Restarting Elgato app…'}</strong>
        <StatusChip variant="accent" spin>
          {remaining > 0 ? `${remaining}s` : 'Restarting'}
        </StatusChip>
      </div>
      <p class="step-sub">
        {remaining > 0
          ? 'Elgato app will restart automatically.'
          : 'Waiting for Elgato app connection.'}
      </p>
    </div>
  );
}

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

  // Pairing may leave this page out of date; after a while, suggest a reload.
  const [showRefreshHint, setShowRefreshHint] = useState(false);
  useEffect(
    function refreshHintAfterDelay() {
      if (action.status === null) return undefined;
      const timer = window.setTimeout(() => setShowRefreshHint(true), 10_000);
      return () => {
        window.clearTimeout(timer);
        setShowRefreshHint(false);
      };
    },
    [action.status],
  );

  const label = app?.running ? 'Restart Elgato app' : 'Open Elgato app';
  let buttonLabel = app ? label : 'Checking Elgato app…';
  if (action.busy) buttonLabel = 'Please wait…';
  const activate = (): Promise<void> =>
    action.run(async () => {
      const minimumWait = app?.running
        ? Promise.resolve()
        : new Promise<void>((resolve) => window.setTimeout(resolve, 5000));
      const result = await postJson<{ ok: boolean; reason?: string }>(
        '/api/elgato-app/restart',
        undefined,
        `${label} failed`,
      );
      if (!result.ok) throw new Error(`${label} failed: ${result.reason ?? 'unknown reason'}`);
      await load();
      // Success only: errors above must surface immediately, not after the floor.
      await minimumWait;
      return app?.running ? 'Elgato app restarted.' : 'Elgato app opened.';
    });

  if (app && !app.supported) {
    return <p class="step-sub">Open or restart Elgato app on its computer.</p>;
  }

  return (
    <>
      <div class="addr-row pairing-action-row">
        {error ? (
          <GhostButton onClick={load}>Retry</GhostButton>
        ) : (
          <button
            class="ctabtn primary"
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
      <div class="pairing-feedback" aria-live="polite">
        <Feedback error={error ?? action.error} status={action.status} />
        {showRefreshHint && !error && (
          <p class="step-sub">
            Refresh the page if this WebUI is not reflecting current state of connected device.
          </p>
        )}
      </div>
    </>
  );
}

export function PairingFlow({
  onHelp,
  port,
  dock,
}: Readonly<{
  onHelp: (id: string) => void;
  port?: string;
  /** Dock this flow pairs; defaults to the selected dock (single-dock stages). */
  dock?: number;
}>): preact.JSX.Element {
  const [paired, setPaired] = useState<boolean | null>(null);
  const selectedDock = useStore((s) => s.status.selectedDock);
  const pending = useStore((s) => s.status.elgatoAutoRestartPending);
  if (pending?.docks.includes(dock ?? selectedDock)) {
    return (
      <div class="pairing-flow">
        <AutoRestartNotice pending={pending} />
      </div>
    );
  }
  return (
    <div class="pairing-flow">
      <p class="pairing-question">Already paired?</p>
      <div class="pairing-controls">
        <div class="pairing-answers" role="group" aria-label="Already paired?">
          <GhostButton aria-pressed={paired === true} onClick={() => setPaired(true)}>
            Yes
          </GhostButton>
          <GhostButton aria-pressed={paired === false} onClick={() => setPaired(false)}>
            No
          </GhostButton>
        </div>
        {paired === true && <PairedAppAction onHelp={onHelp} />}
      </div>
      {paired === false && <ManualAddPanel onHelp={onHelp} port={port} expanded />}
    </div>
  );
}
