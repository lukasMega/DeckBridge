// Full-stage overlays: the About popover, the Settings page, and the
// per-step help screen.
import { DocsLink } from '../components/DocsLink.js';
import { useEffect, useRef, useState } from 'preact/hooks';
import { ICON, Icon } from '../components/Icon.js';
import { Modal } from '../components/Modal.js';
import { HELP } from '../ui-help.js';
import { Collapsible } from '../components/Collapsible.js';
import { IdentityRow } from '../components/IdentityRow.js';
import { TextInput } from '../components/Fields.js';
import { DiagnosticsPanel } from './diagnostics-panel.js';
import { PushApiPanel } from './push-api-panel.js';
import { MultiDeckPanel } from './multi-deck-panel.js';
import { VirtualDeckPanel } from './virtual-deck-panel.js';
import { KeyPressPanel } from './key-press-panel.js';
import { UpdatePanel } from './update-panel.js';
import { ElgatoAppPanel } from './elgato-app-panel.js';
import { DeviceTuningPanel } from './device-tuning.js';
import { StandbyPanel } from './standby-panel.js';
import { SettingsGroup, SettingsSearch } from './settings-search.js';
import { GhostButton } from '../components/GhostButton.js';
import { download, postJson, useFetched } from '../lib/ui-api.js';
import { Feedback, useAsyncAction, type AsyncAction } from '../lib/ui-async.js';
import { useDismiss } from '../lib/ui-hooks.js';
import type {
  DeviceIdentity,
  ElgatoAutoRestartState,
  RealDeviceIdentity,
  StateResponse,
  UpdateInfo,
} from '../ui-types.js';

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
    return <IdentityRow label="mDNS service name" value={identity.mdnsServiceName} />;
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
      <IdentityRow class="identity-editable" label="mDNS service name">
        <span class="identity-edit-row">
          <TextInput value={value} disabled={save.busy} onChange={setValue} />
          <GhostButton disabled={!dirty || save.busy} onClick={handleSave}>
            {save.busy ? 'Saving…' : 'Save'}
          </GhostButton>
        </span>
      </IdentityRow>
      {save.error && (
        <li class="identity-error-row">
          <p class="settings-error">{save.error}</p>
        </li>
      )}
    </>
  );
}

export function AboutPopover({ onClose }: Readonly<{ onClose: () => void }>): preact.JSX.Element {
  return (
    <Modal title="What is DeckBridge?" titleId="about-title" onClose={onClose}>
      <p class="about-intro">
        Use a USB Stream Deck with the Elgato Stream Deck app over your local network. DeckBridge
        runs on your computer and appears as a network device.
      </p>
      <p class="about-usage">Free, community-built software for personal and hobby use.</p>
      <DocsLink topic="home" block label="Documentation" />
      <div class="about-notice">
        <h3>Independent project</h3>
        <p>
          DeckBridge is not affiliated with, endorsed by, or supported by Elgato or Corsair.
          &ldquo;Stream Deck&rdquo; and &ldquo;Elgato&rdquo; are trademarks of their respective
          owners.
        </p>
        <p>
          For personal and hobby use only. Not for professional use. Does not replace the Elgato
          Network Dock. For reliable setups, use officially supported Elgato hardware.
        </p>
      </div>
      <p class="about-version">DeckBridge v{__VERSION__}</p>
    </Modal>
  );
}

/** The slice of GET /api/state the Settings page reads once per mount. */
type SettingsState = Pick<
  StateResponse,
  | 'deviceIdentity'
  | 'realDeviceIdentity'
  | 'logLevel'
  | 'logFilePath'
  | 'multiDeck'
  | 'keyPressEnabled'
  | 'updateInfo'
  | 'elgatoAutoRestart'
>;

/** null logLevel = state not read yet, which DiagnosticsPanel renders as unknown. */
function diagnosticsProps(state: SettingsState | null): {
  logLevel: string | null;
  logFilePath: string;
} {
  return {
    logLevel: state ? state.logLevel : null,
    logFilePath: state?.logFilePath ?? '',
  };
}

function updateInfoFor(state: SettingsState | null): UpdateInfo | null {
  return state?.updateInfo ?? null;
}

function elgatoAutoRestartFor(state: SettingsState | null): ElgatoAutoRestartState | null {
  return state?.elgatoAutoRestart ?? null;
}

/** Identity reported by the physical USB device. Absent in mock mode. */
function RealIdentityList({
  realIdentity,
}: Readonly<{ realIdentity: RealDeviceIdentity | null }>): preact.JSX.Element {
  if (!realIdentity) return <p class="help-lead">No physical device connected.</p>;

  return (
    <ul class="identity-list panel-inset">
      <IdentityRow label="Model" value={realIdentity.modelName} />
      <IdentityRow label="Serial number" value={realIdentity.serialNumber} sensitive />
      <IdentityRow label="Firmware version" value={realIdentity.firmwareVersion} />
    </ul>
  );
}

/** Export / import of settings.json; reports through the page-level action. */
function SettingsFileActions({
  action,
  reloadSettings,
}: Readonly<{ action: AsyncAction; reloadSettings: () => Promise<void> }>): preact.JSX.Element {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleExport = (): Promise<void> =>
    action.run(async () => {
      await download(
        '/api/settings',
        'deckbridge-settings.json',
        'application/json',
        'Export failed',
      );
      return 'Settings exported.';
    }, 'Export failed.');

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

  return (
    <div class="settings-actions">
      <GhostButton onClick={handleExport}>Export settings</GhostButton>
      <GhostButton onClick={() => fileInputRef.current?.click()}>Import settings</GhostButton>
      <input
        ref={fileInputRef}
        type="file"
        accept="application/json"
        class="settings-file-input"
        onChange={(e) => void handleFileChange(e)}
      />
    </div>
  );
}

/** Identity fields sent to the Elgato app; collapsed because they only matter when troubleshooting. */
function ConnectionDetails({
  identity,
  realIdentity,
  onRenamed,
}: Readonly<{
  identity: DeviceIdentity | null;
  realIdentity: RealDeviceIdentity | null;
  onRenamed: (name: string) => void;
}>): preact.JSX.Element {
  return (
    <Collapsible title="Connection details" status="Sent to the Elgato app">
      <p class="help-section-label">Device identity sent to the Elgato app</p>
      {identity ? (
        <ul class="identity-list panel-inset">
          <MdnsNameEditor
            // Remount (resetting the local edit buffer) when the underlying
            // device changes — not on every rename, which would clobber
            // in-progress typing. See MdnsNameEditor: local state is seeded
            // from props once, on mount, by design.
            key={identity.deviceKey ?? 'identity'}
            identity={identity}
            onSaved={onRenamed}
          />
          {IDENTITY_FIELDS.map(({ key, label }) => (
            <IdentityRow
              key={key}
              label={label}
              value={formatIdentityValue(key, identity[key])}
              sensitive={isSensitiveIdentityKey(key)}
            />
          ))}
        </ul>
      ) : (
        <p class="help-lead">Loading…</p>
      )}

      <p class="help-section-label">Real device identity</p>
      <RealIdentityList realIdentity={realIdentity} />
    </Collapsible>
  );
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

  const handleOpenInOS = (): Promise<void> =>
    action.run(async () => {
      await postJson('/api/settings/open-in-os', undefined, 'Open failed');
      return 'Opened settings.json.';
    }, 'Open failed.');

  const settingsText = settings.data === null ? null : JSON.stringify(settings.data, null, 2);
  const fetchedIdentity = state.data?.deviceIdentity ?? null;
  // A rename is applied locally so the row reflects it without re-reading state.
  const identity =
    fetchedIdentity && renamed !== null
      ? { ...fetchedIdentity, mdnsServiceName: renamed }
      : fetchedIdentity;
  const realIdentity = state.data?.realDeviceIdentity ?? null;

  const deviceName = realIdentity?.modelName;

  return (
    <div class="help settings-page">
      <SettingsSearch>
        <SettingsGroup title="Devices">
          <MultiDeckPanel enabled={state.data ? state.data.multiDeck : null} />
          <KeyPressPanel enabled={state.data ? state.data.keyPressEnabled : null} />
          <VirtualDeckPanel />
        </SettingsGroup>

        <SettingsGroup
          title={deviceName === undefined ? 'Selected device' : `Selected device — ${deviceName}`}
        >
          <StandbyPanel />
          <DeviceTuningPanel />
        </SettingsGroup>

        <SettingsGroup title="App connection">
          <ElgatoAppPanel state={elgatoAutoRestartFor(state.data)} />
        </SettingsGroup>

        <SettingsGroup title="Maintenance">
          <UpdatePanel info={updateInfoFor(state.data)} />
          <DiagnosticsPanel {...diagnosticsProps(state.data)} />
          <SettingsFileActions action={action} reloadSettings={settings.reload} />
        </SettingsGroup>
        <Feedback error={action.error} status={action.status} />

        <SettingsGroup title="Integrations">
          <PushApiPanel />
        </SettingsGroup>

        <SettingsGroup title="Advanced details">
          <ConnectionDetails
            identity={identity}
            realIdentity={realIdentity}
            onRenamed={(name) => {
              setRenamed(name);
              void settings.reload();
            }}
          />

          <Collapsible
            title="Saved settings (JSON)"
            status={settingsText === null ? 'Loading…' : 'Loaded'}
          >
            <pre class="settings-json-preview panel-inset">{settingsText ?? 'Loading…'}</pre>
            <div class="settings-actions">
              <GhostButton onClick={handleOpenInOS}>Open settings.json</GhostButton>
            </div>
          </Collapsible>
        </SettingsGroup>
      </SettingsSearch>
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
        <div style="margin-top:5px">
          {topic.docs.map((d) => (
            <div key={'topic' in d ? d.topic : d.href}>
              {'topic' in d ? (
                <DocsLink topic={d.topic} block label={d.label} />
              ) : (
                <a class="manual-add-docs" href={d.href} target="_blank" rel="noopener">
                  <Icon html={ICON.book} />
                  <span>{d.label}</span>
                </a>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
