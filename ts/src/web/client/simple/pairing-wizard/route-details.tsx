// Relay health and commands in the Settings pairing row. Mounted only while the row is open,
// so a closed row fetches no probe and no token-bearing command and keeps no timer.
import { useEffect, useState } from 'preact/hooks';
import { ChipRadioGroup } from '../../components/ChipRadioGroup.js';
import { DocsLink } from '../../components/DocsLink.js';
import { GhostButton } from '../../components/GhostButton.js';
import { StatusChip } from '../../components/StatusChip.js';
import { patch, useStore } from '../../lib/store.js';
import { getJson, postJson, useFetched } from '../../lib/ui-api.js';
import { Feedback, useAsyncAction } from '../../lib/ui-async.js';
import type {
  PairingProbe,
  PairingRouteStatus,
  RelayCommandKind,
  WslRelayStatus,
} from '../../ui-types.js';
import { CopyChip } from '../controls.js';
import { wslRelayFailed } from '../wsl-relay-steps.js';
import { KINDS, NodeHint, useRelayCommand } from './device-setup.js';
import {
  appLine,
  buildLine,
  detailsTopic,
  relayAddress,
  relayHealth,
  relayProblem,
  seenAgo,
  uninstallCommand,
} from './route-details-model.js';
import { ORBSTACK_MACHINE, orbstackCommands } from './vm-commands.js';

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(
    function tickClock() {
      const id = setInterval(function tick() {
        setNow(Date.now());
      }, intervalMs);
      return function stopClock() {
        clearInterval(id);
      };
    },
    [intervalMs],
  );
  return now;
}

function targetText(probe: PairingProbe | null): string {
  if (probe === null) return '…';
  return probe.lanIp === '' ? 'No LAN address' : `${probe.lanIp}:${probe.coraPort}`;
}

function Row({
  label,
  children,
}: Readonly<{ label: string; children: preact.ComponentChildren }>): preact.JSX.Element {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

function ScriptCommands({
  route,
  probe,
}: Readonly<{
  route: PairingRouteStatus['route'];
  probe: PairingProbe | null;
}>): preact.JSX.Element {
  const [kind, setKind] = useState<RelayCommandKind>('curl');
  const isContainer = route === 'container';
  const fixed = isContainer ? 'container' : kind;
  const run = useRelayCommand(route === 'orbstack' ? 'curl' : fixed);
  if (route === 'orbstack') {
    const orbRun = orbstackCommands(probe, run)?.run ?? null;
    return (
      <div class="addr-row">
        <CopyChip label="Run" value={orbRun ?? ''} cls="addr-chip" pending={orbRun === null} />
        <CopyChip label="Remove" value={`orb delete ${ORBSTACK_MACHINE}`} cls="addr-chip" />
      </div>
    );
  }
  const uninstall = uninstallCommand(run);
  return (
    <>
      {!isContainer && (
        <ChipRadioGroup
          name="prd-kind"
          label="Download tool"
          value={kind}
          options={KINDS}
          onChange={setKind}
        />
      )}
      <NodeHint kind={kind} />
      <div class="addr-row">
        <CopyChip label="Run" value={run ?? ''} cls="addr-chip" pending={run === null} />
        <CopyChip
          label="Uninstall"
          value={uninstall ?? ''}
          cls="addr-chip"
          pending={uninstall === null}
        />
        {isContainer && (
          <CopyChip label="Logs" value="container logs -f deckbridge-relay" cls="addr-chip" />
        )}
      </div>
      <p class="step-sub">Without automatic start, run this again after a restart.</p>
    </>
  );
}

function WslNotes({ wsl }: Readonly<{ wsl: WslRelayStatus | null }>): preact.JSX.Element {
  return (
    <>
      {wsl !== null && wslRelayFailed(wsl) && wsl.detail != null && (
        <p class="warnrow" id="prd-problem">
          {wsl.detail}
        </p>
      )}
      {wsl?.ipChanged === true && (
        <p class="warnrow" id="prd-ip-changed">
          The WSL IP changed. Update the Network Dock IP in the Stream Deck app.
        </p>
      )}
      {wsl?.fixCommand != null && (
        <div class="addr-row">
          <CopyChip label="Fix" value={wsl.fixCommand} cls="addr-chip" />
        </div>
      )}
    </>
  );
}

export function RouteDetails({
  status,
}: Readonly<{ status: PairingRouteStatus }>): preact.JSX.Element {
  const wsl = useStore((s) => s.wslRelay);
  const remoteAddr = useStore((s) => s.status.elgatoRemoteAddr);
  const probe = useFetched<PairingProbe>('/api/pairing-route/probe');
  const now = useNow(10_000);
  const action = useAsyncAction();
  const isWsl = status.route === 'wsl';
  const health = relayHealth(status, wsl);
  const addr = relayAddress(status, wsl);
  const at = status.relay?.at ?? null;
  // A heartbeat can be newer than the last tick; that is not clock skew.
  const seen = seenAgo(at, Math.max(now, at ?? now));
  const build = buildLine(status.relay);
  const problem = relayProblem(status, __VERSION__);

  const recheck = (): Promise<void> =>
    action.run(async () => {
      if (isWsl) {
        patch({ wslRelay: await postJson<WslRelayStatus>('/api/wsl-relay/recheck') });
        return;
      }
      patch({ pairingRoute: await getJson<PairingRouteStatus>('/api/pairing-route') });
      await probe.reload();
    }, 'Could not reach DeckBridge.');

  return (
    <>
      <dl class="image-fit-sizes" id="pairing-route-details">
        <Row label="Status">
          <StatusChip id="prd-status" variant={health.variant} spin={health.spin}>
            {health.label}
          </StatusChip>
        </Row>
        {seen !== null && <Row label="Seen">{seen}</Row>}
        {isWsl && wsl?.distro != null && <Row label="Distro">{wsl.distro}</Row>}
        <Row label="Relay">
          {addr === null ? (
            'Not reported yet'
          ) : (
            <CopyChip label="IP" value={addr} cls="addr-chip" />
          )}
        </Row>
        {build !== null && <Row label="Build">{build}</Row>}
        <Row label="Target">{targetText(probe.data)}</Row>
        <dt>App</dt>
        <dd id="prd-app">{appLine(status, addr, remoteAddr)}</dd>
      </dl>
      {problem !== null && (
        <p class="warnrow" id="prd-problem">
          {problem}
        </p>
      )}
      {isWsl ? <WslNotes wsl={wsl} /> : <ScriptCommands route={status.route} probe={probe.data} />}
      <div class="addr-row">
        <GhostButton id="prd-recheck" disabled={action.busy} onClick={recheck}>
          Check again
        </GhostButton>
        <DocsLink topic={detailsTopic(status.route)} label="Help" />
      </div>
      <Feedback error={action.error} status={null} />
    </>
  );
}
