// Stream Deck app 7.6.1 refuses a dock at its own computer's IP, so on Windows DeckBridge can
// run a relay inside WSL2 and the app pairs with that address instead (issue #257). Two
// views: the WSL checklist inside the pairing wizard and the "via relay" line on the ready
// screen. The server drives the state; these only post "Check again" and the route switch.
import { useEffect, useState } from 'preact/hooks';
import { DocsLink } from '../components/DocsLink.js';
import { GhostButton } from '../components/GhostButton.js';
import { ICON, Icon } from '../components/Icon.js';
import { patch, useStore } from '../lib/store.js';
import { useCopyText } from '../lib/use-copy-text.js';
import { postJson } from '../lib/ui-api.js';
import { Feedback, useAsyncAction, type AsyncAction } from '../lib/ui-async.js';
import type { WslRelayState } from '../../contract-wsl-relay.js';
import type { PairingRouteStatus, WslRelayStatus } from '../ui-types.js';
import { isRelayRoute } from './pairing-wizard/routes.js';
import { CopyChip } from './controls.js';
import { wslRelayFailed, STUCK_MS, wslRelaySteps, type WslStep } from './wsl-relay-steps.js';

const URL_BASE = '/api/wsl-relay';

/** The routes reply with the new status, so the card updates before the WS event lands. */
function post(action: AsyncAction, path: string, body?: unknown): Promise<void> {
  return action.run(async () => {
    patch({ wslRelay: await postJson<WslRelayStatus>(`${URL_BASE}${path}`, body) });
  }, 'Could not reach DeckBridge.');
}

function StepMark({ step, n }: Readonly<{ step: WslStep; n: number }>): preact.JSX.Element {
  if (step.state === 'done') return <Icon class="num" html={ICON.check} />;
  const cls = { active: 'num you', error: 'num wsl-err', todo: 'num' }[step.state];
  return <span class={cls}>{step.state === 'error' ? '!' : n}</span>;
}

/** True once the relay has sat in `ready` for STUCK_MS; any other state resets the timer. */
function useStuck(state: WslRelayState | undefined): boolean {
  const [stuck, setStuck] = useState(false);
  useEffect(
    function armStuckTimer() {
      if (state !== 'ready') return undefined;
      const id = setTimeout(function markStuck() {
        setStuck(true);
      }, STUCK_MS);
      return function clearStuckTimer() {
        clearTimeout(id);
        setStuck(false);
      };
    },
    [state],
  );
  return stuck;
}

function StepRow({ step, n }: Readonly<{ step: WslStep; n: number }>): preact.JSX.Element {
  return (
    <li class={step.state === 'todo' ? 'address-step--wait' : undefined}>
      <StepMark step={step} n={n} />
      <div class="wsl-step">
        <b>{step.title}</b>
        {step.sub && <p class="step-sub">{step.sub}</p>}
        {step.hint && (
          <p class="step-sub">
            {step.hint} <DocsLink topic="wsl-relay-stuck" label="Help" />.
          </p>
        )}
        {step.command && <CopyChip label="Command" value={step.command} cls="addr-chip" />}
        {step.ip && <CopyChip label="IP" value={step.ip} cls="addr-chip" />}
      </div>
    </li>
  );
}

/** The WSL checklist inside the pairing wizard; `onTurnedOff` runs after the route is cleared. */
export function WslRelaySteps({
  onTurnedOff,
}: Readonly<{ onTurnedOff: () => void }>): preact.JSX.Element | null {
  const s = useStore((st) => st.wslRelay);
  const action = useAsyncAction();
  const stuck = useStuck(s?.state);
  if (!s?.supported) return null;
  const turnOff = (): Promise<void> =>
    action.run(async () => {
      const next = await postJson<PairingRouteStatus>('/api/pairing-route', { route: 'none' });
      patch({ pairingRoute: next });
      onTurnedOff();
    }, 'Could not reach DeckBridge.');
  return (
    <div class="wsl-card" id="wsl-relay-card">
      <ol class="help-steps">
        {wslRelaySteps(s, stuck).map((step, i) => (
          <StepRow key={step.title} step={step} n={i + 1} />
        ))}
      </ol>
      <div class="addr-row">
        {wslRelayFailed(s) && (
          <GhostButton disabled={action.busy} onClick={() => post(action, '/recheck')}>
            Check again
          </GhostButton>
        )}
        <GhostButton disabled={action.busy} onClick={turnOff}>
          Turn off
        </GhostButton>
        <DocsLink topic="wsl-relay" label="Help" />
      </div>
      <Feedback error={action.error} status={null} />
    </div>
  );
}

/** "via relay · <ip> Copy" in the ready screen's status row, for any relay route. */
export function WslReadyLine(): preact.JSX.Element | null {
  const s = useStore((st) => st.pairingRoute);
  const { status, copy } = useCopyText();
  if (!s?.supported || !isRelayRoute(s.route) || !s.relayIp) return null;
  const ip = s.relayIp;
  return (
    <span class="ready-status-device wsl-ready">
      via relay · {ip}{' '}
      <button class="linkbtn accent" type="button" onClick={() => void copy(ip)}>
        {status === 'copied' ? 'Copied' : 'Copy'}
      </button>
    </span>
  );
}
