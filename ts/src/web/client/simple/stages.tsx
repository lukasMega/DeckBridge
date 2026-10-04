// Stage renderers — one per device state (see deriveState in ui-helpers).
import { OwnershipDiagram } from '../components/OwnershipDiagram.js';
import { useStore } from '../lib/store.js';
import { useFetched } from '../lib/ui-api.js';
import { ICON, Icon } from '../components/Icon.js';
import type { DockUi } from '../ui-types.js';
import { Brightness } from './controls.js';
import { PairingFlow } from './pairing-flow.js';
import { ConnectionPath } from '../components/ConnectionPath.js';
import { KeyGridPreview } from '../components/KeyGridPreview.js';
import { ExtraKeysPanel } from './extra-keys-panel.js';
import { DockList, keyPressTitle } from './dock-cards.js';
import { pressKey, quitElgatoApp } from './handlers.js';
import {
  isMultiDockView,
  clientAppName,
  selectedCoraProfile,
  selectedTouchStripSize,
} from '../ui-helpers.js';

export function StageReady({
  docks,
  onHelp,
}: Readonly<{ docks?: DockUi[]; onHelp?: (id: string) => void }> = {}): preact.JSX.Element {
  const keyCount = useStore((s) => s.status.keyCount);
  const columns = useStore((s) => s.status.columns);
  const modelId = useStore((s) => s.status.modelId);
  const coraProfile = useStore((s) => selectedCoraProfile(s.status));
  const touchStrip = useStore((s) => selectedTouchStripSize(s.status));
  const selectedDock = useStore((s) => s.status.selectedDock);
  const appName = useStore((s) => clientAppName(s.status.clientApp));
  const modelName = useStore((s) => s.status.modelName);
  const keyPressEnabled = useStore((s) => s.keyPressEnabled);
  const paired = useStore((s) => s.status.elgatoConnected);

  if (docks !== undefined && isMultiDockView(docks) && onHelp !== undefined) {
    const sel = docks.find((d) => d.index === selectedDock) ?? docks[0]!;
    const many = docks.length > 1;
    return (
      <>
        <h1 class="stage-title">
          {many ? `All ${docks.length} decks connected` : 'Connected'}
          {appName}
        </h1>
        {!many && <ConnectionPath device="done" app="done" deviceName={sel.modelName} />}
        <DockList docks={docks} onHelp={onHelp} />
        {many && <p class="step-sub">Select a deck for its live preview and brightness.</p>}
        <Brightness dock={sel.index} level={sel.brightness} deviceName={sel.modelName} />
        <ExtraKeysPanel />
      </>
    );
  }

  return (
    <>
      <h1 class="stage-title">Connected{appName}</h1>
      <ConnectionPath device="done" app="done" deviceName={modelName} />
      <KeyGridPreview
        keyCount={keyCount}
        columns={columns}
        dimmed={false}
        modelId={modelId}
        coraProfile={coraProfile}
        touchStrip={touchStrip}
        onKeyClick={pressKey}
        gesture="dblclick"
        clickable={keyPressEnabled && paired}
        clickTitle={keyPressTitle(keyPressEnabled, paired)}
      />
      <Brightness />
      <ExtraKeysPanel />
    </>
  );
}

export function StageMultiPairing({
  docks,
  onHelp,
}: Readonly<{ docks: DockUi[]; onHelp: (id: string) => void }>): preact.JSX.Element {
  const left = docks.filter((d) => !d.elgatoConnected).length;

  return (
    <>
      <h1 class="stage-title">
        {docks.length} decks connected — {left} left to pair
      </h1>
      <DockList docks={docks} onHelp={onHelp} />
      <p class="step-sub">Each deck pairs as its own Network Dock. Select one to pair it.</p>
    </>
  );
}

export function StageDeviceNoElgato({
  onHelp,
}: Readonly<{ onHelp: (id: string) => void }>): preact.JSX.Element {
  const keyCount = useStore((s) => s.status.keyCount);
  const columns = useStore((s) => s.status.columns);
  const modelId = useStore((s) => s.status.modelId);
  const coraProfile = useStore((s) => selectedCoraProfile(s.status));
  const touchStrip = useStore((s) => selectedTouchStripSize(s.status));
  const modelName = useStore((s) => s.status.modelName);

  return (
    <>
      <h1 class="stage-title">Connect your control app</h1>
      <ConnectionPath device="done" app="active" deviceName={modelName} />
      <PairingFlow onHelp={onHelp} />
      <KeyGridPreview
        keyCount={keyCount}
        columns={columns}
        dimmed={true}
        modelId={modelId}
        coraProfile={coraProfile}
        touchStrip={touchStrip}
      />
    </>
  );
}

export function StageNoDevice({
  onHelp,
}: Readonly<{ onHelp: (id: string) => void }>): preact.JSX.Element {
  // Best-effort: a failed read leaves data null, so the warning stays hidden.
  const requirements = useFetched<Array<{ name: string; ok: boolean }>>('/api/requirements');
  const hidapi = requirements.data?.find((r) => r.name === 'libhidapi');
  const hidapiMissing = hidapi !== undefined && !hidapi.ok;

  return (
    <>
      <h1 class="stage-title">Connect your device</h1>
      <ConnectionPath device="active" app="pending" />
      <p class="step-sub">
        Plug it in via USB and quit the Elgato app.{' '}
        <button class="linkbtn accent" type="button" onClick={() => onHelp('plug-in')}>
          Help
        </button>
      </p>
      {hidapiMissing && (
        <div class="warnrow">
          <Icon class="w-ico" html={ICON.warn} />
          <span>
            <code>libhidapi</code> not found
          </span>
          <a class="linkbtn fix" href="/requirements" target="_blank" rel="noopener">
            How to fix
          </a>
        </div>
      )}
    </>
  );
}

export function StageConflict(): preact.JSX.Element {
  return (
    <div class="conflict">
      {/* eslint-disable-next-line @eslint-react/dom-no-dangerously-set-innerhtml -- static trusted SVG icon markup */}
      <div class="conflict-badge circle" dangerouslySetInnerHTML={{ __html: ICON.warn }} />
      <h1>Elgato app owns the USB device</h1>
      <OwnershipDiagram />
      <p class="conflict-body">Quit the Elgato app so DeckBridge can take over.</p>
      <button class="ctabtn" id="quitElgatoBtn" type="button" onClick={quitElgatoApp}>
        Quit Elgato app
      </button>
      <p class="conflict-after">
        Quits the app on this computer only. Then reconnect your deck if it is not detected.
      </p>
    </div>
  );
}
