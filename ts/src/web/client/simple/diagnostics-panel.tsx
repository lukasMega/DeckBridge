// Settings-page block for producing a bug report: the debug-logging toggle, the
// log-file location, and the two diagnostics-report actions.
//
// Kept out of overlays.tsx to stay under the 500-line check-loc gate.
import { useEffect, useState } from 'preact/hooks';
import { Collapsible } from '../components/Collapsible.js';

/** Shown next to both report buttons and repeated as the report's own first line
 *  (diagnostics.ts REVIEW_NOTICE) — the file outlives this screen. */
const PRIVACY_NOTE =
  'Includes your settings, extra-key commands and local paths. Review before posting publicly.';

const TROUBLESHOOTING_URL = 'https://deckbridge.dev/docs/troubleshooting';

interface LogState {
  logLevel: string;
  logFilePath: string;
}

async function postJson(url: string, body?: unknown): Promise<void> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!r.ok) {
    const parsed = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(parsed.error ?? `Request failed (${r.status})`);
  }
}

export function DiagnosticsPanel(): preact.JSX.Element {
  const [log, setLog] = useState<LogState | null>(null);
  const [redact, setRedact] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    void fetch('/api/state', { signal: ctrl.signal })
      .then((r) => r.json() as Promise<Partial<LogState>>)
      .then((s) => {
        setLog({ logLevel: s.logLevel ?? 'info', logFilePath: s.logFilePath ?? '' });
        return undefined;
      })
      .catch(() => setLog(null));
    return () => ctrl.abort();
  }, []);

  // Debug-on is the single instruction we can give a reporter, so the toggle is
  // binary: debug ⇄ info. Finer levels stay available via --log-level.
  const debugOn = log?.logLevel === 'debug';

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await action();
    } catch (e) {
      setError((e as Error).message || 'Failed.');
    } finally {
      setBusy(false);
    }
  }

  const toggleDebug = (): Promise<void> =>
    run(async () => {
      const level = debugOn ? 'info' : 'debug';
      await postJson('/api/log-level', { level });
      setLog((prev) => (prev ? { ...prev, logLevel: level } : prev));
      setStatus(
        level === 'debug'
          ? 'Debug logging on — reproduce the problem, then create a report.'
          : 'Debug logging off.',
      );
    });

  const download = (): Promise<void> =>
    run(async () => {
      const r = await fetch(`/api/diagnostics${redact ? '?redactCommands=1' : ''}`);
      if (!r.ok) throw new Error(`Report failed (${r.status})`);
      const body = await r.text();
      const url = URL.createObjectURL(new Blob([body], { type: 'text/plain' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'deckbridge-diagnostics.txt';
      a.click();
      URL.revokeObjectURL(url);
      setStatus('Report downloaded.');
    });

  const saveAndReveal = (): Promise<void> =>
    run(async () => {
      const r = await fetch('/api/diagnostics/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redactCommands: redact }),
      });
      const parsed = (await r.json()) as { path?: string; error?: string };
      if (!r.ok) throw new Error(parsed.error ?? `Save failed (${r.status})`);
      setStatus(`Saved to ${parsed.path ?? 'the diagnostics folder'}.`);
    });

  const openLogs = (): Promise<void> =>
    run(async () => {
      await postJson('/api/logs/open-in-os');
      setStatus('Opened the logs folder.');
    });

  return (
    <Collapsible title={'Logging & diagnostics'} class="diag-section" bodyId="diagnostics-body">
      <p class="help-lead">
        Reporting a problem? Turn on debug logging, reproduce it, then create a report and attach it
        to your issue.{' '}
        <a href={TROUBLESHOOTING_URL} target="_blank" rel="noopener">
          Troubleshooting guide
        </a>
      </p>
      <div class="settings-actions">
        <button
          id="toggle-debug-logging"
          class="ghostbtn"
          type="button"
          disabled={busy || log === null}
          onClick={() => void toggleDebug()}
        >
          {debugOn ? 'Debug logging: on' : 'Debug logging: off'}
        </button>
        <button
          id="open-logs-folder"
          class="ghostbtn"
          type="button"
          disabled={busy}
          onClick={() => void openLogs()}
        >
          Open logs folder
        </button>
        <button
          id="create-diagnostics"
          class="ghostbtn"
          type="button"
          disabled={busy}
          onClick={() => void download()}
        >
          Create diagnostics report
        </button>
        <button
          id="save-diagnostics"
          class="ghostbtn"
          type="button"
          disabled={busy}
          onClick={() => void saveAndReveal()}
        >
          Save &amp; reveal
        </button>
      </div>
      <label class="settings-checkbox">
        <input
          id="redact-commands"
          type="checkbox"
          checked={redact}
          onChange={(e) => setRedact((e.target as HTMLInputElement).checked)}
        />
        <span>Hide my commands (omit extra-key commands and plugin arguments)</span>
      </label>
      <p class="fine small">{PRIVACY_NOTE}</p>
      {log && log.logFilePath !== '' && (
        <ul class="identity-list panel-inset">
          <li>
            <span class="identity-label">Log file</span>
            <code class="identity-value">{log.logFilePath}</code>
          </li>
          <li>
            <span class="identity-label">Log level</span>
            <code class="identity-value">{log.logLevel}</code>
          </li>
        </ul>
      )}
      {error && <p class="settings-error">{error}</p>}
      {status && !error && <p class="settings-status">{status}</p>}
    </Collapsible>
  );
}
