// Multi-dock cards: one per connected Stream Deck (see DockUi in ui-types.ts).
// The SELECTED dock (click a card) gets the live KeyGridPreview — the server
// mirrors only the selected dock's images; every other card renders a static
// dimmed grid.
import { useStore } from '../store.js';
import type { DockUi } from '../ui-types.js';
import { ICON } from '../ui-icons.js';
import { Icon } from './Icon.js';
import { KeyGridPreview, ManualAddPanel } from './controls.js';
import { restartElgatoApp } from './handlers.js';

function postSelectDock(index: number): void {
  fetch('/api/select-dock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ index }),
  }).catch(() => undefined);
}

function StaticKeyGrid({
  keyCount,
  columns,
}: Readonly<{ keyCount: number; columns: number }>): preact.JSX.Element {
  const cells = [];
  for (let i = 0; i < keyCount; i++) cells.push(<div class="key-cell" key={i} />);

  return (
    <div class="preview dimmed">
      <div class="preview-head">
        <span class="preview-label">Preview</span>
        <span class="live-dot">Click to view</span>
      </div>
      <div class="key-grid" style={`grid-template-columns:repeat(${columns},1fr)`}>
        {cells}
      </div>
    </div>
  );
}

function DockChip({ dock }: Readonly<{ dock: DockUi }>): preact.JSX.Element {
  if (dock.elgatoConnected) {
    return (
      <span class="dock-chip dock-chip--paired">
        <Icon html={ICON.check} />
        Paired
      </span>
    );
  }
  if (dock.primaryConnected) {
    return (
      <span class="dock-chip dock-chip--pairing">
        <span class="ico-spin" />
        Elgato app connected
      </span>
    );
  }
  return (
    <span class="dock-chip dock-chip--waiting">
      <span class="ico-spin" />
      Waiting for Elgato app
    </span>
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
      class={selected ? 'dock-card dock-card--selected' : 'dock-card'}
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
      {selected ? (
        <KeyGridPreview
          keyCount={dock.keyCount}
          columns={dock.columns}
          dimmed={!dock.elgatoConnected}
          modelId={dock.modelId}
        />
      ) : (
        <StaticKeyGrid keyCount={dock.keyCount} columns={dock.columns} />
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
            <p class="dock-pairing-note">
              Paired before?{' '}
              <button class="link-btn" type="button" onClick={restartElgatoApp}>
                Restart the Elgato app
              </button>{' '}
              to reconnect.
            </p>
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
