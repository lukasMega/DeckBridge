import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
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
  if (!supported) return <p>Real-device mode needs desktop Chrome, Edge or Opera.</p>;
  let label = connected ? 'Disconnect' : 'Connect device';
  if (busy) label = 'Please wait…';
  return (
    <>
      <p>Quit DeckBridge and your deck’s vendor app first, so the browser can open the deck.</p>
      <button
        class="ghostbtn"
        disabled={busy}
        onClick={connected ? () => void disconnect() : connect}
      >
        {label}
      </button>
    </>
  );
}

function DemoBar({ backend }: Readonly<{ backend: DemoBackend }>) {
  const [, refresh] = useState(0);
  const [mode, setMode] = useState<'mock' | 'hw'>('mock');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [unknown, setUnknown] = useState<{ vid: number; pid: number } | null>(null);
  const supported = !!navigator.hid;
  const connected = backend.deck.kind === 'hw';
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
    <div class="demo-controls">
      <div role="tablist" aria-label="Demo mode">
        <button
          class="ghostbtn"
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
      {mode === 'mock' ? (
        <>
          <select
            aria-label="Device model"
            value={backend.state.model.id}
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
          <button
            class="ghostbtn"
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
          <button class="ghostbtn" onClick={() => backend.reset()}>
            Reset
          </button>
        </>
      ) : (
        <HardwareControls
          supported={supported}
          busy={busy}
          connected={connected}
          connect={connect}
          disconnect={disconnect}
        />
      )}
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
  );
}

export function mountBar(element: HTMLElement, backend: DemoBackend): void {
  render(<DemoBar backend={backend} />, element);
}
