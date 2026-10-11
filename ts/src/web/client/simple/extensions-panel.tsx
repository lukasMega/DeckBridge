// Settings block for extensions: what is installed, an on/off switch each, and Rescan
// (picks up a folder dropped in while DeckBridge runs). See docs/extensions.md.
import { Collapsible } from '../components/Collapsible.js';
import { DocsLink } from '../components/DocsLink.js';
import { ToggleRow } from '../components/Fields.js';
import { GhostButton } from '../components/GhostButton.js';
import { Feedback, useAsyncAction } from '../lib/ui-async.js';
import { postJson } from '../lib/ui-api.js';
import { patch, useStore } from '../lib/store.js';
import type { ExtensionInfo, ExtensionsView } from '../ui-types.js';

const STATE_TEXT: Record<ExtensionInfo['state'], string> = {
  disabled: '',
  loading: 'Starting…',
  running: '',
  error: 'Stopped: ',
  invalid: 'Cannot run: ',
  changed: 'Stopped: ',
};

function note(ext: ExtensionInfo): string {
  return STATE_TEXT[ext.state] + (ext.error ?? ext.description ?? '');
}

export function ExtensionsPanel(): preact.JSX.Element {
  const view = useStore((s) => s.extensions);
  const action = useAsyncAction();
  const running = view.extensions.filter((e) => e.state === 'running').length;

  const send = (url: string, body: unknown, done: (v: ExtensionsView) => string): Promise<void> =>
    action.run(async () => {
      const next = await postJson<ExtensionsView>(url, body, 'Request failed');
      patch({ extensions: next });
      return done(next);
    }, 'Request failed.');
  const toggle = (ext: ExtensionInfo, enabled: boolean): Promise<void> =>
    send('/api/extensions/enabled', { id: ext.id, enabled }, () =>
      enabled ? `${ext.name} is on.` : `${ext.name} is off.`,
    );
  const rescan = (): Promise<void> =>
    send('/api/extensions/rescan', undefined, (v) => `Found ${v.extensions.length}.`);

  return (
    <Collapsible
      title="Extensions"
      bodyId="extensions-body"
      status={`${running} of ${view.extensions.length} on`}
    >
      {view.safeMode && (
        <p class="multi-deck-note">Extensions are off for this session (--no-extensions).</p>
      )}
      {view.extensions.map((ext) => (
        <ToggleRow
          key={ext.id}
          id={`toggle-ext-${ext.id}`}
          label={`${ext.name} ${ext.version}`}
          checked={ext.enabled}
          disabled={action.busy || ext.state === 'invalid' || view.safeMode === true}
          onChange={(next) => void toggle(ext, next)}
        >
          <p class="multi-deck-note">{note(ext)}</p>
        </ToggleRow>
      ))}
      <p class="multi-deck-note">
        An extension runs with DeckBridge's full rights: turn on only ones you trust. Folder:{' '}
        <code>{view.dir}</code> <DocsLink topic="extensions" />
      </p>
      <div class="settings-actions">
        <GhostButton disabled={action.busy} onClick={() => void rescan()}>
          Rescan
        </GhostButton>
      </div>
      <Feedback error={action.error} status={action.status} />
    </Collapsible>
  );
}
