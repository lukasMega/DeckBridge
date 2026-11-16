// Ways into the pairing wizard: the pairing-stage button, the auto-open, the version banner
// link and the Settings row. All stay hidden unless the server reports the route as supported.
import { useEffect } from 'preact/hooks';
import { Collapsible } from '../../components/Collapsible.js';
import { GhostButton } from '../../components/GhostButton.js';
import { patch, useStore } from '../../lib/store.js';
import { postJson } from '../../lib/ui-api.js';
import { Feedback, useAsyncAction } from '../../lib/ui-async.js';
import type { PairingRoute, PairingRouteStatus } from '../../ui-types.js';
import { ICON, Icon } from '../../components/Icon.js';
import { isAffected, shouldAutoOpen } from './flow.js';
import { wslRelayFailed } from '../wsl-relay-steps.js';
import { isRelayRoute } from './routes.js';
import { PairingWizard } from './wizard.js';

export function openPairingWizard(restart = false): void {
  patch({ pairingWizardOpen: true, pairingWizardRestart: restart });
}

function closePairingWizard(): void {
  patch({ pairingWizardOpen: false, pairingWizardRestart: false });
}

/** Mounted once beside the stages (SimpleApp). */
export function PairingWizardHost({
  onHelp,
}: Readonly<{ onHelp: (id: string) => void }>): preact.JSX.Element | null {
  const open = useStore((s) => s.pairingWizardOpen);
  const restart = useStore((s) => s.pairingWizardRestart);
  if (!open) return null;
  return <PairingWizard restart={restart} onClose={closePairingWizard} onHelp={onHelp} />;
}

export function FixPairingButton(): preact.JSX.Element | null {
  const supported = useStore((s) => s.pairingRoute?.supported === true);
  if (!supported) return null;
  return (
    <div class="addr-row">
      <button
        class="ctabtn primary"
        id="fix-pairing"
        type="button"
        onClick={() => openPairingWizard()}
      >
        Fix pairing for Stream Deck app 7.6.1
      </button>
    </div>
  );
}

/** Opens the wizard once when the rule holds; closing it dismisses, which ends the rule. */
export function useAutoOpen(onPairingStage: boolean): void {
  const should = useStore((s) => shouldAutoOpen(s.pairingRoute, onPairingStage));
  useEffect(
    function openWhenAffected() {
      if (should) openPairingWizard();
    },
    [should],
  );
}

/** Shown until a fix is chosen, for any Stream Deck app that may be 7.6.1 or newer. */
export function ElgatoVersionBanner(): preact.JSX.Element | null {
  const show = useStore(
    (s) =>
      s.pairingRoute?.supported === true &&
      s.pairingRoute.route === 'none' &&
      isAffected(s.pairingRoute.elgatoVersion) !== false,
  );
  if (!show) return null;
  return (
    <div class="warnrow conn-banner" role="note">
      <Icon class="w-ico" html={ICON.warn} />
      <span>Stream Deck app 7.6.1 can&apos;t pair with DeckBridge on the same computer.</span>
      <button class="linkbtn accent" type="button" onClick={() => openPairingWizard()}>
        Fix pairing
      </button>
    </div>
  );
}

const ROUTE_LABEL: Record<Exclude<PairingRoute, 'none'>, string> = {
  downgrade: 'Stream Deck app 7.6.0',
  wsl: 'Relay in WSL',
  device: 'Relay on another device',
  container: 'Relay in Apple container',
  orbstack: 'Relay in OrbStack',
};

function statusLine(s: PairingRouteStatus, wslFailed: boolean): string {
  if (s.route === 'none') return 'Not set up';
  const label = ROUTE_LABEL[s.route];
  // The pairing stage no longer shows the WSL checklist, so a failure must surface here.
  if (s.route === 'wsl' && wslFailed) return `${label} · needs attention (Run setup again)`;
  return s.relayIp === null ? label : `${label} · ${s.relayIp}`;
}

export function PairingRouteSetting(): preact.JSX.Element | null {
  const s = useStore((st) => st.pairingRoute);
  const wsl = useStore((st) => st.wslRelay);
  const action = useAsyncAction();
  if (!s?.supported) return null;
  const line = statusLine(s, wsl !== null && wslRelayFailed(wsl));
  const turnOff = (): Promise<void> =>
    action.run(async () => {
      patch({
        pairingRoute: await postJson<PairingRouteStatus>('/api/pairing-route', { route: 'none' }),
      });
    }, 'Could not reach DeckBridge.');
  return (
    <Collapsible title="Stream Deck app 7.6.1 pairing" bodyId="pairing-route-body" status={line}>
      <p class="multi-deck-note" id="pairing-route-status">
        {line}
      </p>
      <div class="addr-row">
        <GhostButton id="pairing-route-again" onClick={() => openPairingWizard(true)}>
          Run setup again
        </GhostButton>
        {isRelayRoute(s.route) && (
          <GhostButton id="pairing-route-off" disabled={action.busy} onClick={turnOff}>
            Turn off relay
          </GhostButton>
        )}
      </div>
      <Feedback error={action.error} status={null} />
    </Collapsible>
  );
}
