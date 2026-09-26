import { useEffect, useRef, useState } from 'preact/hooks';
import type { DockUi } from '../ui-types.js';

// AKP05E exposes physical 5×2 geometry even when paired as Stream Deck +.
function elgatoColumns(dock: DockUi): number {
  return dock.modelId === 'ajazz-akp05e' && dock.extraKeys?.length === 2 ? 4 : dock.columns;
}

function KeyDataFlow({ dock }: Readonly<{ dock: DockUi }>): preact.JSX.Element {
  const pressable = (dock.pressableExtraKeys?.length ?? 0) > 0;
  return (
    <svg
      class="side-keys-sankey"
      viewBox="0 0 600 340"
      role="img"
      aria-labelledby="key-flow-title key-flow-description"
    >
      <title id="key-flow-title">Key data through DeckBridge</title>
      <desc id="key-flow-description">
        Elgato sends grid key images through DeckBridge to device. Device grid key presses return
        through DeckBridge to Elgato. DeckBridge generates side key widget images locally.
        {pressable
          ? 'Side key presses refresh their widget or run local commands in DeckBridge and never reach Elgato.'
          : 'Side keys are display-only, without key press events.'}
      </desc>
      <defs>
        <marker
          id="key-flow-blue-arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="12"
          markerHeight="12"
          orient="auto-start-reverse"
          markerUnits="userSpaceOnUse"
        >
          <path d="M0 0 L10 5 L0 10 Z" fill="#2563eb" />
        </marker>
        <marker
          id="key-flow-amber-arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="12"
          markerHeight="12"
          orient="auto-start-reverse"
          markerUnits="userSpaceOnUse"
        >
          <path d="M0 0 L10 5 L0 10 Z" fill="#d97706" />
        </marker>
      </defs>
      <g class="side-keys-flow-blue">
        <path d="M118 83 C165 83 174 83 222 83 L222 101 C174 101 165 101 118 101 Z" />
        <path d="M338 83 C383 83 391 83 436 83 L436 101 C391 101 383 101 338 101 Z" />
        <path d="M118 163 C165 163 174 163 222 163 L222 175 C174 175 165 175 118 175 Z" />
        <path d="M338 163 C383 163 391 163 436 163 L436 175 C391 175 383 175 338 175 Z" />
      </g>
      <g class="side-keys-flow-amber">
        <path d="M338 239 C385 239 389 215 436 215 L436 233 C389 233 385 257 338 257 Z" />
        {pressable && (
          <path d="M338 295 C385 295 389 275 436 275 L436 287 C389 287 385 307 338 307 Z" />
        )}
      </g>
      <g class="side-keys-flow-direction" stroke="#2563eb" marker-end="url(#key-flow-blue-arrow)">
        <path d="M126 92 H214" />
        <path d="M346 92 H428" />
        <path d="M214 169 H126" />
        <path d="M428 169 H346" />
      </g>
      <g class="side-keys-flow-direction" stroke="#d97706" marker-end="url(#key-flow-amber-arrow)">
        <path d="M346 248 C382 248 392 224 428 224" />
        {pressable && <path d="M428 281 C392 281 382 301 346 301" />}
      </g>
      <rect class="side-keys-flow-node" x="8" y="45" width="110" height="158" rx="10" />
      <rect class="side-keys-flow-node" x="222" y="45" width="116" height="280" rx="10" />
      <rect class="side-keys-flow-node" x="436" y="45" width="156" height="280" rx="10" />
      <g class="side-keys-flow-heading">
        <text x="63" y="28">
          Elgato app
        </text>
        <text x="280" y="28">
          DeckBridge
        </text>
        <text x="514" y="28">
          Device
        </text>
      </g>
      <g class="side-keys-flow-label">
        <text x="63" y="88">
          Key images
        </text>
        <text x="63" y="168">
          Key presses
        </text>
        <text x="280" y="88">
          Forward
        </text>
        <text x="280" y="168">
          Return
        </text>
        <text x="280" y="244">
          Widget images
        </text>
        <text x="280" y="264">
          Local render
        </text>
        <text x="514" y="88">
          Elgato grid
        </text>
        <text x="514" y="108">
          {elgatoColumns(dock)} × {dock.rows} keys
        </text>
        <text x="514" y="168">
          Grid presses
        </text>
        <text x="514" y="224">
          Side keys
        </text>
        <text x="514" y="244">
          DeckBridge only
        </text>
        {pressable ? (
          <>
            <text x="280" y="300">
              Refresh / commands
            </text>
            <text x="514" y="286">
              Side key presses
            </text>
          </>
        ) : (
          <text x="514" y="286">
            Display only
          </text>
        )}
      </g>
      <g class="side-keys-flow-caption">
        <text x="170" y="73">
          Images
        </text>
        <text x="387" y="73">
          Images
        </text>
        <text x="170" y="150">
          Presses
        </text>
        <text x="387" y="150">
          Presses
        </text>
      </g>
    </svg>
  );
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
        if (event.target === event.currentTarget) {
          const bounds = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < bounds.left ||
            event.clientX > bounds.right ||
            event.clientY < bounds.top ||
            event.clientY > bounds.bottom
          )
            onClose();
        }
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
      <KeyDataFlow dock={dock} />
      <p class="side-keys-flow-note">
        Arrows show direction. Band widths do not represent traffic volume.
      </p>
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
              {Math.floor(index / columns) * physicalColumns + (index % columns) + 1}
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
      <p>{description}</p>
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
