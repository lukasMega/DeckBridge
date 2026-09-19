// Multi-dock cards: one per connected Stream Deck (see DockUi in ui-types.ts).
// The SELECTED dock (click a card) gets the live KeyGridPreview — the server
// mirrors only the selected dock's images; every other card renders a static
// dimmed grid.
import { useStore } from '../store.js';
import type { DockUi } from '../ui-types.js';
import { ICON } from '../ui-icons.js';
import { fire } from '../ui-api.js';
import { ManualAddPanel, RestartNote } from './controls.js';
import { KeyGridPreview } from '../components/KeyGridPreview.js';
import { StatusChip } from '../components/StatusChip.js';

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

export function DockCard({
  dock,
  selected,
  onHelp,
}: Readonly<{
  dock: DockUi;
  selected: boolean;
  onHelp: (id: string) => void;
}>): preact.JSX.Element {
  const select = (): void => {
    if (!selected) postSelectDock(dock.index);
  };
  return (
    <div
      class={selected ? 'dock-card surface-card dock-card--selected' : 'dock-card surface-card'}
      role="button"
      tabIndex={0}
      onClick={select}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          select();
        }
      }}
    >
      <div class="dock-card-head">
        <span class="dock-card-name">{dock.modelName}</span>
        <DockChip dock={dock} />
      </div>
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
      {!dock.elgatoConnected &&
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
            <RestartNote />
            <ManualAddPanel port={String(dock.primaryPort)} onHelp={onHelp} />
          </>
        ))}
    </div>
  );
}

export function DockList({
  docks,
  onHelp,
}: Readonly<{ docks: DockUi[]; onHelp: (id: string) => void }>): preact.JSX.Element {
  const selected = useStore((s) => s.status.selectedDock ?? 0);
  return (
    <div class="dock-list">
      {docks.map((dock) => (
        <DockCard key={dock.index} dock={dock} selected={dock.index === selected} onHelp={onHelp} />
      ))}
    </div>
  );
}
