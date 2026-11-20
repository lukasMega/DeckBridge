// "Relay on another device" setup screen (issue #257): one pasted command, then live progress from
// the relay script. The script's events arrive as `pairingRoute.relay` over the WebSocket.
import { useState } from 'preact/hooks';
import { ChipRadioGroup } from '../../components/ChipRadioGroup.js';
import { ICON } from '../../components/Icon.js';
import { StatusChip } from '../../components/StatusChip.js';
import { useStore } from '../../lib/store.js';
import { useFetched } from '../../lib/ui-api.js';
import type {
  PairingProbe,
  RelayCommandKind,
  RelayCommandResponse,
  RelayProgress,
} from '../../ui-types.js';
import { CopyChip } from '../controls.js';

export const KINDS = [
  { value: 'curl', label: 'curl' },
  { value: 'wget', label: 'wget' },
] as const;

/** The install command with its token; null until the server answers (or no script route is on). */
export function useRelayCommand(kind: RelayCommandKind): string | null {
  return (
    useFetched<RelayCommandResponse>(`/api/pairing-route/command?kind=${kind}`).data?.command ??
    null
  );
}

const STEPS = ['Downloading', 'Initializing', 'Connecting'] as const;
const STAGE_INDEX = { downloading: 0, installing: 1, starting: 2, running: 3 } as const;

function Steps({ relay }: Readonly<{ relay: RelayProgress | null }>): preact.JSX.Element {
  const at =
    relay !== null && relay.stage in STAGE_INDEX
      ? STAGE_INDEX[relay.stage as keyof typeof STAGE_INDEX]
      : -1;
  const chip = (i: number, label: string): preact.JSX.Element => {
    if (i < at || (i === 3 && at === 3)) {
      return (
        <StatusChip variant="ok" icon={ICON.check}>
          {i === 3 ? `Connected on ${relay?.ip ?? ''}` : label}
        </StatusChip>
      );
    }
    if (i === at) {
      return (
        <StatusChip variant="wait" spin>
          {label}
        </StatusChip>
      );
    }
    return <StatusChip variant="dim">{i === 3 ? 'Connected' : label}</StatusChip>;
  };
  return (
    <ol class="help-steps" id="pw-progress">
      {[...STEPS, 'Connected'].map((label, i) => (
        <li key={label}>{chip(i, label)}</li>
      ))}
    </ol>
  );
}

/** Version mismatch, failure or silence: what the user should do about it. */
function Problem({
  relay,
  mismatch,
}: Readonly<{
  relay: RelayProgress | null;
  mismatch: boolean;
}>): preact.JSX.Element | null {
  if (relay?.stage === 'failed') {
    return (
      <p class="warnrow" id="pw-failed">
        {relay.message ?? 'Install failed.'} Run the command again.
      </p>
    );
  }
  if (relay?.stage === 'offline') {
    return (
      <p class="warnrow" id="pw-offline">
        Relay offline. Check the device or run the command again.
      </p>
    );
  }
  if (mismatch && relay !== null) {
    return (
      <p class="warnrow" id="pw-mismatch">
        The relay runs version {relay.version}, DeckBridge runs {__VERSION__}. Run the command
        again.
      </p>
    );
  }
  return null;
}

export function DeviceSetupBody({
  probe,
}: Readonly<{ probe: PairingProbe | null }>): preact.JSX.Element {
  const [kind, setKind] = useState<RelayCommandKind>('curl');
  const command = useRelayCommand(kind);
  const relay = useStore((s) => s.pairingRoute?.relay ?? null);
  const mismatch = useStore((s) => s.pairingRoute?.versionMismatch === true);
  const manual =
    probe === null
      ? ''
      : `deckbridge relay --target ${probe.lanIp} --target-port ${probe.coraPort} --no-advertise`;
  return (
    <>
      <p>On the other device (Linux or Mac), open a terminal and run:</p>
      <ChipRadioGroup
        name="pw-kind"
        label="Download tool"
        value={kind}
        options={KINDS}
        onChange={setKind}
      />
      <div class="addr-row">
        <CopyChip
          label="Command"
          value={command ?? ''}
          cls="addr-chip"
          pending={command === null}
        />
      </div>
      <p class="step-sub">
        It downloads and checks DeckBridge, then starts the relay. Keep the terminal open. A
        Raspberry Pi needs 64-bit Raspberry Pi OS Trixie.
      </p>
      <Steps relay={relay} />
      <Problem relay={relay} mismatch={mismatch} />
      <details>
        <summary>Windows PC? Use the manual command</summary>
        <p class="step-sub">Download DeckBridge for Windows from GitHub releases and run:</p>
        <div class="addr-row">
          <CopyChip label="Command" value={manual} cls="addr-chip" pending={probe === null} />
        </div>
      </details>
    </>
  );
}
