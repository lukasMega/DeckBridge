/**
 * SettingsPanel — collapsible raw-JSON settings editor (v1).
 *
 * Loads the current persisted settings (selectedDock + per-device brightness/
 * brightnessOverride/imageModeOverride under devices[]) from GET /api/settings
 * into a textarea; Save POSTs the edited JSON back. See
 * .claude/plans/2026-07-15_per-device-settings.md.
 */
import { useState } from 'preact/hooks';
import { Collapsible } from './components/Collapsible.js';

async function loadSettingsText(): Promise<string> {
  const r = await fetch('/api/settings');
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const data = await r.json();
  return JSON.stringify(data, null, 2);
}

export function SettingsPanel(): preact.JSX.Element {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  function handleToggle(open: boolean): void {
    if (open) {
      setError(null);
      setStatus(null);
      void loadSettingsText().then(setText);
    }
  }

  async function handleSave(): Promise<void> {
    try {
      JSON.parse(text);
    } catch {
      setError('Invalid JSON — fix syntax before saving.');
      return;
    }
    setError(null);
    const r = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: text,
    });
    if (!r.ok) {
      const body = (await r.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? `Save failed (${r.status})`);
      return;
    }
    setText(await loadSettingsText());
    setStatus('Saved.');
  }

  return (
    <Collapsible
      class="panel"
      id="settings-panel"
      bodyId="settings-body"
      title="Settings (raw JSON)"
      onToggle={handleToggle}
    >
      <textarea
        id="settings-textarea"
        class="input"
        rows={10}
        value={text}
        onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
      />
      {error && <div class="settings-error">{error}</div>}
      {status && !error && <div class="settings-status">{status}</div>}
      <button id="settings-save" class="ghostbtn" type="button" onClick={() => void handleSave()}>
        Save
      </button>
    </Collapsible>
  );
}
