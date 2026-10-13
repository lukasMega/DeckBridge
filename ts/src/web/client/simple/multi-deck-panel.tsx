// Settings-page block for the multi-deck opt-in. DeckBridge runs a single deck
// by default and stops scanning USB once it is connected; this turns on a second
// dock (and the 3 s discovery tick that finds it). With more decks plugged in than
// may run, it also lists them so the user picks which ones.
import { useEffect, useState } from 'preact/hooks';
import type { DetectedDecksView } from '../../contract-decks.js';
import { Collapsible } from '../components/Collapsible.js';
import { CheckField, ToggleRow } from '../components/Fields.js';
import { getJson, postJson } from '../lib/ui-api.js';
import { DocsLink } from '../components/DocsLink.js';
import { Feedback, useAsyncAction, useServerToggle } from '../lib/ui-async.js';
import { PairingAddressLink } from './pairing-address-modal.js';

const POLL_MS = 3000;

/** What the picker shows as ticked: the saved choice while it names a deck we can see,
 *  else the decks running now (the "first found" default). */
function tickedKeys(view: DetectedDecksView): string[] {
  const seen = new Set(view.decks.map((d) => d.key));
  return view.selected.some((k) => seen.has(k))
    ? view.selected
    : view.decks.filter((d) => d.active).map((d) => d.key);
}

function DeckPicker(): preact.JSX.Element | null {
  const [view, setView] = useState<DetectedDecksView | null>(null);
  const action = useAsyncAction();

  useEffect(function pollDecks() {
    const ctrl = new AbortController();
    const load = (): void => {
      getJson<DetectedDecksView>('/api/detected-decks', ctrl.signal)
        .then(setView)
        .catch(() => undefined);
    };
    load();
    const timer = setInterval(load, POLL_MS);
    return function stopPolling() {
      clearInterval(timer);
      ctrl.abort();
    };
  }, []);

  if (!view || view.decks.length === 0) return null;
  const ticked = tickedKeys(view);
  const toggle = (key: string, on: boolean): Promise<void> =>
    action.run(async () => {
      const keys = on ? [...ticked, key] : ticked.filter((k) => k !== key);
      await postJson('/api/active-decks', { keys });
      setView({ ...view, selected: keys });
    });

  return (
    <>
      <p class="multi-deck-note">
        {view.decks.length} detected. Choose up to {view.max} to run.
      </p>
      {view.decks.map((d) => (
        <CheckField
          key={d.key}
          label={d.serial ? `${d.name} (${d.serial})` : d.name}
          checked={ticked.includes(d.key)}
          disabled={action.busy || (!ticked.includes(d.key) && ticked.length >= view.max)}
          onChange={(on) => void toggle(d.key, on)}
        />
      ))}
      <Feedback error={action.error} status={action.status} />
    </>
  );
}

/** `enabled` null = the settings page hasn't read /api/state yet, same contract as
 *  DiagnosticsPanel's logLevel. */
export function MultiDeckPanel({
  enabled,
}: Readonly<{ enabled: boolean | null }>): preact.JSX.Element {
  const { value, action, toggle } = useServerToggle('/api/multi-deck', enabled, (next) =>
    next
      ? 'Multiple decks on — plug in a second deck and it appears as its own dock.'
      : 'Multiple decks off — only one deck is used.',
  );

  return (
    <Collapsible title="Multiple decks" bodyId="multi-deck-body" status={value}>
      <ToggleRow
        id="toggle-multi-deck"
        label="Use two decks"
        checked={value ?? false}
        onChange={(next) => void toggle(next)}
      >
        <DocsLink topic="multi-deck" />
      </ToggleRow>
      <p class="multi-deck-note">Disconnects second deck. Settings stay saved.</p>
      <Feedback error={action.error} status={action.status} />
      {value === true && <DeckPicker />}
      <PairingAddressLink />
    </Collapsible>
  );
}
