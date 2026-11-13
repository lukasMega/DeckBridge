import { DocsLink } from '../components/DocsLink.js';
import { isBackdropClick } from '../components/Modal.js';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { DockUi } from '../ui-types.js';

// AKP05/AKP05E retain physical 5×2 geometry when paired as Stream Deck +.
function elgatoColumns(dock: DockUi): number {
  return dock.coraProfile === 'stream-deck-plus' ? 4 : dock.columns;
}

function SideKeysDialog({
  dock,
  description,
  onClose,
}: Readonly<{ dock: DockUi; description?: string; onClose: () => void }>): preact.JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const sideKeys = dock.extraKeys ?? [];
  const columns = elgatoColumns(dock);
  const physicalColumns = columns + 1;
  const labels = sideKeys.length === 2 ? ['Top', 'Bottom'] : ['Top', 'Middle', 'Bottom'];
  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  return (
    <dialog
      ref={dialogRef}
      class="popover floating-surface side-keys-help"
      aria-labelledby="side-keys-help-title"
      onClose={onClose}
      onClick={(event) => {
        if (isBackdropClick(event)) onClose();
      }}
    >
      <button
        class="pop-close circle"
        type="button"
        aria-label="Close side keys help"
        onClick={onClose}
      >
        ×
      </button>
      <h2 id="side-keys-help-title">Side keys</h2>
      <p>{dock.modelName}</p>
      <div
        class="side-keys-device"
        style={{ gridTemplateColumns: `repeat(${physicalColumns}, minmax(0, 1fr))` }}
        role="img"
        aria-label={`${physicalColumns} by ${dock.rows} device grid; ${columns} by ${dock.rows} Elgato grid, with ${sideKeys.length} side keys in right column`}
      >
        <div class="side-keys-device-grid">
          {Array.from({ length: columns * dock.rows }, (_, index) => (
            <span
              class="side-keys-device-key side-keys-elgato"
              key={index}
              style={{
                gridColumn: (index % columns) + 1,
                gridRow: Math.floor(index / columns) + 1,
              }}
            >
              {index + 1}
            </span>
          ))}
        </div>
        <div class="side-keys-device-column">
          {sideKeys.map((wireId, index) => (
            <span
              class="side-keys-device-key side-keys-owned"
              style={{ gridColumn: physicalColumns, gridRow: index + 1 }}
              key={wireId}
              title={`Physical key ${(index + 1) * physicalColumns}`}
            >
              {labels[index] ?? `Key ${wireId}`}
            </span>
          ))}
        </div>
      </div>
      <div class="side-keys-legend">
        <span>
          <i class="side-keys-elgato" />
          Elgato app
        </span>
        <span>
          <i class="side-keys-owned" />
          DeckBridge side keys
        </span>
      </div>
      <p>
        {description} <DocsLink topic="side-keys" />
      </p>
    </dialog>
  );
}

export function SideKeysHelp({
  dock,
  description,
}: Readonly<{ dock: DockUi; description?: string }>): preact.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        class="tuning-help side-keys-help-button"
        type="button"
        aria-label="Side keys help"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        ?
      </button>
      {open && (
        <SideKeysDialog dock={dock} description={description} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
