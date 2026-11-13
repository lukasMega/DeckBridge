// Device → DeckBridge → app status row. Shape (check / spinner / ring) carries the
// state as well as colour; the visually-hidden word is for assistive tech.
import { ICON, Icon } from './Icon.js';

export type PathState = 'done' | 'active' | 'pending';

const STATE_WORD: Record<PathState, string> = {
  done: 'connected',
  active: 'waiting',
  pending: 'not yet',
};

function PathIcon({ state }: Readonly<{ state: PathState }>): preact.JSX.Element {
  if (state === 'done') return <Icon class="ico-done circle" html={ICON.check} />;
  return <span class={state === 'active' ? 'ico-spin' : 'ico-pending'} />;
}

export function ConnectionPath({
  device,
  app,
  deviceName,
}: Readonly<{ device: PathState; app: PathState; deviceName?: string }>): preact.JSX.Element {
  const nodes: Array<{ label: string; state: PathState }> = [
    { label: deviceName || 'Device', state: device },
    { label: 'DeckBridge', state: 'done' },
    { label: 'App', state: app },
  ];
  return (
    <ol class="conn-path" aria-label="Connection path">
      {nodes.map((n) => (
        <li key={n.label} class={`conn-node ${n.state}`}>
          <span class="step-ico">
            <PathIcon state={n.state} />
          </span>
          <span>{n.label}</span>
          <span class="visually-hidden">: {STATE_WORD[n.state]}</span>
        </li>
      ))}
    </ol>
  );
}
