// "Need another address?": the Elgato app pairs one network dock per IP address of this
// computer, so a further dock needs another local address. Three steps: make the address exist
// (command the user runs), test it, then add the dock in the Elgato app. DeckBridge never runs
// sudo. The test checks that the address exists locally and that DeckBridge can bind and answer
// on it; it does not connect to the CORA ports.
import { useEffect, useState } from 'preact/hooks';
import type {
  AddressTestRequest,
  AddressTestResult,
  PairingAddressesInfo,
} from '../../contract-pairing.js';
import { getJson, postJson } from '../lib/ui-api.js';
import { Feedback, useAsyncAction } from '../lib/ui-async.js';
import { CopyChip } from './controls.js';
import { OS_TABS, addressSteps, defaultTab, elgatoEntry, type OsTab } from './address-steps.js';

export function testResultText(r: AddressTestResult, ip: string): string {
  if (r.ok) return `${ip} works.`;
  if (r.error) return r.error;
  return r.stage === 'address'
    ? `${ip} is not an address of this computer yet.`
    : `DeckBridge does not answer on ${ip}.`;
}

function StepOne({
  info,
  ip,
  tab,
  onTab,
}: Readonly<{
  info: PairingAddressesInfo;
  ip: string;
  tab: OsTab;
  onTab: (t: OsTab) => void;
}>): preact.JSX.Element {
  const steps = addressSteps(tab, ip);
  return (
    <section>
      <h4>1. Run this once</h4>
      <div class="address-tabs" role="tablist">
        {OS_TABS.map((t) => (
          <button
            key={t.id}
            class="ghostbtn"
            type="button"
            role="tab"
            aria-selected={t.id === tab}
            onClick={() => onTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {steps.command && <CopyChip label="Command" value={steps.command} cls="addr-chip" />}
      {steps.undo && <CopyChip label="Undo" value={steps.undo} cls="addr-chip" />}
      {steps.notes.map((n) => (
        <p key={n} class="multi-deck-note">
          {n}
        </p>
      ))}
      {steps.unverified && <p class="multi-deck-note">Unverified on this OS.</p>}
      {info.bindAddress !== '0.0.0.0' && (
        <p class="settings-error">
          DeckBridge is bound to {info.bindAddress} (--bind), so it only answers on that address.
        </p>
      )}
    </section>
  );
}

// The parent keys this by address, so a different address starts without a verdict.
function StepTwo({
  ip,
  onResult,
}: Readonly<{ ip: string; onResult: (ok: boolean) => void }>): preact.JSX.Element {
  const action = useAsyncAction();
  const [result, setResult] = useState<AddressTestResult | null>(null);
  const test = (): Promise<void> =>
    action.run(async () => {
      const r = await postJson<AddressTestResult>('/api/pairing-addresses/test', {
        ip,
      } satisfies AddressTestRequest);
      setResult(r);
      onResult(r.ok);
    });
  return (
    <section>
      <h4>2. Test</h4>
      <button
        class="ghostbtn"
        id="address-test"
        type="button"
        disabled={action.busy}
        onClick={() => void test()}
      >
        Test {ip}
      </button>
      {result && (
        <p class={result.ok ? 'settings-status' : 'settings-error'} id="address-test-result">
          {result.ok ? '✓ ' : '✗ '}
          {testResultText(result, ip)}
        </p>
      )}
      <Feedback error={action.error} status={null} />
    </section>
  );
}

function StepThree({
  info,
  ip,
  ready,
  dockIndex,
  onDock,
}: Readonly<{
  info: PairingAddressesInfo;
  ip: string;
  ready: boolean;
  dockIndex: number;
  onDock: (i: number) => void;
}>): preact.JSX.Element {
  const dock = info.docks.find((d) => d.index === dockIndex);
  return (
    <section class={ready ? undefined : 'address-step--wait'}>
      <h4>3. Add it in the Elgato app</h4>
      <label class="tuning-field">
        <span>Dock</span>
        <select
          class="input"
          id="address-dock"
          value={dockIndex}
          onChange={(e) => onDock(Number((e.target as HTMLSelectElement).value))}
        >
          {info.docks.map((d) => (
            <option key={d.index} value={d.index}>
              {d.name}
              {d.running ? '' : ' (not running yet)'}
            </option>
          ))}
        </select>
      </label>
      {dock && (
        <>
          <p class="multi-deck-note">In the Elgato app, choose Add Network Device and enter:</p>
          <div id="address-elgato">
            <CopyChip label="Address" value={elgatoEntry(ip, dock.primaryPort)} cls="addr-chip" />
          </div>
        </>
      )}
      {!ready && <p class="multi-deck-note">Do step 2 first.</p>}
    </section>
  );
}

function ModalBody({
  info,
  initialDock,
}: Readonly<{ info: PairingAddressesInfo; initialDock?: number }>): preact.JSX.Element {
  const [ip, setIp] = useState(info.suggested);
  const [tab, setTab] = useState<OsTab>(() => defaultTab(info.platform));
  const [ok, setOk] = useState(false);
  const [dockIndex, setDockIndex] = useState(initialDock ?? info.docks[0]?.index ?? 0);
  return (
    <>
      <label class="tuning-field">
        <span>Address</span>
        <select
          class="input"
          id="address-pick"
          value={ip}
          onChange={(e) => {
            setIp((e.target as HTMLSelectElement).value);
            setOk(false);
          }}
        >
          {info.candidates.map((c) => (
            <option key={c.ip} value={c.ip}>
              {c.ip} ({c.kind === 'loopback' ? 'loopback' : 'LAN'})
            </option>
          ))}
        </select>
      </label>
      <StepOne info={info} ip={ip} tab={tab} onTab={setTab} />
      <StepTwo key={ip} ip={ip} onResult={setOk} />
      <StepThree info={info} ip={ip} ready={ok} dockIndex={dockIndex} onDock={setDockIndex} />
    </>
  );
}

export function PairingAddressModal({
  initialDock,
  onClose,
}: Readonly<{ initialDock?: number; onClose: () => void }>): preact.JSX.Element {
  const [info, setInfo] = useState<PairingAddressesInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(function loadInfo() {
    let live = true;
    getJson<PairingAddressesInfo>('/api/pairing-addresses')
      .then((r) => {
        if (live) setInfo(r);
        return undefined;
      })
      .catch((e: unknown) => {
        if (live) setError((e as Error).message || 'Could not load addresses.');
      });
    return function cancel(): void {
      live = false;
    };
  }, []);
  useEffect(
    function closeOnEscape() {
      const onKey = (e: KeyboardEvent): void => {
        if (e.key === 'Escape') onClose();
      };
      document.addEventListener('keydown', onKey);
      return function unbind(): void {
        document.removeEventListener('keydown', onKey);
      };
    },
    [onClose],
  );
  return (
    <div class="address-backdrop" onClick={onClose}>
      <div
        class="popover floating-surface address-modal"
        id="address-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Pairing address"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          class="pop-close circle"
          id="address-close"
          type="button"
          aria-label="Close pairing address"
          onClick={onClose}
        >
          ×
        </button>
        <h2>Need another address?</h2>
        <p class="multi-deck-note">
          The Elgato app pairs one dock per IP address of this computer. Give each dock its own.
        </p>
        {error && <p class="settings-error">{error}</p>}
        {!info && !error && <p class="multi-deck-note">Loading…</p>}
        {info && <ModalBody info={info} initialDock={initialDock} />}
      </div>
    </div>
  );
}

// Dock cards select themselves on click/Enter/Space; none of this should bubble up to that.
function stopBubbling(e: Event): void {
  e.stopPropagation();
}

/** The "Need another address?" entry point; owns the open state of its modal. */
export function PairingAddressLink({
  initialDock,
}: Readonly<{ initialDock?: number }>): preact.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <span class="address-link-wrap" onClick={stopBubbling} onKeyDown={stopBubbling}>
      <button class="ghostbtn address-link" type="button" onClick={() => setOpen(true)}>
        Need another address?
      </button>
      {open && <PairingAddressModal initialDock={initialDock} onClose={() => setOpen(false)} />}
    </span>
  );
}
