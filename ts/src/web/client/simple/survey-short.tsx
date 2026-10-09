import { useState } from 'preact/hooks';
import type {
  SurveyAnswers,
  SurveyDefinition,
  SurveyPayload,
  SurveyQuestion,
} from '../../contract-survey.js';
import { Modal } from '../components/Modal.js';
import { Collapsible } from '../components/Collapsible.js';
import { GhostButton } from '../components/GhostButton.js';
import { fire } from '../lib/ui-api.js';
import { clearSurveyDraft } from './survey-draft.js';
import { UNSENT, submitSurvey } from './survey-send.js';
import { QuestionStep, SurveyThanks } from './survey-steps.js';

// No free text on this form, so a wish for "Other" cannot be described.
function shortQuestions(definition: SurveyDefinition): SurveyQuestion[] {
  return definition.short.flatMap((id) => {
    const q = definition.questions.find((item) => item.id === id);
    if (!q) return [];
    return [id === 'want' ? { ...q, options: q.options.filter((o) => o.id !== 'other') } : q];
  });
}

function seedAnswers(questions: SurveyQuestion[], seed: SurveyAnswers): SurveyAnswers {
  const answers: SurveyAnswers = {};
  for (const q of questions) {
    const value = seed[q.id];
    const kept = value === undefined ? [] : [value].flat().filter((v) => v !== 'other');
    if (kept.length) answers[q.id] = typeof value === 'string' ? kept[0]! : kept;
  }
  return answers;
}

/** Last, explicit ask: the 3 key questions on one screen, with its own Send. */
export function SurveyShort({
  definition,
  seed,
  onClose,
  onSent,
  onRefresh,
}: Readonly<{
  definition: SurveyDefinition;
  seed: SurveyAnswers;
  onClose: () => void;
  onSent: () => void;
  onRefresh: () => Promise<void>;
}>): preact.JSX.Element {
  const questions = shortQuestions(definition);
  const [answers, setAnswers] = useState<SurveyAnswers>(() => seedAnswers(questions, seed));
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [message, setMessage] = useState('');
  const complete = questions.length > 0 && questions.every((q) => answers[q.id] !== undefined);
  const payload: SurveyPayload = {
    sv: definition.sv,
    ...definition.context,
    a: answers,
    f: 'short',
  };

  const change = (id: string, value: string | string[]): void =>
    setAnswers((old) => {
      const next = { ...old };
      if (value.length) next[id] = value;
      else delete next[id];
      return next;
    });
  const send = async (): Promise<void> => {
    setBusy(true);
    setMessage('');
    const result = await submitSurvey(payload);
    if (result.sent) {
      clearSurveyDraft();
      setSent(true);
      onSent();
    } else {
      setMessage(UNSENT[result.reason ?? 'offline']);
      if (result.reason === 'rejected') await onRefresh();
    }
    setBusy(false);
  };
  // Any unsent close snoozes; the wizard draft is left alone.
  const close = (): void => {
    if (!sent) fire('/api/survey/dismiss', { never: false });
    onClose();
  };

  return (
    <Modal
      id="survey-short"
      class="survey"
      title={sent ? 'Thanks for your feedback!' : 'Before you go — 3 quick taps?'}
      titleId="survey-short-title"
      onClose={close}
    >
      {sent ? (
        <SurveyThanks />
      ) : (
        <>
          <div class="survey-body">
            {questions.map((q) => (
              <section key={q.id}>
                <h3 class="survey-q">{q.label}</h3>
                <QuestionStep
                  question={q}
                  value={answers[q.id]}
                  draft={undefined}
                  compact
                  onChange={(value) => change(q.id, value)}
                  onDraft={() => undefined}
                />
              </section>
            ))}
            <p class="multi-deck-note">
              Nothing leaves your machine before Send. Only these 3 answers are sent.
            </p>
            <Collapsible title="What gets sent">
              <pre class="settings-json-preview panel-inset" id="survey-short-preview">
                {JSON.stringify(payload, null, 2)}
              </pre>
            </Collapsible>
            {message && (
              <p role="status" class="settings-error">
                {message}
              </p>
            )}
          </div>
          <div class="settings-actions survey-nav">
            <span class="grow" />
            <GhostButton disabled={busy} onClick={close}>
              No thanks
            </GhostButton>
            <button
              class="ctabtn primary"
              type="button"
              disabled={busy || !complete}
              onClick={() => void send()}
            >
              {busy ? 'Sending…' : 'Send 3 answers'}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
