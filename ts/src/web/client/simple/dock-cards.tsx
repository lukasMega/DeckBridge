// Deck tabs switch the selected live preview; the server mirrors only that dock.
// Pairing help and controls belong to the selected deck panel.
import { useStore } from '../lib/store.js';
import type { DockUi } from '../ui-types.js';
import { ICON } from '../components/Icon.js';
import { fire } from '../lib/ui-api.js';
import { PairingFlow } from './pairing-flow.js';
import { KeyGridPreview, KeyGridSkeleton } from '../components/KeyGridPreview.js';
import { StatusChip } from '../components/StatusChip.js';
import { PairingAddressLink } from './pairing-address-modal.js';
import { pressKey } from './handlers.js';
import { Brightness } from './controls.js';
import { ExtraKeysPanel } from './extra-keys-panel.js';
import { rovingTabKey } from '../lib/roving-tabs.js';
import { GhostButton } from '../components/GhostButton.js';

function postSelectDock(index: number): void {
  fire('/api/select-dock', { index });
}

function DockChip({ dock }: Readonly<{ dock: DockUi }>): preact.JSX.Element {
  if (dock.elgatoConnected) {
    return (
      <StatusChip variant="ok" icon={ICON.check}>
        Paired
      </StatusChip>
    );
  }
  if (dock.primaryConnected) {
    return (
      <StatusChip variant="accent" spin>
        Elgato app connected
      </StatusChip>
    );
  }
  return (
    <StatusChip variant="wait" spin>
      Waiting for Elgato app
    </StatusChip>
  );
}

/** Tooltip on the selected dock's keys: '' = none (feature off, nothing to explain). */
export function keyPressTitle(enabled: boolean, paired: boolean): string {
  if (!enabled) return '';
  return paired ? 'Double-click to press this key' : 'Pair with the Elgato app to press keys';
}

function DockCard({
  dock,
  showAddressHelp = false,
  keyPressEnabled = false,
  onHelp,
}: Readonly<{
  dock: DockUi;
  /** Two or more docks: each needs its own IP in the Elgato app (see PairingAddressLink). */
  showAddressHelp?: boolean;
  /** Click-to-press opt-in (Settings): the selected card's keys fire on double-click. */
  keyPressEnabled?: boolean;
  onHelp: (id: string) => void;
}>): preact.JSX.Element {
  const pairing = !dock.elgatoConnected;
  const autoRestarting = useStore(
    (s) => s.status.elgatoAutoRestartPending?.docks.includes(dock.index) ?? false,
  );
  return (
    <div class="dock-card surface-card">
      <div class="dock-card-head">
        <span class="dock-card-name">{dock.modelName}</span>
        <DockChip dock={dock} />
      </div>
      {dock.virtualClients !== undefined && (
        <StatusChip variant="accent" id={`virtual-clients-${dock.index}`}>
          Browser deck · {dock.virtualClients} connected
        </StatusChip>
      )}
      <KeyGridPreview
        keyCount={dock.keyCount}
        columns={dock.columns}
        dimmed={!dock.elgatoConnected}
        modelId={dock.modelId}
        coraProfile={dock.coraProfile}
        touchStrip={dock.touchStripSize}
        onKeyClick={pressKey}
        gesture="dblclick"
        clickable={keyPressEnabled && dock.elgatoConnected}
        clickTitle={keyPressTitle(keyPressEnabled, dock.elgatoConnected)}
        footer={
          dock.elgatoConnected ? (
            <Brightness compact dock={dock.index} level={dock.brightness} />
          ) : undefined
        }
      />
      {pairing &&
        (dock.primaryConnected && !autoRestarting ? (
          // App already discovered this dock (primary CORA connected) but the
          // panel session hasn't (re)started. Adding it again wouldn't help —
          // guide the app-restart workaround for the stuck-after-restart case.
          <p class="dock-pairing-note">
            The Elgato app is connected and finishing pairing. If the keys stay blank, restart the
            Elgato app.
          </p>
        ) : (
          <>
            <PairingFlow dock={dock.index} port={String(dock.primaryPort)} onHelp={onHelp} />
            {showAddressHelp && !autoRestarting && <PairingAddressLink initialDock={dock.index} />}
          </>
        ))}
      {dock.elgatoConnected && <ExtraKeysPanel />}
    </div>
  );
}

export function DockList({
  docks,
  onHelp,
}: Readonly<{ docks: DockUi[]; onHelp: (id: string) => void }>): preact.JSX.Element {
  const selected = useStore((s) => s.status.selectedDock);
  const keyPressEnabled = useStore((s) => s.keyPressEnabled);
  const dock = docks.find((d) => d.index === selected) ?? docks[0];
  if (!dock) return <></>;
  const many = docks.length > 1;
  const selectTab = (event: KeyboardEvent, position: number): void => {
    const next = rovingTabKey(event, position, docks.length);
    if (next !== undefined && docks[next]!.index !== dock.index) postSelectDock(docks[next]!.index);
  };
  return (
    <div class="dock-list">
      {many && (
        <div class="dock-tabs" role="tablist" aria-label="Decks">
          {docks.map((item, position) => (
            <GhostButton
              class="dock-tab"
              key={item.index}
              role="tab"
              id={`dock-tab-${item.index}`}
              aria-selected={item.index === dock.index}
              aria-controls="dock-panel"
              tabIndex={item.index === dock.index ? 0 : -1}
              title={item.modelName}
              onClick={() => {
                if (item.index !== dock.index) postSelectDock(item.index);
              }}
              onKeyDown={(event) => selectTab(event, position)}
            >
              <span class="dock-tab-preview panel-inset" aria-hidden="true">
                <KeyGridSkeleton
                  keyCount={item.keyCount}
                  columns={item.columns}
                  modelId={item.modelId}
                />
                {item.touchStripSize && <span class="dock-tab-strip" />}
              </span>
              <span class="dock-card-name">
                {item.modelName}
                {!item.elgatoConnected && (
                  <>
                    <br />
                    <StatusChip variant="wait">Unpaired</StatusChip>
                  </>
                )}
              </span>
            </GhostButton>
          ))}
        </div>
      )}
      <div
        role={many ? 'tabpanel' : undefined}
        id="dock-panel"
        aria-labelledby={many ? `dock-tab-${dock.index}` : undefined}
        tabIndex={many ? 0 : undefined}
      >
        <DockCard
          key={dock.index}
          dock={dock}
          showAddressHelp={many}
          keyPressEnabled={keyPressEnabled}
          onHelp={onHelp}
        />
      </div>
    </div>
  );
}
