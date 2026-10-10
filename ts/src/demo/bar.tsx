import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { DEVICE_MODELS, DEFAULT_MODEL } from '../devices/registry.js';
import { DOCS_BASE, DOCS_TOPICS } from '../shared/docs-topics.js';
import type { DemoBackend } from './backend.js';
import { connectHwDeck } from './hw-deck.js';
import { track, type FailReason } from './track.js';

const FAILURE_MESSAGES: Record<FailReason, string> = {
  denied: 'The browser denied device access.',
  open: 'Could not open the deck. Is DeckBridge or the vendor app still running?',
  write: 'Could not write to the deck. Disconnect and try again.',
  disconnect: 'Device disconnected. Returned to Mock mode.',
};

function HardwareControls({
  supported,
  busy,
  connected,
  connect,
  disconnect,
}: Readonly<{
  supported: boolean;
  busy: boolean;
  connected: boolean;
  connect: () => void;
  disconnect: () => Promise<void>;
}>) {
  const connectModal = useRef<HTMLDialogElement>(null);
  if (!supported) return <p>Real-device mode needs desktop Chrome, Edge or Opera.</p>;
  let label = connected ? 'Disconnect' : 'Connect device';
  if (busy) label = 'Please wait…';
  return (
    <>
      <button
        class="ghostbtn"
        aria-label={label}
        data-tooltip={
          connected
            ? 'Release your USB deck and return to Mock mode.'
            : 'Choose your USB deck to connect through this browser.'
        }
        aria-description={
          connected
            ? 'Release your USB deck and return to Mock mode.'
            : 'Choose your USB deck to connect through this browser.'
        }
        disabled={busy}
        onClick={connected ? () => void disconnect() : () => connectModal.current?.showModal()}
      >
        {label}
      </button>
      <dialog
        ref={connectModal}
        class="demo-connect-modal"
        aria-labelledby="demo-connect-title"
        aria-describedby="demo-connect-message"
      >
        <h2 id="demo-connect-title">Before connecting</h2>
        <p id="demo-connect-message">
          Quit DeckBridge and your deck’s vendor app first, so the browser can open the deck.
        </p>
        <div class="demo-connect-actions">
          <button class="ghostbtn" onClick={() => connectModal.current?.close()}>
            Cancel
          </button>
          <button
            class="ghostbtn"
            onClick={() => {
              connectModal.current?.close();
              connect();
            }}
          >
            Continue
          </button>
        </div>
      </dialog>
    </>
  );
}

function DemoBar({ backend }: Readonly<{ backend: DemoBackend }>) {
  const panel = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; offsetX: number; offsetY: number } | null>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const [, refresh] = useState(0);
  const [mode, setMode] = useState<'mock' | 'hw'>('mock');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [unknown, setUnknown] = useState<{ vid: number; pid: number } | null>(null);
  const supported = !!navigator.hid;
  const connected = backend.deck.kind === 'hw';

  function moveTo(x: number, y: number): void {
    const element = panel.current;
    if (!element) return;
    const panelWindow = element.ownerDocument.defaultView ?? window;
    setPosition({
      x: Math.max(8, Math.min(x, panelWindow.innerWidth - element.offsetWidth - 8)),
      y: Math.max(8, Math.min(y, panelWindow.innerHeight - element.offsetHeight - 8)),
    });
  }

  useEffect(() => {
    const ownerWindow = panel.current?.ownerDocument.defaultView ?? window;
    function keepInView(): void {
      const rect = panel.current?.getBoundingClientRect();
      if (rect) moveTo(rect.left, rect.top);
    }
    ownerWindow.addEventListener('resize', keepInView);
    return () => ownerWindow.removeEventListener('resize', keepInView);
  }, []);
  useEffect(
    function subscribeBackend() {
      let wasHardware = backend.deck.kind === 'hw';
      return backend.onChange(() => {
        if (wasHardware && backend.deck.kind === 'mock') setMode('mock');
        wasHardware = backend.deck.kind === 'hw';
        refresh((value) => value + 1);
      });
    },
    [backend],
  );

  function connect(): void {
    setBusy(true);
    setMessage('');
    setUnknown(null);
    const events = backend.deckEvents();
    const pending = connectHwDeck(
      {
        ...events,
        lost: (reason) => {
          setMessage(FAILURE_MESSAGES[reason as FailReason]);
          setMode('mock');
          events.lost(reason);
        },
      },
      track,
    );
    void pending
      .then(async (result) => {
        if (!result) return;
        if ('unknown' in result) setUnknown(result.unknown);
        else if ('fail' in result) setMessage(FAILURE_MESSAGES[result.fail]);
        else {
          await backend.useDeck(result);
          setMessage(`Connected: ${result.model.name}`);
        }
      })
      .finally(() => setBusy(false));
  }

  async function disconnect(): Promise<void> {
    setBusy(true);
    await backend.setModel(DEFAULT_MODEL.id);
    setMode('mock');
    setMessage('');
    setBusy(false);
  }

  return (
    <div
      ref={panel}
      class="demo-panel"
      role="region"
      aria-label="Demo controls"
      onClick={(event) => {
        (event.target as Element)
          .closest('[data-tooltip]')
          ?.setAttribute('data-tooltip-dismissed', '');
      }}
      onPointerOut={(event) => {
        const tooltip = (event.target as Element).closest('[data-tooltip]');
        if (tooltip && !tooltip.contains(event.relatedTarget as Node | null))
          tooltip.removeAttribute('data-tooltip-dismissed');
      }}
      style={
        position
          ? {
              position: 'fixed',
              left: `${position.x}px`,
              top: `${position.y}px`,
              transform: 'none',
            }
          : undefined
      }
    >
      <div class="demo-drag-handle">
        <button
          class="demo-drag-grip"
          type="button"
          aria-label="Move demo controls"
          aria-description="Drag to move. Arrow keys move the panel; Home centers it."
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            const rect = panel.current!.getBoundingClientRect();
            drag.current = {
              id: event.pointerId,
              offsetX: event.clientX - rect.left,
              offsetY: event.clientY - rect.top,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
            event.preventDefault();
          }}
          onPointerMove={(event) => {
            const start = drag.current;
            if (start?.id === event.pointerId)
              moveTo(event.clientX - start.offsetX, event.clientY - start.offsetY);
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
          onKeyDown={(event) => {
            const rect = panel.current!.getBoundingClientRect();
            switch (event.key) {
              case 'ArrowLeft':
                moveTo(rect.left - 12, rect.top);
                break;
              case 'ArrowRight':
                moveTo(rect.left + 12, rect.top);
                break;
              case 'ArrowUp':
                moveTo(rect.left, rect.top - 12);
                break;
              case 'ArrowDown':
                moveTo(rect.left, rect.top + 12);
                break;
              case 'Home':
                setPosition(null);
                break;
              default:
                return;
            }
            event.preventDefault();
          }}
        >
          <span>
            <span aria-hidden="true">⠿</span> Demo controls
          </span>
        </button>
        <div class="demo-mode-toggle" role="tablist" aria-label="Demo mode">
          <button
            class="ghostbtn"
            aria-label="Mock"
            data-tooltip="Try a simulated deck without hardware."
            aria-description="Try a simulated deck without hardware."
            role="tab"
            aria-selected={mode === 'mock'}
            disabled={busy}
            onClick={() => {
              if (connected) void disconnect();
              else setMode('mock');
            }}
          >
            Mock
          </button>
          <button
            class="ghostbtn"
            aria-label="Real device"
            data-tooltip="Connect a USB deck through your browser."
            aria-description="Connect a USB deck through your browser."
            role="tab"
            aria-selected={mode === 'hw'}
            disabled={busy}
            onClick={() => {
              setMode('hw');
              setMessage('');
              if (!supported) track.hwUnsupported();
            }}
          >
            Real device
          </button>
        </div>
      </div>
      <div class="demo-controls">
        <div class="demo-mock" hidden={mode !== 'mock'}>
          <div class="demo-model" data-tooltip="Choose which deck to simulate.">
            <select
              aria-label="Device model"
              aria-description="Choose which deck to simulate."
              value={backend.state.model.id}
              disabled={mode !== 'mock' || busy}
              onChange={(event) => {
                const id = event.currentTarget.value;
                track.mockModel(id);
                void backend.setModel(id);
              }}
            >
              {DEVICE_MODELS.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name}
                </option>
              ))}
            </select>
          </div>
          <button
            class="ghostbtn"
            aria-label={backend.state.plugged ? 'Unplug' : 'Plug in'}
            disabled={mode !== 'mock' || busy}
            data-tooltip={
              backend.state.plugged
                ? 'Simulate disconnecting your deck.'
                : 'Simulate connecting your selected deck.'
            }
            aria-description={
              backend.state.plugged
                ? 'Simulate disconnecting your deck.'
                : 'Simulate connecting your selected deck.'
            }
            onClick={() => {
              setMessage('');
              if (backend.state.plugged) backend.unplug();
              else {
                track.mockModel(backend.state.model.id);
                backend.plugIn();
              }
            }}
          >
            {backend.state.plugged ? 'Unplug' : 'Plug in'}
          </button>
          <button
            class="ghostbtn"
            aria-label="Reset"
            disabled={mode !== 'mock' || busy}
            data-tooltip="Start this demo again with the selected deck."
            aria-description="Start this demo again with the selected deck."
            onClick={() => backend.reset()}
          >
            Reset
          </button>
        </div>
        <div class="demo-hardware" hidden={mode !== 'hw'}>
          <HardwareControls
            supported={supported}
            busy={busy}
            connected={connected}
            connect={connect}
            disconnect={disconnect}
          />
        </div>
        {unknown && (
          <p role="status">
            This device ({unknown.vid.toString(16).padStart(4, '0')}:
            {unknown.pid.toString(16).padStart(4, '0')}) is not supported yet.{' '}
            <a href={DOCS_BASE + DOCS_TOPICS.devices} target="_top">
              Supported devices
            </a>
          </p>
        )}
        {(backend.state.activity || message) && (
          <p role="status">{backend.state.activity || message}</p>
        )}
      </div>
    </div>
  );
}

export function mountBar(element: HTMLElement, backend: DemoBackend): () => void {
  render(<DemoBar backend={backend} />, element);
  return () => render(null, element);
}
