// Settings → Browser deck: turn a phone or tablet into a dock, pair it, see and revoke devices.
// The panel polls GET /api/virtual-deck every 2 s while open (no WS event, see the plan).
import { useEffect, useState } from 'preact/hooks';
import { Collapsible } from '../components/Collapsible.js';
import { ToggleRow } from '../components/Fields.js';
import { getJson, postJson } from '../lib/ui-api.js';
import { Feedback, useAsyncAction } from '../lib/ui-async.js';
import type { PairingOffer, VirtualDeckDeviceView, VirtualDeckState } from '../../contract-deck.js';
import { CopyChip } from './controls.js';
import { PairingAddressLink } from './pairing-address-modal.js';
import { PairingQr, type QrLoader } from './pairing-qr.js';

const POLL_MS = 2000;
// Mirrors shared/types.ts VIRTUAL_DOCK_INDEX (MAX_DOCKS - 1): the browser deck's fixed dock.
const VIRTUAL_DOCK_INDEX = 3;

/** Seconds left, never negative; the offer disappears at 0. */
export function secondsLeft(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 1000));
}

function deviceStatus(d: VirtualDeckDeviceView): string {
  if (d.connected) return 'connected now';
  if (d.lastSeenAt) return `last seen ${new Date(d.lastSeenAt).toLocaleTimeString()} (since start)`;
  return 'not seen since start';
}

function listeningText(state: VirtualDeckState): string {
  if (!state.listening) return 'Not listening.';
  const where = state.urls.length > 0 ? state.urls.join(', ') : `port ${state.port}`;
  return `Listening on ${where}`;
}

function ElgatoHint({ state }: Readonly<{ state: VirtualDeckState }>): preact.JSX.Element {
  return (
    <p class="multi-deck-note" id="deck-elgato-hint">
      In the Elgato app choose Add Network Device and enter this computer&apos;s IP with port{' '}
      <b>{state.coraPorts.primary}</b>. The Elgato app pairs one dock per IP address, so use an IP
      no other dock uses, for example 127.0.0.2 (macOS: run{' '}
      <code>sudo ifconfig lo0 alias 127.0.0.2 up</code> first).
    </p>
  );
}

function Offer({
  offer,
  now,
  onCancel,
  loadQr,
}: Readonly<{
  offer: PairingOffer;
  now: number;
  onCancel: () => void;
  loadQr?: QrLoader;
}>): preact.JSX.Element {
  return (
    <div class="manual-add panel-inset" id="deck-offer">
      <div class="manual-add-head">
        <span>Pair a device</span>
      </div>
      <p class="step-sub">Open one of these addresses on the phone or tablet:</p>
      <div class="addr-row">
        {offer.urls.map((u) => (
          <CopyChip key={u} label="URL" value={u} cls="addr-port-chip" />
        ))}
      </div>
      <p class="step-sub">Then enter this code:</p>
      <div class="addr-row" id="deck-short-code">
        <CopyChip label="Code" value={offer.shortCode} cls="addr-chip" />
      </div>
      <PairingQr text={offer.qrUrl} load={loadQr} />
      <p class="multi-deck-note">Expires in {secondsLeft(offer.expiresAt, now)} s.</p>
      <button class="ghostbtn" id="deck-offer-cancel" type="button" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

function DeviceList({
  state,
  busy,
  onRevoke,
  onRevokeAll,
}: Readonly<{
  state: VirtualDeckState;
  busy: boolean;
  onRevoke: (id: string, name: string) => void;
  onRevokeAll: () => void;
}>): preact.JSX.Element {
  if (state.devices.length === 0) {
    return <p class="multi-deck-note">No paired devices.</p>;
  }
  return (
    <>
      <ul class="push-tokens" id="deck-devices">
        {state.devices.map((d) => (
          <li key={d.id}>
            <span class="push-token-name">{d.name}</span>
            <span class="multi-deck-note">
              {' '}
              added {new Date(d.createdAt).toLocaleDateString()} · {deviceStatus(d)}
            </span>
            <button
              class="ghostbtn"
              type="button"
              disabled={busy}
              onClick={() => onRevoke(d.id, d.name)}
            >
              Revoke
            </button>
          </li>
        ))}
      </ul>
      <button
        class="ghostbtn"
        id="deck-revoke-all"
        type="button"
        disabled={busy}
        onClick={onRevokeAll}
      >
        Revoke all
      </button>
    </>
  );
}

/** One read on mount (the toggle needs it), then polling only while the section is open. */
function useVirtualDeckState(open: boolean): {
  state: VirtualDeckState | null;
  now: number;
  refresh: () => Promise<void>;
} {
  const [state, setState] = useState<VirtualDeckState | null>(null);
  const [now, setNow] = useState(() => Date.now());

  async function refresh(): Promise<void> {
    setState(await getJson<VirtualDeckState>('/api/virtual-deck'));
  }

  useEffect(
    function pollState() {
      void refresh().catch(() => undefined);
      if (!open) return undefined;
      const id = setInterval(() => {
        void refresh().catch(() => undefined);
        setNow(Date.now());
      }, POLL_MS);
      return function stopPolling(): void {
        clearInterval(id);
      };
    },
    // `refresh` only closes over the stable state setter.
    [open],
  );
  return { state, now, refresh };
}

/** Everything shown once the browser deck is enabled. */
function DeckDetails({
  state,
  offer,
  now,
  busy,
  loadQr,
  onPair,
  onCancel,
  onRevoke,
  onRevokeAll,
}: Readonly<{
  state: VirtualDeckState;
  offer: PairingOffer | null;
  now: number;
  busy: boolean;
  loadQr?: QrLoader;
  onPair: () => void;
  onCancel: () => void;
  onRevoke: (id: string, name: string) => void;
  onRevokeAll: () => void;
}>): preact.JSX.Element {
  return (
    <>
      <p class="multi-deck-note" id="deck-status">
        {listeningText(state)}
      </p>
      {state.bindLoopbackOnly && (
        <p class="settings-error">
          DeckBridge is bound to 127.0.0.1 (--bind), so phones and tablets cannot reach it.
        </p>
      )}
      <ElgatoHint state={state} />
      <PairingAddressLink initialDock={VIRTUAL_DOCK_INDEX} />
      {offer ? (
        <Offer offer={offer} now={now} onCancel={onCancel} loadQr={loadQr} />
      ) : (
        <button
          class="ghostbtn"
          id="deck-pair"
          type="button"
          disabled={busy || !state.listening}
          onClick={onPair}
        >
          Pair a device
        </button>
      )}
      <DeviceList state={state} busy={busy} onRevoke={onRevoke} onRevokeAll={onRevokeAll} />
      {state.latencyP95Ms !== undefined && (
        <p class="multi-deck-note" id="deck-latency">
          Input latency p95: {Math.round(state.latencyP95Ms)} ms (last 200 presses)
        </p>
      )}
    </>
  );
}

function VirtualDeckBody({
  open,
  loadQr,
}: Readonly<{ open: boolean; loadQr?: QrLoader }>): preact.JSX.Element {
  const { state, now, refresh } = useVirtualDeckState(open);
  const [offer, setOffer] = useState<PairingOffer | null>(null);
  const action = useAsyncAction();

  // The offer closes by itself once the server shows nothing pending (used, cancelled, expired).
  const visibleOffer = offer !== null && state?.pending !== undefined ? offer : null;

  const enabled = state?.enabled ?? false;

  const toggle = (next: boolean): Promise<void> =>
    action.run(async () => {
      await postJson('/api/virtual-deck', { enabled: next });
      if (!next) setOffer(null);
      await refresh();
      return next ? 'Browser deck on.' : 'Browser deck off. Paired devices stay saved.';
    });
  const pair = (): Promise<void> =>
    action.run(async () => {
      const created = await postJson<PairingOffer>('/api/virtual-deck/pairing');
      // Refresh first: the offer closes itself when the server shows nothing pending.
      await refresh();
      setOffer(created);
    });
  const cancel = (): Promise<void> =>
    action.run(async () => {
      await postJson('/api/virtual-deck/pairing/cancel');
      setOffer(null);
      await refresh();
    });
  const revoke = (id: string, name: string): Promise<void> =>
    action.run(async () => {
      if (!confirm(`Revoke "${name}"? It must be paired again to use the deck.`)) return;
      await postJson('/api/virtual-deck/revoke', { id });
      await refresh();
    });
  const revokeAll = (): Promise<void> =>
    action.run(async () => {
      if (!confirm('Revoke every paired device?')) return;
      await postJson('/api/virtual-deck/revoke-all');
      await refresh();
    });

  return (
    <>
      <ToggleRow
        id="toggle-virtual-deck"
        label="Use a phone or tablet as a deck"
        checked={enabled}
        disabled={state === null || action.busy}
        onChange={(next) => void toggle(next)}
      />
      <p class="multi-deck-note">
        Opens a page for any browser on your network. It shows up as one more dock in the Elgato
        app. Layout: Stream Deck MK.2 (15 keys); more layouts may come.
      </p>
      {state?.lastError && <p class="settings-error">{state.lastError}</p>}
      {state && enabled && (
        <DeckDetails
          state={state}
          offer={visibleOffer}
          now={now}
          busy={action.busy}
          loadQr={loadQr}
          onPair={() => void pair()}
          onCancel={() => void cancel()}
          onRevoke={(id, name) => void revoke(id, name)}
          onRevokeAll={() => void revokeAll()}
        />
      )}
      <Feedback error={action.error} status={action.status} />
    </>
  );
}

export function VirtualDeckPanel({ loadQr }: Readonly<{ loadQr?: QrLoader }>): preact.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible title="Browser deck" bodyId="virtual-deck-body" onToggle={setOpen}>
      <VirtualDeckBody open={open} loadQr={loadQr} />
    </Collapsible>
  );
}
