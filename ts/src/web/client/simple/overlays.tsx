// Full-stage overlays: the About popover, the Settings page, and the
// per-step help screen.
import { useEffect, useRef, useState } from 'preact/hooks';
import { ICON } from '../ui-icons.js';
import { HELP } from '../ui-help.js';
import { Icon } from './Icon.js';
import { Collapsible } from '../components/Collapsible.js';
import { DiagnosticsPanel } from './diagnostics-panel.js';
import { MultiDeckPanel } from './multi-deck-panel.js';
import { UpdatePanel } from './update-panel.js';
import { DeviceTuningPanel } from './device-tuning.js';
import { postJson, useFetched } from '../ui-api.js';
import { Feedback, useAsyncAction, type AsyncAction } from '../ui-async.js';
import { useDismiss } from '../ui-hooks.js';
import type { DeviceIdentity, RealDeviceIdentity, UpdateInfo } from '../ui-types.js';

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

function isSensitiveIdentityKey(key: ReadOnlyIdentityKey): boolean {
  return key === 'serialNumber' || key === 'childSerialNumber' || key === 'macAddress';
}

/** Blur is cosmetic (shoulder-surfing/screenshots) — the value stays in the DOM,
 *  so the hidden state says so rather than reading the value out. */
function SensitiveValue({ value }: Readonly<{ value: string }>): preact.JSX.Element {
  const [revealed, setRevealed] = useState(false);
  return (
    <button
      class={`identity-value identity-sensitive${revealed ? ' revealed' : ''}`}
      type="button"
      aria-pressed={revealed}
      aria-label={revealed ? value : 'Hidden — activate to show value'}
      title={revealed ? 'Hide sensitive value' : 'Show sensitive value'}
      onClick={() => setRevealed(!revealed)}
    >
      {value}
    </button>
  );
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
  const save = useAsyncAction();

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

  const handleSave = (): Promise<void> =>
    save.run(async () => {
      const saved = await postJson<{ name: string }>(
        '/api/device-identity/mdns-name',
        { deviceKey, name: trimmed },
        'Save failed',
      );
      onSaved(saved.name);
    }, 'Save failed.');

  return (
    <>
      <li class="identity-editable">
        <span class="identity-label">mDNS service name</span>
        <span class="identity-edit-row">
          <input
            class="input"
            type="text"
            value={value}
            disabled={save.busy}
            onInput={(e) => setValue((e.target as HTMLInputElement).value)}
          />
          <button
            class="ghostbtn"
            type="button"
            disabled={!dirty || save.busy}
            onClick={() => void handleSave()}
          >
            {save.busy ? 'Saving…' : 'Save'}
          </button>
        </span>
      </li>
      {save.error && (
        <li class="identity-error-row">
          <p class="settings-error">{save.error}</p>
        </li>
      )}
    </>
  );
}

export function AboutPopover({ onClose }: Readonly<{ onClose: () => void }>): preact.JSX.Element {
  useDismiss(onClose);

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
        <p class="fine app-version">DeckBridge v{__VERSION__}</p>
      </div>
    </div>
  );
}

interface SettingsState {
  deviceIdentity?: DeviceIdentity;
  realDeviceIdentity?: RealDeviceIdentity;
  logLevel?: string;
  logFilePath?: string;
  multiDeck?: boolean;
  updateInfo?: UpdateInfo;
}

/** null logLevel = state not read yet, which DiagnosticsPanel renders as unknown. */
function diagnosticsProps(state: SettingsState | null): {
  logLevel: string | null;
  logFilePath: string;
} {
  return {
    logLevel: state ? (state.logLevel ?? 'info') : null,
    logFilePath: state?.logFilePath ?? '',
  };
}

function updateInfoFor(state: SettingsState | null): UpdateInfo | null {
  return state?.updateInfo ?? null;
}

/** Identity reported by the physical USB device. Absent in mock mode. */
function RealIdentityList({
  realIdentity,
}: Readonly<{ realIdentity: RealDeviceIdentity | null }>): preact.JSX.Element {
  if (!realIdentity) return <p class="help-lead">No physical device connected.</p>;

  return (
    <ul class="identity-list panel-inset">
      <li>
        <span class="identity-label">Model</span>
        <code class="identity-value">{realIdentity.modelName}</code>
      </li>
      <li>
        <span class="identity-label">Serial number</span>
        {realIdentity.serialNumber ? (
          <SensitiveValue value={realIdentity.serialNumber} />
        ) : (
          <code class="identity-value">Unavailable</code>
        )}
      </li>
      <li>
        <span class="identity-label">Firmware version</span>
        <code class="identity-value">{realIdentity.firmwareVersion ?? 'Unavailable'}</code>
      </li>
    </ul>
  );
}

/** The settings.json file actions (export / import / open-in-OS), kept out of
 *  SettingsPage so that component stays within the complexity ceiling. */
function useSettingsFileActions(
  action: AsyncAction,
  reloadSettings: () => Promise<void>,
): {
  fileInputRef: { current: HTMLInputElement | null };
  handleExport: () => Promise<void>;
  handleImportClick: () => void;
  handleOpenInOS: () => Promise<void>;
  handleFileChange: (e: Event) => Promise<void>;
} {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleExport = (): Promise<void> =>
    action.run(async () => {
      const r = await fetch('/api/settings');
      if (!r.ok) throw new Error(`Export failed (${r.status})`);
      const text = await r.text();
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'deckbridge-settings.json';
      a.click();
      URL.revokeObjectURL(url);
      return 'Settings exported.';
    }, 'Export failed.');

  const handleImportClick = (): void => {
    fileInputRef.current?.click();
  };

  const handleOpenInOS = (): Promise<void> =>
    action.run(async () => {
      await postJson('/api/settings/open-in-os', undefined, 'Open failed');
      return 'Opened settings.json.';
    }, 'Open failed.');

  const handleFileChange = async (e: Event): Promise<void> => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    await action.run(async () => {
      await postJson('/api/settings', await file.text(), 'Import failed');
      await reloadSettings();
      return 'Settings imported.';
    }, 'Import failed.');
  };

  return { fileInputRef, handleExport, handleImportClick, handleOpenInOS, handleFileChange };
}

export function SettingsPage({ onBack }: Readonly<{ onBack: () => void }>): preact.JSX.Element {
  const action = useAsyncAction();
  // Both reads are per-mount, so the preview and the identifiers are fresh every
  // time this page is opened. DiagnosticsPanel is fed from this one /api/state
  // read rather than making its own.
  const settings = useFetched<unknown>('/api/settings');
  const state = useFetched<SettingsState>('/api/state');
  const [renamed, setRenamed] = useState<string | null>(null);

  useDismiss(onBack);

  const { fileInputRef, handleExport, handleImportClick, handleOpenInOS, handleFileChange } =
    useSettingsFileActions(action, settings.reload);

  const settingsText = settings.data === null ? null : JSON.stringify(settings.data, null, 2);
  const fetchedIdentity = state.data?.deviceIdentity ?? null;
  // A rename is applied locally so the row reflects it without re-reading state.
  const identity =
    fetchedIdentity && renamed !== null
      ? { ...fetchedIdentity, mdnsServiceName: renamed }
      : fetchedIdentity;
  const realIdentity = state.data?.realDeviceIdentity ?? null;

  return (
    <div class="help">
      <h1>Settings</h1>
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
      <Feedback error={action.error} status={action.status} />

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
              setRenamed(name);
              void settings.reload();
            }}
          />
          {IDENTITY_FIELDS.map(({ key, label }) => (
            <li key={key}>
              <span class="identity-label">{label}</span>
              {isSensitiveIdentityKey(key) ? (
                <SensitiveValue value={formatIdentityValue(key, identity[key])} />
              ) : (
                <code class="identity-value">{formatIdentityValue(key, identity[key])}</code>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p class="help-lead">Loading…</p>
      )}

      <p class="help-section-label">Real device identity</p>
      <RealIdentityList realIdentity={realIdentity} />

      <MultiDeckPanel enabled={state.data ? (state.data.multiDeck ?? false) : null} />
      <UpdatePanel info={updateInfoFor(state.data)} />
      <DiagnosticsPanel {...diagnosticsProps(state.data)} />
      <DeviceTuningPanel />

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
