import { useEffect, useRef, useState } from 'preact/hooks';
import type {
  SurveyAnswers,
  SurveyDefinition,
  SurveyPayload,
  SurveySendResult,
} from '../../contract-survey.js';
import { Modal } from '../components/Modal.js';
import { Collapsible } from '../components/Collapsible.js';
import { GhostButton } from '../components/GhostButton.js';
import { postJson } from '../lib/ui-api.js';
import {
  LimitedText,
  QuestionStep,
  ReviewList,
  SurveyProgress,
  SurveyThanks,
} from './survey-steps.js';

const UNSENT: Record<NonNullable<SurveySendResult['reason']>, string> = {
  mock: 'Not sent: mock mode never sends feedback.',
  offline: 'Not sent: connection failed. Your answers are kept for retry during this session.',
  'no-curl': 'Not sent: curl is unavailable. Your answers are kept for retry during this session.',
  rejected:
    'Not sent: response rejected or device context changed. Retry after reviewing the updated preview.',
};

function surveyPayload(
  definition: SurveyDefinition,
  answers: SurveyAnswers,
  drafts: Record<string, string>,
  comment: string,
): SurveyPayload {
  // A draft survives Back, but is sent only while 'other' is still picked.
  const other = (id: string): string =>
    answers[id]?.includes('other') ? (drafts[id] ?? '').trim() : '';
  const useForOther = other('use-for');
  const wantOther = other('want');
  return {
    sv: definition.sv,
    ...definition.context,
    a: answers,
    ...(comment.trim() ? { c: comment.trim() } : {}),
    ...(useForOther ? { useForOther } : {}),
    ...(wantOther ? { wantOther } : {}),
  };
}

function stepTitle({ questions }: SurveyDefinition, step: number): string {
  if (step === questions.length) return 'Anything else?';
  return questions[step]?.label ?? 'Review your feedback';
}

export function SurveyModal({
  definition,
  open,
  onClose,
  onSent,
  onRefresh,
}: Readonly<{
  definition: SurveyDefinition;
  open: boolean;
  onClose: () => void;
  onSent: () => void;
  onRefresh: () => Promise<void>;
}>): preact.JSX.Element | null {
  const [answers, setAnswers] = useState<SurveyAnswers>(() => ({ ...definition.prefill }));
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [comment, setComment] = useState('');
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [message, setMessage] = useState('');
  const headingRef = useRef<HTMLHeadingElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const count = definition.questions.length;
  const question = definition.questions[step];
  const review = !sent && step === count + 1;
  const payload = surveyPayload(definition, answers, drafts, comment);

  useEffect(
    function focusQuestion() {
      if (open) {
        headingRef.current?.focus({ preventScroll: true });
        if (bodyRef.current) bodyRef.current.scrollTop = 0;
      }
      return () => clearTimeout(timerRef.current);
    },
    [step, open, sent],
  );

  useEffect(
    function revealSendError() {
      if (message && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    },
    [message],
  );

  const move = (next: number): void => {
    clearTimeout(timerRef.current);
    setStep(next);
  };
  const answer = (id: string, value?: string | string[], advance = false): void => {
    clearTimeout(timerRef.current);
    setAnswers((old) => {
      const next = { ...old };
      if (value?.length) next[id] = value;
      else delete next[id];
      return next;
    });
    if (advance) timerRef.current = setTimeout(() => setStep((old) => old + 1), 300);
  };
  const skip = (): void => {
    if (question) answer(question.id);
    else setComment('');
    move(step + 1);
  };
  const send = async (): Promise<void> => {
    setBusy(true);
    setMessage('');
    try {
      const result = await postJson<SurveySendResult>('/api/survey', payload, 'Send failed');
      if (result.sent) {
        setSent(true);
        onSent();
      } else {
        setMessage(UNSENT[result.reason ?? 'offline']);
        if (result.reason === 'rejected') await onRefresh();
      }
    } catch {
      setMessage(UNSENT.offline);
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;
  return (
    <Modal
      id="survey-modal"
      class="survey"
      title="Quick feedback"
      titleId="survey-title"
      onClose={onClose}
    >
      {!sent && <p class="survey-intro">A few taps to help shape what comes next.</p>}
      {!sent && <SurveyProgress step={step} total={count + 2} />}
      <div class="survey-body" ref={bodyRef}>
        <h3 class="survey-q" ref={headingRef} tabIndex={-1}>
          {sent ? 'Thanks for your feedback!' : stepTitle(definition, step)}
        </h3>
        {sent && <SurveyThanks />}
        {question && (
          <QuestionStep
            key={question.id}
            question={question}
            value={answers[question.id]}
            draft={drafts[question.id]}
            onChange={(value, advance) => answer(question.id, value, advance)}
            onDraft={(text) => setDrafts((old) => ({ ...old, [question.id]: text }))}
          />
        )}
        {step === count && (
          <>
            <p class="survey-hint">Anything we missed? Small ideas welcome.</p>
            <LimitedText
              label="Anything else?"
              placeholder="An idea, a rough edge, or something you love…"
              max={280}
              multiline
              value={comment}
              onInput={setComment}
            />
          </>
        )}
        {review && (
          <>
            <p class="survey-hint">Ready when you are. Edit anything before sending.</p>
            <ReviewList
              questions={definition.questions}
              answers={answers}
              others={{ 'use-for': payload.useForOther, want: payload.wantOther }}
              comment={comment}
              busy={busy}
              onEdit={move}
            />
            <p class="multi-deck-note">
              Nothing leaves your machine before Send. Responses are stored individually without IP
              or install ID.
            </p>
            <Collapsible title="What gets sent">
              <pre class="settings-json-preview panel-inset" id="survey-preview">
                {JSON.stringify(payload, null, 2)}
              </pre>
            </Collapsible>
            {message && (
              <p role="status" class="settings-error">
                {message}
              </p>
            )}
          </>
        )}
      </div>
      {!sent && (
        <div class="settings-actions survey-nav">
          <GhostButton disabled={step === 0 || busy} onClick={() => move(step - 1)}>
            Back
          </GhostButton>
          <span class="grow" />
          {review ? (
            <>
              <GhostButton disabled={busy} onClick={onClose}>
                Don't send
              </GhostButton>
              <button
                class="ctabtn primary"
                type="button"
                disabled={busy}
                onClick={() => void send()}
              >
                {busy ? 'Sending…' : 'Send'}
              </button>
            </>
          ) : (
            <>
              <GhostButton onClick={skip}>Skip</GhostButton>
              <GhostButton class="survey-next" onClick={() => move(step + 1)}>
                Next ›
              </GhostButton>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
