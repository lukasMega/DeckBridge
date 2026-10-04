// Multi-dock cards: one per connected Stream Deck (see DockUi in ui-types.ts).
// The SELECTED dock (click a card) gets the live KeyGridPreview — the server
// mirrors only the selected dock's images; every other card renders a static
// dimmed grid. Pairing help shows once, on the selected card that still needs it.
import { useStore } from '../lib/store.js';
import type { DockUi } from '../ui-types.js';
import { ICON } from '../components/Icon.js';
import { fire } from '../lib/ui-api.js';
import { PairingFlow } from './pairing-flow.js';
import { KeyGridPreview } from '../components/KeyGridPreview.js';
import { StatusChip } from '../components/StatusChip.js';
import { PairingAddressLink } from './pairing-address-modal.js';
import { pressKey } from './handlers.js';

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

export function DockCard({
  dock,
  selected,
  showAddressHelp = false,
  keyPressEnabled = false,
  onHelp,
}: Readonly<{
  dock: DockUi;
  selected: boolean;
  /** Two or more docks: each needs its own IP in the Elgato app (see PairingAddressLink). */
  showAddressHelp?: boolean;
  /** Click-to-press opt-in (Settings): the selected card's keys fire on double-click. */
  keyPressEnabled?: boolean;
  onHelp: (id: string) => void;
}>): preact.JSX.Element {
  const select = (): void => {
    if (!selected) postSelectDock(dock.index);
  };
  // Pointer convenience only: the name button is the keyboard/AT way to select, and
  // controls inside the card (copy chips, links) must keep their own clicks.
  const selectFromCard = (e: MouseEvent): void => {
    if (!(e.target as Element).closest('button, a, summary, input')) select();
  };
  const pairing = selected && !dock.elgatoConnected;
  return (
    <div
      class={selected ? 'dock-card surface-card dock-card--selected' : 'dock-card surface-card'}
      onClick={selectFromCard}
    >
      <div class="dock-card-head">
        <button class="dock-card-name" type="button" aria-pressed={selected} onClick={select}>
          {dock.modelName}
        </button>
        <DockChip dock={dock} />
      </div>
      {dock.virtualClients !== undefined && (
        <StatusChip variant="accent" id={`virtual-clients-${dock.index}`}>
          Browser deck · {dock.virtualClients} connected
        </StatusChip>
      )}
      {/* Distinct keys force a remount when this card is (de)selected: both
          branches are the same component, and KeyGridPreview builds its
          KeyPreview in a mount-only effect that a prop flip would not re-run. */}
      {selected ? (
        <KeyGridPreview
          key="live"
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
        />
      ) : (
        <KeyGridPreview
          key="static"
          keyCount={dock.keyCount}
          columns={dock.columns}
          dimmed
          live={false}
          label="Preview"
          badge="Click to view"
        />
      )}
      {pairing &&
        (dock.primaryConnected ? (
          // App already discovered this dock (primary CORA connected) but the
          // panel session hasn't (re)started. Adding it again wouldn't help —
          // guide the app-restart workaround for the stuck-after-restart case.
          <p class="dock-pairing-note">
            The Elgato app is connected and finishing pairing. If the keys stay blank, restart the
            Elgato app.
          </p>
        ) : (
          <>
            <PairingFlow port={String(dock.primaryPort)} onHelp={onHelp} />
            {showAddressHelp && <PairingAddressLink initialDock={dock.index} />}
          </>
        ))}
    </div>
  );
}

export function DockList({
  docks,
  onHelp,
}: Readonly<{ docks: DockUi[]; onHelp: (id: string) => void }>): preact.JSX.Element {
  const selected = useStore((s) => s.status.selectedDock);
  const keyPressEnabled = useStore((s) => s.keyPressEnabled);
  return (
    <div class="dock-list">
      {docks.map((dock) => (
        <DockCard
          key={dock.index}
          dock={dock}
          selected={dock.index === selected}
          showAddressHelp={docks.length >= 2}
          keyPressEnabled={keyPressEnabled}
          onHelp={onHelp}
        />
      ))}
    </div>
  );
}
