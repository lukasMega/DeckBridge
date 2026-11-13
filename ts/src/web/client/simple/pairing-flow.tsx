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

const LAUNCH_PROGRESS_MS = 10_000;

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

  // Launch takes a while: show progress instead of the button until the app is likely up.
  const [launching, setLaunching] = useState(false);
  useEffect(
    function endLaunchProgress() {
      if (!launching) return undefined;
      const timer = window.setTimeout(() => setLaunching(false), LAUNCH_PROGRESS_MS);
      return () => window.clearTimeout(timer);
    },
    [launching],
  );

  const label = app?.running ? 'Restart Elgato app' : 'Open Elgato app';
  const buttonLabel = app ? label : 'Checking Elgato app…';
  const activate = (): Promise<void> => {
    setLaunching(true);
    return action.run(async () => {
      try {
        const result = await postJson<{ ok: boolean; reason?: string }>(
          '/api/elgato-app/restart',
          undefined,
          `${label} failed`,
        );
        if (!result.ok) throw new Error(`${label} failed: ${result.reason ?? 'unknown reason'}`);
      } catch (e) {
        // Errors surface immediately, with the button back for a retry.
        setLaunching(false);
        throw e;
      }
      await load();
      return app?.running ? 'Elgato app restarted.' : 'Elgato app opened.';
    });
  };

  if (app && !app.supported) {
    return <p class="step-sub">Open or restart Elgato app on its computer.</p>;
  }

  let control: preact.JSX.Element;
  if (error) {
    control = <GhostButton onClick={load}>Retry</GhostButton>;
  } else if (launching || action.busy) {
    control = (
      <div
        class="pairing-progress"
        role="progressbar"
        aria-label="Waiting for Elgato app"
        aria-busy="true"
      >
        <span style={{ animationDuration: `${LAUNCH_PROGRESS_MS}ms` }} />
      </div>
    );
  } else {
    control = (
      <button
        class="ctabtn primary"
        type="button"
        disabled={!app}
        title="Controls the Elgato app on the computer running DeckBridge"
        onClick={() => void activate()}
      >
        {buttonLabel}
      </button>
    );
  }

  return (
    <>
      <div class="addr-row pairing-action-row">
        {control}
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
      <p class="pairing-question">Already paired with your control app?</p>
      <div class="pairing-controls">
        <div
          class="pairing-answers"
          role="group"
          aria-label="Already paired with your control app?"
        >
          <GhostButton
            class="pairing-choice"
            aria-pressed={paired === true}
            onClick={() => setPaired(true)}
          >
            <strong>Yes, already paired{paired === true && ' ✓'}</strong>
            <span>Open or restart Elgato app.</span>
          </GhostButton>
          <GhostButton
            class="pairing-choice"
            aria-pressed={paired === false}
            onClick={() => setPaired(false)}
          >
            <strong>No, set up pairing{paired === false && ' ✓'}</strong>
            <span>Show pairing steps and address.</span>
          </GhostButton>
        </div>
        {paired === true && <PairedAppAction onHelp={onHelp} />}
      </div>
      {paired === false && <ManualAddPanel onHelp={onHelp} port={port} expanded />}
    </div>
  );
}
