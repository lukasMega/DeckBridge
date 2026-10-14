import { useEffect, useRef, useState } from 'preact/hooks';
import type { SurveyAnswers, SurveyDefinition, SurveyPayload } from '../../contract-survey.js';
import { Modal } from '../components/Modal.js';
import { Collapsible } from '../components/Collapsible.js';
import { GhostButton } from '../components/GhostButton.js';
import { UNSENT, submitSurvey } from './survey-send.js';
import { clearSurveyDraft, loadSurveyDraft, saveSurveyDraft } from './survey-draft.js';
import {
  LimitedText,
  QuestionStep,
  ReviewList,
  SurveyProgress,
  SurveyThanks,
} from './survey-steps.js';

// Question id -> payload field of its required Other description.
const OTHER_FIELDS = {
  found: 'foundOther',
  'use-for': 'useForOther',
  pain: 'painOther',
  want: 'wantOther',
  support: 'supportOther',
} as const;
type OtherField = (typeof OTHER_FIELDS)[keyof typeof OTHER_FIELDS];

function surveyPayload(
  definition: SurveyDefinition,
  answers: SurveyAnswers,
  drafts: Record<string, string>,
  comment: string,
): SurveyPayload {
  const details: Partial<Record<OtherField, string>> = {};
  for (const [id, field] of Object.entries(OTHER_FIELDS)) {
    // A draft survives Back, but is sent only while 'other' is still picked.
    const text = picksOther(answers[id]) ? (drafts[id] ?? '').trim() : '';
    if (text) details[field] = text;
  }
  return {
    sv: definition.sv,
    ...definition.context,
    q: definition.questions.map((q) => q.id),
    a: answers,
    ...(comment.trim() ? { c: comment.trim() } : {}),
    ...details,
  };
}

// Exact match: a single answer is a string, and `search-other` must not count.
function picksOther(answer: string | string[] | undefined): boolean {
  return [answer].flat().includes('other');
}

/** A banner face tap lands after `rating`; a saved draft is merged in, never overwritten. */
function startState(definition: SurveyDefinition, rating: string | undefined) {
  const saved = loadSurveyDraft(definition);
  if (rating === undefined)
    return {
      saved,
      step: 0,
      answers: { ...definition.prefill },
      drafts: {} as Record<string, string>,
      comment: '',
    };
  const next = definition.questions.findIndex((q) => q.id === 'rating') + 1;
  return {
    saved: null,
    step: Math.max(saved?.step ?? 0, next),
    answers: {
      ...(saved?.answers.features ? {} : definition.prefill),
      ...saved?.answers,
      rating,
    },
    drafts: saved?.drafts ?? {},
    comment: saved?.comment ?? '',
  };
}

function missingDetailIds(answers: SurveyAnswers, drafts: Record<string, string>): string[] {
  return Object.keys(OTHER_FIELDS).filter((id) => picksOther(answers[id]) && !drafts[id]?.trim());
}

function stepTitle({ questions }: SurveyDefinition, step: number): string {
  if (step === questions.length) return 'Anything else?';
  return questions[step]?.label ?? 'Review your feedback';
}

function ResumeCard({
  onResume,
  onStartOver,
}: Readonly<{ onResume: () => void; onStartOver: () => void }>): preact.JSX.Element {
  return (
    <div class="survey-invite survey-resume">
      <div>
        <strong>Continue your unfinished feedback?</strong>
        <br />
        <small>Your answers are saved on this device.</small>
      </div>
      <div class="settings-actions survey-nav">
        <button class="ctabtn primary" type="button" onClick={onResume}>
          Continue
        </button>
        <GhostButton onClick={onStartOver}>Start over</GhostButton>
      </div>
    </div>
  );
}

function CommentStep({
  value,
  onInput,
}: Readonly<{ value: string; onInput: (text: string) => void }>): preact.JSX.Element {
  return (
    <>
      <p class="survey-hint">Anything we missed? Small ideas welcome.</p>
      <LimitedText
        label="Anything else?"
        placeholder="An idea, a rough edge, or something you love…"
        max={280}
        multiline
        value={value}
        onInput={onInput}
      />
    </>
  );
}

function ReviewStep({
  definition,
  answers,
  comment,
  busy,
  message,
  payload,
  onEdit,
}: Readonly<{
  definition: SurveyDefinition;
  answers: SurveyAnswers;
  comment: string;
  busy: boolean;
  message: string;
  payload: SurveyPayload;
  onEdit: (step: number) => void;
}>): preact.JSX.Element {
  return (
    <>
      <p class="survey-hint">Ready when you are. Edit anything before sending.</p>
      <ReviewList
        questions={definition.questions}
        answers={answers}
        others={Object.fromEntries(
          Object.entries(OTHER_FIELDS).map(([id, field]) => [id, payload[field]]),
        )}
        comment={comment}
        busy={busy}
        onEdit={onEdit}
      />
      <p class="multi-deck-note">
        Nothing leaves your machine before Send. Responses are stored individually without IP or
        install ID.
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
  );
}

function SurveyNav({
  review,
  busy,
  backDisabled,
  nextDisabled,
  sendDisabled,
  onBack,
  onNext,
  onSkip,
  onClose,
  onSend,
}: Readonly<{
  review: boolean;
  busy: boolean;
  backDisabled: boolean;
  nextDisabled: boolean;
  sendDisabled: boolean;
  onBack: () => void;
  onNext: () => void;
  onSkip: () => void;
  onClose: () => void;
  onSend: () => void;
}>): preact.JSX.Element {
  return (
    <div class="settings-actions survey-nav">
      <GhostButton disabled={backDisabled || busy} onClick={onBack}>
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
            disabled={busy || sendDisabled}
            onClick={onSend}
          >
            {busy ? 'Sending…' : 'Send'}
          </button>
        </>
      ) : (
        <>
          <GhostButton onClick={onSkip}>Skip</GhostButton>
          <GhostButton class="survey-next" disabled={nextDisabled} onClick={onNext}>
            Next ›
          </GhostButton>
        </>
      )}
    </div>
  );
}

export function SurveyModal({
  definition,
  open,
  initialRating,
  onClose,
  onSent,
  onRefresh,
}: Readonly<{
  definition: SurveyDefinition;
  open: boolean;
  /** Rating picked in the banner; used on mount only. */
  initialRating?: string;
  /** Gets the answers so far, so an unsent close can prefill the short form. */
  onClose: (answers: SurveyAnswers, sent: boolean) => void;
  onSent: () => void;
  onRefresh: () => Promise<void>;
}>): preact.JSX.Element | null {
  const [start] = useState(() => startState(definition, initialRating));
  const [answers, setAnswers] = useState<SurveyAnswers>(start.answers);
  const [drafts, setDrafts] = useState<Record<string, string>>(start.drafts);
  const [comment, setComment] = useState(start.comment);
  const [step, setStep] = useState(start.step);
  const [saved, setSaved] = useState(start.saved);
  const [touched, setTouched] = useState(initialRating !== undefined);
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
  const missingDetails = missingDetailIds(answers, drafts);

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
    function persistDraft() {
      // A pending saved draft stays untouched until the user picks Continue or Start over.
      if (touched && !sent && !saved)
        saveSurveyDraft({ sv: definition.sv, step, answers, drafts, comment });
    },
    [touched, sent, saved, definition.sv, step, answers, drafts, comment],
  );

  useEffect(
    function revealSendError() {
      if (message && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    },
    [message],
  );

  const move = (next: number): void => {
    clearTimeout(timerRef.current);
    setTouched(true);
    setStep(next);
  };
  const resume = (): void => {
    if (!saved) return;
    // The user's own features choice beats a fresh prefill.
    setAnswers({ ...(saved.answers.features ? {} : definition.prefill), ...saved.answers });
    setDrafts(saved.drafts);
    setComment(saved.comment);
    setStep(saved.step);
    setTouched(true);
    setSaved(null);
  };
  const startOver = (): void => {
    clearSurveyDraft();
    setSaved(null);
  };
  const answer = (id: string, value?: string | string[], advance = false): void => {
    clearTimeout(timerRef.current);
    setTouched(true);
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
  const close = (): void => onClose({ ...saved?.answers, ...answers }, sent);

  if (!open) return null;
  return (
    <Modal
      id="survey-modal"
      class="survey"
      title="Quick feedback"
      titleId="survey-title"
      onClose={close}
    >
      {!sent && (
        <>
          <p class="survey-intro">A few taps to help shape what comes next.</p>
          <SurveyProgress step={step} total={count + 2} />
        </>
      )}
      <div class="survey-body" ref={bodyRef}>
        {!sent && saved && <ResumeCard onResume={resume} onStartOver={startOver} />}
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
            onDraft={(text) => {
              setTouched(true);
              setDrafts((old) => ({ ...old, [question.id]: text }));
            }}
          />
        )}
        {step === count && (
          <CommentStep
            value={comment}
            onInput={(text) => {
              setTouched(true);
              setComment(text);
            }}
          />
        )}
        {review && (
          <ReviewStep
            definition={definition}
            answers={answers}
            comment={comment}
            busy={busy}
            message={message}
            payload={payload}
            onEdit={move}
          />
        )}
      </div>
      {!sent && (
        <SurveyNav
          review={review}
          busy={busy}
          backDisabled={step === 0}
          nextDisabled={missingDetails.includes(question?.id ?? '')}
          sendDisabled={missingDetails.length > 0}
          onBack={() => move(step - 1)}
          onNext={() => move(step + 1)}
          onSkip={skip}
          onClose={close}
          onSend={() => void send()}
        />
      )}
    </Modal>
  );
}
