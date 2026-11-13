// "Fix pairing" wizard for Stream Deck app 7.6.1 (issue #257). Frame copied from the verify
// wizard; flow.ts decides the screens, screens.tsx draws them.
import { useState } from 'preact/hooks';
import { GhostButton } from '../../components/GhostButton.js';
import { Modal } from '../../components/Modal.js';
import { patch, useStore } from '../../lib/store.js';
import { fire, postJson, useFetched } from '../../lib/ui-api.js';
import { Feedback, useAsyncAction } from '../../lib/ui-async.js';
import type { PairingProbe, PairingRouteStatus } from '../../ui-types.js';
import { screens, versionDefault, type Answers } from './flow.js';
import { ScreenView } from './screens.js';

/** Whether the screen has what Next needs; screens without a question always do. */
function answered(id: string, a: Answers): boolean {
  switch (id) {
    case 'version':
      return a.version !== undefined;
    case 'where':
      return a.where !== undefined;
    case 'device':
      return a.otherDevice !== undefined;
    case 'choose':
      return a.route !== undefined && a.route !== 'none';
    default:
      return true;
  }
}

/** A route already set reopens at its setup screen; `restart` and a fresh start begin at the top. */
function initial(
  status: PairingRouteStatus | null,
  restart: boolean,
): { answers: Answers; idx: number } {
  if (!restart && status !== null && status.route !== 'none') {
    const answers: Answers = {
      version: 'new',
      where: 'here',
      otherDevice: status.route === 'device',
      route: status.route,
    };
    return { answers, idx: screens(answers).indexOf('setup') };
  }
  const version = versionDefault(status?.elgatoVersion ?? null);
  return { answers: version === undefined ? {} : { version }, idx: 0 };
}

export function PairingWizard({
  restart,
  onClose,
  onHelp,
}: Readonly<{
  restart: boolean;
  onClose: () => void;
  onHelp: (id: string) => void;
}>): preact.JSX.Element {
  const status = useStore((s) => s.pairingRoute);
  const probe = useFetched<PairingProbe>('/api/pairing-route/probe');
  const [start] = useState(() => initial(status, restart));
  const [answers, setAnswers] = useState<Answers>(start.answers);
  const [idx, setIdx] = useState(start.idx);
  const action = useAsyncAction();
  const list = screens(answers);
  const at = Math.min(idx, list.length - 1);
  const id = list[at]!;
  const final = at === list.length - 1 && answered(id, answers);

  const set = (change: Partial<Answers>): void => {
    action.reset();
    setAnswers((prev) => ({ ...prev, ...change }));
  };
  // Any close counts as seen, so a later "Turn off relay" doesn't auto-reopen it; the optimistic
  // patch stops an auto-reopen race.
  const close = (): void => {
    if (status && !status.wizardDismissed) {
      patch({ pairingRoute: { ...status, wizardDismissed: true } });
      fire('/api/pairing-route/dismiss');
    }
    onClose();
  };
  const next = (): Promise<void> =>
    action.run(async () => {
      if (id === 'choose' && answers.route !== status?.route) {
        patch({
          pairingRoute: await postJson<PairingRouteStatus>('/api/pairing-route', {
            route: answers.route,
          }),
        });
      }
      setIdx(at + 1);
    }, 'Could not reach DeckBridge.');
  const turnedOff = (): void => {
    setAnswers((prev) => ({ ...prev, route: undefined }));
    setIdx(screens({ ...answers, route: undefined }).indexOf('choose'));
  };

  return (
    <Modal
      id="pairing-wizard"
      class="survey"
      title="Fix pairing"
      titleId="pw-title"
      onClose={close}
    >
      <label class="survey-progress">
        Step {at + 1} of {list.length}
        <progress value={at + 1} max={list.length} />
      </label>
      <fieldset class="survey-body verify-body" disabled={action.busy}>
        <ScreenView
          id={id}
          answers={answers}
          set={set}
          probe={probe}
          detected={status?.elgatoVersion ?? null}
          onHelp={(helpId) => {
            close();
            onHelp(helpId);
          }}
          onTurnedOff={turnedOff}
        />
        <Feedback error={action.error} status={null} />
      </fieldset>
      <div class="settings-actions survey-nav">
        <GhostButton id="pw-back" disabled={action.busy || at === 0} onClick={() => setIdx(at - 1)}>
          Back
        </GhostButton>
        <span class="grow" />
        <GhostButton id="pw-cancel" onClick={close}>
          {final ? 'Done' : 'Cancel'}
        </GhostButton>
        {!final && (
          <button
            class="ctabtn primary"
            id="pw-next"
            type="button"
            disabled={action.busy || !answered(id, answers)}
            onClick={() => void next()}
          >
            Next
          </button>
        )}
      </div>
    </Modal>
  );
}
