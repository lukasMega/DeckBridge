// Full-stage overlays: the About popover, the Settings page, and the
// per-step help screen.
import { useEffect, useRef, useState } from 'preact/hooks';
import { ICON } from '../ui-icons.js';
import { HELP } from '../ui-help.js';
import { Icon } from './Icon.js';
import { BackButton } from './controls.js';
import { Collapsible } from '../components/Collapsible.js';
import type { DeviceIdentity } from '../ui-types.js';

/** Run `onEscape` when the Escape key is pressed. */
function useEscape(onEscape: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onEscape();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onEscape]);
}

/** Labels for the identifiers DeckBridge actually sends to the Elgato app,
 *  in the order they're most useful for troubleshooting/pairing. mDNS service
 *  name is rendered separately (MdnsNameEditor) since it's editable for a
 *  real dock with a persisted identity — see deviceKey on DeviceIdentity. */
type ReadOnlyIdentityKey = keyof Omit<DeviceIdentity, 'deviceKey' | 'mdnsServiceName'>;

const IDENTITY_FIELDS: ReadonlyArray<{ key: ReadOnlyIdentityKey; label: string }> = [
  { key: 'serialNumber', label: 'Dock serial number' },
  { key: 'childSerialNumber', label: 'Panel serial number' },
  { key: 'productId', label: 'Product ID' },
  { key: 'macAddress', label: 'MAC address' },
  { key: 'dockFirmwareVersion', label: 'Dock firmware version' },
  { key: 'childFirmwareVersion', label: 'Panel firmware version' },
];

function formatIdentityValue(key: ReadOnlyIdentityKey, value: string | number): string {
  return key === 'productId' ? `0x${Number(value).toString(16).padStart(4, '0')}` : String(value);
}

/** mDNS service name row: editable when the identity has a `deviceKey` (a
 *  real dock with a persisted per-device identity — see device-identity.ts);
 *  otherwise (mock mode) rendered read-only like the other identity fields. */
function MdnsNameEditor({
  identity,
  onSaved,
}: Readonly<{
  identity: DeviceIdentity;
  onSaved: (name: string) => void;
}>): preact.JSX.Element {
  const [value, setValue] = useState(identity.mdnsServiceName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!identity.deviceKey) {
    return (
      <li>
        <span class="identity-label">mDNS service name</span>
        <code class="identity-value">{identity.mdnsServiceName}</code>
      </li>
    );
  }

  const deviceKey = identity.deviceKey;
  const trimmed = value.trim();
  const dirty = trimmed !== '' && trimmed !== identity.mdnsServiceName;

  async function handleSave(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      const r = await fetch('/api/device-identity/mdns-name', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceKey, name: trimmed }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Save failed (${r.status})`);
      }
      const saved = (await r.json()) as { name: string };
      onSaved(saved.name);
    } catch (e) {
      setError((e as Error).message || 'Save failed.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <li class="identity-editable">
        <span class="identity-label">mDNS service name</span>
        <span class="identity-edit-row">
          <input
            class="input"
            type="text"
            value={value}
            disabled={saving}
            onInput={(e) => setValue((e.target as HTMLInputElement).value)}
          />
          <button
            class="ghostbtn"
            type="button"
            disabled={!dirty || saving}
            onClick={() => void handleSave()}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </span>
      </li>
      {error && (
        <li class="identity-error-row">
          <p class="settings-error">{error}</p>
        </li>
      )}
    </>
  );
}

export function AboutPopover({ onClose }: Readonly<{ onClose: () => void }>): preact.JSX.Element {
  useEscape(onClose);

  const handleScrimClick = (e: MouseEvent): void => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <div class="scrim" onClick={handleScrimClick}>
      <div class="popover">
        <button
          class="pop-close circle"
          aria-label="Close"
          type="button"
          onClick={onClose}
          // eslint-disable-next-line @eslint-react/dom-no-dangerously-set-innerhtml -- static trusted SVG icon markup
          dangerouslySetInnerHTML={{ __html: ICON.close }}
        />
        <h2>What is DeckBridge?</h2>
        <p>
          <strong>DeckBridge</strong> lets you use a USB Stream Deck with the Elgato Stream Deck app
          over your local network. It runs on your computer and appears to the app as a network
          device, so your keys and button images work over WiFi.
        </p>
        <p>It&apos;s a free, community-built tool for personal and hobby use.</p>
        <p class="fine">
          DeckBridge is not affiliated with, endorsed by, or supported by Elgato / Corsair.
          &ldquo;Stream Deck&rdquo; and &ldquo;Elgato&rdquo; are trademarks of their respective
          owners. DeckBridge is intended for hobby and personal use only —{' '}
          <strong>not for professional use</strong> — and it{' '}
          <strong>does not replace the Elgato Network Dock</strong>. For professional or reliable
          setups, use officially supported Elgato hardware.
        </p>
      </div>
    </div>
  );
}

export function SettingsPage({ onBack }: Readonly<{ onBack: () => void }>): preact.JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [settingsText, setSettingsText] = useState<string | null>(null);
  const [identity, setIdentity] = useState<DeviceIdentity | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Load the settings preview + the identifiers currently sent to the
  // Elgato app once, on mount — fresh every time this page is opened.
  useEffect(() => {
    const ctrl = new AbortController();
    void fetch('/api/settings', { signal: ctrl.signal })
      .then((r) => r.json())
      .then((data) => setSettingsText(JSON.stringify(data, null, 2)))
      .catch(() => setSettingsText(null));
    void fetch('/api/state', { signal: ctrl.signal })
      .then((r) => r.json() as Promise<{ deviceIdentity?: DeviceIdentity }>)
      .then((st) => setIdentity(st.deviceIdentity ?? null))
      .catch(() => setIdentity(null));
    return () => ctrl.abort();
  }, []);

  useEscape(onBack);

  async function refreshSettingsText(): Promise<void> {
    try {
      const r = await fetch('/api/settings');
      setSettingsText(JSON.stringify(await r.json(), null, 2));
    } catch {
      // Preview is best-effort; leave the last-known text in place.
    }
  }

  async function handleExport(): Promise<void> {
    setError(null);
    try {
      const r = await fetch('/api/settings');
      if (!r.ok) throw new Error(`Export failed (${r.status})`);
      const text = await r.text();
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'deckbridge-settings.json';
      a.click();
      URL.revokeObjectURL(url);
      setStatus('Settings exported.');
    } catch (e) {
      setStatus(null);
      setError((e as Error).message || 'Export failed.');
    }
  }

  function handleImportClick(): void {
    fileInputRef.current?.click();
  }

  async function handleOpenInOS(): Promise<void> {
    setError(null);
    setStatus(null);
    try {
      const r = await fetch('/api/settings/open-in-os', { method: 'POST' });
      if (!r.ok) throw new Error(`Open failed (${r.status})`);
      setStatus('Opened settings.json.');
    } catch (e) {
      setError((e as Error).message || 'Open failed.');
    }
  }

  async function handleFileChange(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    setError(null);
    setStatus(null);
    try {
      const text = await file.text();
      const r = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: text,
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Import failed (${r.status})`);
      }
      setStatus('Settings imported.');
      await refreshSettingsText();
    } catch (err) {
      setError((err as Error).message || 'Import failed.');
    }
  }

  return (
    <div class="help">
      <BackButton onClick={onBack} />
      <h1>Settings</h1>
      <p class="help-lead">
        Save your DeckBridge settings to a file, or load a previously saved file.
      </p>
      <div class="settings-actions">
        <button class="ghostbtn" type="button" onClick={() => void handleExport()}>
          Export settings
        </button>
        <button class="ghostbtn" type="button" onClick={handleImportClick}>
          Import settings
        </button>
        <button class="ghostbtn" type="button" onClick={() => void handleOpenInOS()}>
          Open settings.json
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json"
          class="settings-file-input"
          onChange={(e) => void handleFileChange(e)}
        />
      </div>
      {error && <p class="settings-error">{error}</p>}
      {status && !error && <p class="settings-status">{status}</p>}

      <p class="help-section-label">Device identity sent to the Elgato app</p>
      {identity ? (
        <ul class="identity-list panel-inset">
          <MdnsNameEditor
            // Remount (resetting the local edit buffer) when the underlying
            // device changes — not on every rename, which would clobber
            // in-progress typing. See MdnsNameEditor: local state is seeded
            // from props once, on mount, by design.
            key={identity.deviceKey ?? 'mock'}
            identity={identity}
            onSaved={(name) => {
              setIdentity({ ...identity, mdnsServiceName: name });
              void refreshSettingsText();
            }}
          />
          {IDENTITY_FIELDS.map(({ key, label }) => (
            <li key={key}>
              <span class="identity-label">{label}</span>
              <code class="identity-value">{formatIdentityValue(key, identity[key])}</code>
            </li>
          ))}
        </ul>
      ) : (
        <p class="help-lead">Loading…</p>
      )}

      <Collapsible title="Saved settings (JSON)">
        <pre class="settings-json-preview panel-inset">{settingsText ?? 'Loading…'}</pre>
      </Collapsible>
    </div>
  );
}

export function HelpScreen({
  topicId,
  onBack,
}: Readonly<{ topicId: string; onBack: () => void }>): preact.JSX.Element {
  const topic = HELP[topicId];
  // Hook must run unconditionally (before any early return). Unknown topic: fall back.
  useEffect(() => {
    if (!topic) onBack();
  }, [topic, onBack]);
  if (!topic) {
    return <></>;
  }

  let n = 0;
  return (
    <div class="help">
      <BackButton onClick={onBack} />
      {/* eslint-disable-next-line @eslint-react/dom-no-dangerously-set-innerhtml -- static trusted SVG from HELP data */}
      <div class="help-stage panel-inset" dangerouslySetInnerHTML={{ __html: topic.svg() }} />
      <h1>{topic.title}</h1>
      <p class="help-lead">{topic.lead}</p>
      <p class="help-section-label">What happens — and what you do</p>
      <ol class="help-steps">
        {topic.steps.map((s, i) => {
          if (s.you) n++;
          const numClass = 'num' + (s.you ? ' you' : '');
          const numContent = s.you ? String(n) : ICON.check;
          return (
            // eslint-disable-next-line @eslint-react/no-array-index-key -- steps are positional with no stable id
            <li key={i}>
              <Icon class={numClass} html={numContent} />
              <Icon html={s.html} />
            </li>
          );
        })}
      </ol>
      {topic.docs && (
        <a
          class="manual-add-docs"
          href={topic.docs.href}
          target="_blank"
          rel="noopener"
          style="margin-top:16px"
        >
          <Icon html={ICON.book} />
          <span>{topic.docs.label}</span>
        </a>
      )}
    </div>
  );
}
