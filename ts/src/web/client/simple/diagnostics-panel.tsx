// Settings-page block for producing a bug report: the debug-logging toggle, the
// log-file location, and the two diagnostics-report actions.
import { DocsLink } from '../components/DocsLink.js';
import { useState } from 'preact/hooks';
import { Collapsible } from '../components/Collapsible.js';
import { CheckField } from '../components/Fields.js';
import { GhostButton } from '../components/GhostButton.js';
import { IdentityRow } from '../components/IdentityRow.js';
import { download, postJson } from '../lib/ui-api.js';
import { Feedback, useAsyncAction } from '../lib/ui-async.js';

/** Shown next to both report buttons and repeated as the report's own first line
 *  (diagnostics.ts REVIEW_NOTICE) — the file outlives this screen. */
const PRIVACY_NOTE = 'Contains settings, commands and paths. Review before sharing.';

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
  const debugStatus = `Debug ${debugOn ? 'enabled' : 'disabled'}`;

  const toggleDebug = (): Promise<void> =>
    action.run(async () => {
      const next = debugOn ? 'info' : 'debug';
      await postJson('/api/log-level', { level: next });
      setToggledLevel(next);
      return next === 'debug'
        ? 'Debug logging on — reproduce the problem, then create a report.'
        : 'Debug logging off.';
    });

  const createReport = (): Promise<void> =>
    action.run(async () => {
      const query = redact ? '?redactCommands=1' : '';
      await download(
        `/api/diagnostics${query}`,
        'deckbridge-diagnostics.txt',
        'text/plain',
        'Report failed',
      );
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
    <Collapsible
      title={'Logging & diagnostics'}
      class="diag-section"
      bodyId="diagnostics-body"
      status={level === null ? 'Loading…' : debugStatus}
    >
      <p class="help-lead">
        Enable debug logging. Reproduce problem. Create report.{' '}
        <DocsLink topic="troubleshooting" label="Troubleshooting" />
      </p>
      <div class="settings-actions">
        <GhostButton
          id="toggle-debug-logging"
          disabled={action.busy || logLevel === null}
          onClick={toggleDebug}
        >
          {debugOn ? 'Debug logging: on' : 'Debug logging: off'}
        </GhostButton>
        <GhostButton id="open-logs-folder" disabled={action.busy} onClick={openLogs}>
          Open logs folder
        </GhostButton>
        <GhostButton id="create-diagnostics" disabled={action.busy} onClick={createReport}>
          Create report
        </GhostButton>
        <GhostButton id="save-diagnostics" disabled={action.busy} onClick={saveAndReveal}>
          Save &amp; reveal
        </GhostButton>
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
          <IdentityRow label="Log file" value={logFilePath} />
          <IdentityRow label="Log level" value={level} />
        </ul>
      )}
      <Feedback error={action.error} status={action.status} />
    </Collapsible>
  );
}
