// Settings-page block for producing a bug report: the debug-logging toggle, the
// log-file location, and the two diagnostics-report actions.
//
// Kept out of overlays.tsx to stay under the 500-line check-loc gate.
import { useState } from 'preact/hooks';
import { Collapsible } from '../components/Collapsible.js';
import { CheckField } from '../components/Fields.js';
import { IdentityRow } from '../components/IdentityRow.js';
import { postJson } from '../ui-api.js';
import { Feedback, useAsyncAction } from '../ui-async.js';

/** Shown next to both report buttons and repeated as the report's own first line
 *  (diagnostics.ts REVIEW_NOTICE) — the file outlives this screen. */
const PRIVACY_NOTE = 'Contains settings, commands and paths. Review before sharing.';

const TROUBLESHOOTING_URL = 'https://deckbridge.dev/docs/troubleshooting';

/** `logLevel` null = the settings page hasn't read /api/state yet. It is read
 *  there, not here, so opening Settings costs one request instead of two. */
export function DiagnosticsPanel({
  logLevel,
  logFilePath,
}: Readonly<{ logLevel: string | null; logFilePath: string }>): preact.JSX.Element {
  const [toggledLevel, setToggledLevel] = useState<string | null>(null);
  const [redact, setRedact] = useState(false);
  const action = useAsyncAction();

  // Debug-on is the single instruction we can give a reporter, so the toggle is
  // binary: debug ⇄ info. Finer levels stay available via --log-level.
  const level = toggledLevel ?? logLevel;
  const debugOn = level === 'debug';

  const toggleDebug = (): Promise<void> =>
    action.run(async () => {
      const next = debugOn ? 'info' : 'debug';
      await postJson('/api/log-level', { level: next });
      setToggledLevel(next);
      return next === 'debug'
        ? 'Debug logging on — reproduce the problem, then create a report.'
        : 'Debug logging off.';
    });

  const download = (): Promise<void> =>
    action.run(async () => {
      const r = await fetch(`/api/diagnostics${redact ? '?redactCommands=1' : ''}`);
      if (!r.ok) throw new Error(`Report failed (${r.status})`);
      const body = await r.text();
      const url = URL.createObjectURL(new Blob([body], { type: 'text/plain' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'deckbridge-diagnostics.txt';
      a.click();
      URL.revokeObjectURL(url);
      return 'Report downloaded.';
    });

  const saveAndReveal = (): Promise<void> =>
    action.run(async () => {
      const parsed = await postJson<{ path?: string }>(
        '/api/diagnostics/save',
        { redactCommands: redact },
        'Save failed',
      );
      return `Saved to ${parsed.path ?? 'the diagnostics folder'}.`;
    });

  const openLogs = (): Promise<void> =>
    action.run(async () => {
      await postJson('/api/logs/open-in-os');
      return 'Opened the logs folder.';
    });

  return (
    <Collapsible title={'Logging & diagnostics'} class="diag-section" bodyId="diagnostics-body">
      <p class="help-lead">
        Enable debug logging. Reproduce problem. Create report.{' '}
        <a href={TROUBLESHOOTING_URL} target="_blank" rel="noopener">
          Troubleshooting
        </a>
      </p>
      <div class="settings-actions">
        <button
          id="toggle-debug-logging"
          class="ghostbtn"
          type="button"
          disabled={action.busy || logLevel === null}
          onClick={() => void toggleDebug()}
        >
          {debugOn ? 'Debug logging: on' : 'Debug logging: off'}
        </button>
        <button
          id="open-logs-folder"
          class="ghostbtn"
          type="button"
          disabled={action.busy}
          onClick={() => void openLogs()}
        >
          Open logs folder
        </button>
        <button
          id="create-diagnostics"
          class="ghostbtn"
          type="button"
          disabled={action.busy}
          onClick={() => void download()}
        >
          Create report
        </button>
        <button
          id="save-diagnostics"
          class="ghostbtn"
          type="button"
          disabled={action.busy}
          onClick={() => void saveAndReveal()}
        >
          Save &amp; reveal
        </button>
      </div>
      <CheckField
        id="redact-commands"
        label="Hide commands and plugin arguments"
        checked={redact}
        onChange={setRedact}
      />
      <p class="fine small">{PRIVACY_NOTE}</p>
      {logFilePath !== '' && (
        <ul class="identity-list panel-inset">
          <IdentityRow label="Log file">
            <code class="identity-value">{logFilePath}</code>
          </IdentityRow>
          <IdentityRow label="Log level">
            <code class="identity-value">{level}</code>
          </IdentityRow>
        </ul>
      )}
      <Feedback error={action.error} status={action.status} />
    </Collapsible>
  );
}
