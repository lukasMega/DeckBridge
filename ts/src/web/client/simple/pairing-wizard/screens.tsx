// One component per wizard screen (flow.ts `ScreenId`). Pure views over the answers and the
// probe; the wizard frame owns navigation and the route POST.
import type { ComponentChildren } from 'preact';
import { GhostButton } from '../../components/GhostButton.js';
import { ICON } from '../../components/Icon.js';
import { StatusChip } from '../../components/StatusChip.js';
import { useStore } from '../../lib/store.js';
import type { Fetched } from '../../lib/ui-api.js';
import type { PairingProbe, PairingRoute } from '../../ui-types.js';
import { CopyChip, ManualAddPanel } from '../controls.js';
import { WslRelaySteps } from '../wsl-relay-card.js';
import type { Answers, ScreenId, VersionAnswer } from './flow.js';
import { routeOptions } from './routes.js';
import { orbstackCommands } from './vm-commands.js';

const MSI_760 = 'https://edge.elgato.com/egc/windows/sd/Stream_Deck_7.6.0.23012.msi';
const NOTES_76 =
  'https://help.elgato.com/hc/en-us/articles/51156609278737-Elgato-Stream-Deck-7-6-Release-Notes';
const RELEASES = 'https://github.com/lukasMega/DeckBridge/releases/latest';
const ORBSTACK_URL = 'https://orbstack.dev';

type SetAnswers = (patch: Partial<Answers>) => void;

function Question({ children }: Readonly<{ children: string }>): preact.JSX.Element {
  return <h3 class="survey-q">{children}</h3>;
}

function Choice({
  on,
  title,
  sub,
  onPick,
}: Readonly<{
  on: boolean;
  title: string;
  sub?: string;
  onPick: () => void;
}>): preact.JSX.Element {
  return (
    <GhostButton class="pairing-choice" aria-pressed={on} onClick={onPick}>
      <strong>
        {title}
        {on && ' ✓'}
      </strong>
      {sub && <span>{sub}</span>}
    </GhostButton>
  );
}

function ChoiceGroup({
  label,
  children,
}: Readonly<{ label: string; children: ComponentChildren }>): preact.JSX.Element {
  return (
    <div class="pairing-answers" role="group" aria-label={label}>
      {children}
    </div>
  );
}

function VersionScreen({
  answers,
  set,
  detected,
}: Readonly<{ answers: Answers; set: SetAnswers; detected: string | null }>): preact.JSX.Element {
  const pick = (version: VersionAnswer) => () => set({ version });
  return (
    <>
      <Question>Which Stream Deck app do you use?</Question>
      {detected !== null && (
        <p class="survey-hint">We found Stream Deck app {detected} on this computer.</p>
      )}
      <ChoiceGroup label="Stream Deck app version">
        <Choice on={answers.version === 'new'} title="7.6.1 or newer" onPick={pick('new')} />
        <Choice on={answers.version === 'old'} title="7.6.0 or older" onPick={pick('old')} />
        <Choice on={answers.version === 'unsure'} title="Not sure" onPick={pick('unsure')} />
      </ChoiceGroup>
      {answers.version === 'unsure' && (
        <p class="step-sub">Check in the Stream Deck app: Preferences → About.</p>
      )}
    </>
  );
}

function WhereScreen({
  answers,
  set,
}: Readonly<{ answers: Answers; set: SetAnswers }>): preact.JSX.Element {
  return (
    <>
      <Question>Where does the Stream Deck app run?</Question>
      <ChoiceGroup label="Where the Stream Deck app runs">
        <Choice
          on={answers.where === 'here'}
          title="On this computer"
          onPick={() => set({ where: 'here' })}
        />
        <Choice
          on={answers.where === 'elsewhere'}
          title="On another computer"
          onPick={() => set({ where: 'elsewhere' })}
        />
      </ChoiceGroup>
    </>
  );
}

function WhyScreen(): preact.JSX.Element {
  return (
    <>
      <Question>Why pairing fails</Question>
      <p>
        Since version 7.6.1, the Stream Deck app refuses a Network Dock on its own computer.
        DeckBridge can give your deck a second address: a small relay (about 15 MB of memory) runs
        on another device or in a small Linux system on this computer, and the Stream Deck app
        connects to the relay.
      </p>
      <pre>This computer ──▶ relay (other IP) ──▶ DeckBridge</pre>
    </>
  );
}

function DeviceScreen({
  answers,
  set,
}: Readonly<{ answers: Answers; set: SetAnswers }>): preact.JSX.Element {
  // A new answer can change which routes exist, so the old pick no longer applies.
  const pick = (otherDevice: boolean) => () => set({ otherDevice, route: undefined });
  return (
    <>
      <Question>Do you have another device on this network?</Question>
      <p class="survey-hint">
        It must stay on while you use the deck. For example a Raspberry Pi, a Linux PC, another Mac
        or Windows PC.
      </p>
      <ChoiceGroup label="Another device on this network">
        <Choice on={answers.otherDevice === true} title="Yes" onPick={pick(true)} />
        <Choice
          on={answers.otherDevice === false}
          title="No, only this computer"
          onPick={pick(false)}
        />
      </ChoiceGroup>
    </>
  );
}

function ChooseScreen({
  answers,
  set,
  probe,
}: Readonly<{
  answers: Answers;
  set: SetAnswers;
  probe: Fetched<PairingProbe>;
}>): preact.JSX.Element {
  if (probe.data === null) {
    return (
      <>
        <Question>Choose a fix</Question>
        <p class="step-sub">
          {probe.error === null ? 'Checking this computer…' : 'Could not check this computer.'}
        </p>
      </>
    );
  }
  return (
    <>
      <Question>Choose a fix</Question>
      <ChoiceGroup label="Fix">
        {routeOptions(probe.data, answers.otherDevice === true).map((o) => (
          <GhostButton
            key={o.route}
            class="pairing-choice"
            aria-pressed={answers.route === o.route}
            disabled={o.disabled}
            onClick={() => set({ route: o.route })}
          >
            <strong>
              {o.title}
              {answers.route === o.route && ' ✓'}{' '}
              {o.recommended && <StatusChip variant="accent">Recommended</StatusChip>}
            </strong>
            <span>{o.sub}</span>
            <span>
              Memory {o.cost.ram} · Disk {o.cost.disk} · Setup {o.cost.time} · {o.cost.money}
            </span>
            {o.badge !== null && <span>{o.badge}</span>}
          </GhostButton>
        ))}
      </ChoiceGroup>
    </>
  );
}

function Link({
  href,
  children,
}: Readonly<{ href: string; children: string }>): preact.JSX.Element {
  return (
    <a class="docs-link" href={href} target="_blank" rel="noopener">
      {children}
    </a>
  );
}

function DowngradeSetup({ probe }: Readonly<{ probe: PairingProbe | null }>): preact.JSX.Element {
  const win = probe === null || probe.platform === 'Windows';
  const mac = probe === null || probe.platform === 'macOS';
  return (
    <>
      <Question>Use Stream Deck app 7.6.0</Question>
      <p>
        {win && <Link href={MSI_760}>Download 7.6.0 for Windows</Link>}
        {win && mac && ' · '}
        {mac && <Link href={NOTES_76}>Elgato 7.6 release notes (download link inside)</Link>}
      </p>
      <ol class="help-steps">
        <li>Quit the Stream Deck app.</li>
        <li>Install 7.6.0 over your current version.</li>
        <li>In the Stream Deck app, open Preferences → General and turn off automatic updates.</li>
      </ol>
    </>
  );
}

function Unreachable({ title }: Readonly<{ title: string }>): preact.JSX.Element {
  return (
    <>
      <Question>{title}</Question>
      <p class="warnrow">
        No relay can reach DeckBridge: it has no network address, or it is bound to 127.0.0.1.
        Connect to a network, or remove the bind setting, then open this again.
      </p>
    </>
  );
}

function DeviceSetup({ probe }: Readonly<{ probe: PairingProbe | null }>): preact.JSX.Element {
  if (probe?.lanIp === '') return <Unreachable title="Relay on another device" />;
  const command =
    probe === null
      ? ''
      : `deckbridge relay --target ${probe.lanIp} --target-port ${probe.coraPort} --no-advertise`;
  return (
    <>
      <Question>Relay on another device</Question>
      <p>On the other device, download DeckBridge for it from the releases page and run:</p>
      <div class="addr-row">
        <CopyChip label="Command" value={command} cls="addr-chip" pending={probe === null} />
      </div>
      <p class="step-sub">
        <Link href={RELEASES}>DeckBridge releases</Link>
      </p>
      <p class="step-sub">
        A Raspberry Pi needs 64-bit Raspberry Pi OS Trixie. The relay prints its IP addresses when
        it starts.
      </p>
    </>
  );
}

function OrbstackSetup({ probe }: Readonly<{ probe: PairingProbe | null }>): preact.JSX.Element {
  const title = 'Relay in OrbStack on this Mac';
  if (probe?.lanIp === '') return <Unreachable title={title} />;
  const cmd = orbstackCommands(probe);
  const chip = (label: string, value: string | undefined): preact.JSX.Element => (
    <div class="addr-row">
      <CopyChip label={label} value={value ?? ''} cls="addr-chip" pending={cmd === null} />
    </div>
  );
  return (
    <>
      <Question>{title}</Question>
      <ol class="help-steps">
        <li>
          {probe?.mac?.orbstack === true ? (
            'OrbStack is installed.'
          ) : (
            <>
              Install OrbStack from <Link href={ORBSTACK_URL}>orbstack.dev</Link> and open it once.
            </>
          )}
        </li>
        <li>In Terminal, create a small Ubuntu machine (once): {chip('Create', cmd?.create)}</li>
        <li>
          Start the relay in it. Keep the Terminal window open while you use the deck.
          {chip('Run', cmd?.run)}
        </li>
        <li>The relay prints its IP addresses. To see the IP later, run: {chip('IP', cmd?.ip)}</li>
      </ol>
      <p class="step-sub">
        OrbStack is free for personal use; commercial use needs a paid licence.
      </p>
    </>
  );
}

function SetupScreen({
  route,
  probe,
  onTurnedOff,
}: Readonly<{
  route: PairingRoute | undefined;
  probe: PairingProbe | null;
  onTurnedOff: () => void;
}>): preact.JSX.Element | null {
  if (route === 'downgrade') return <DowngradeSetup probe={probe} />;
  if (route === 'wsl') {
    return (
      <>
        <Question>Relay in WSL on this PC</Question>
        <WslRelaySteps onTurnedOff={onTurnedOff} />
      </>
    );
  }
  if (route === 'orbstack') return <OrbstackSetup probe={probe} />;
  return route === 'device' ? <DeviceSetup probe={probe} /> : null;
}

function AddScreen({ route }: Readonly<{ route: PairingRoute | undefined }>): preact.JSX.Element {
  const paired = useStore((s) => s.pairingRoute?.paired === true);
  return (
    <>
      <Question>Add the relay in the Stream Deck app</Question>
      <p>
        In the Stream Deck app, add a Network Dock by IP address.{' '}
        {route === 'orbstack'
          ? 'Use the IP of the OrbStack machine, which the relay printed.'
          : 'Use the IP of the device that runs the relay.'}
      </p>
      {paired ? (
        <StatusChip variant="ok" icon={ICON.check}>
          Paired
        </StatusChip>
      ) : (
        <StatusChip variant="wait" spin>
          Waiting for the Stream Deck app…
        </StatusChip>
      )}
    </>
  );
}

export function ScreenView({
  id,
  answers,
  set,
  probe,
  detected,
  onHelp,
  onTurnedOff,
}: Readonly<{
  id: ScreenId;
  answers: Answers;
  set: SetAnswers;
  probe: Fetched<PairingProbe>;
  detected: string | null;
  onHelp: (helpId: string) => void;
  onTurnedOff: () => void;
}>): preact.JSX.Element | null {
  switch (id) {
    case 'version':
      return <VersionScreen answers={answers} set={set} detected={detected} />;
    case 'where':
      return <WhereScreen answers={answers} set={set} />;
    case 'why':
      return <WhyScreen />;
    case 'device':
      return <DeviceScreen answers={answers} set={set} />;
    case 'choose':
      return <ChooseScreen answers={answers} set={set} probe={probe} />;
    case 'setup':
      return <SetupScreen route={answers.route} probe={probe.data} onTurnedOff={onTurnedOff} />;
    case 'add':
      return <AddScreen route={answers.route} />;
    case 'done-old':
      return <p>No fix needed. Stream Deck app 7.6.0 and older pair with DeckBridge directly.</p>;
    case 'done-elsewhere':
      return (
        <>
          <p>No fix needed. Pair the Stream Deck app on the other computer with this address:</p>
          <ManualAddPanel onHelp={onHelp} expanded />
        </>
      );
  }
}
