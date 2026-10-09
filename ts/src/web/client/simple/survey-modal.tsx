import { useEffect, useRef, useState } from 'preact/hooks';
import type {
  SurveyAnswers,
  SurveyDefinition,
  SurveyOption,
  SurveyPayload,
  SurveyQuestion,
  SurveySendResult,
} from '../../contract-survey.js';
import { Modal } from '../components/Modal.js';
import { ChipRadioGroup } from '../components/ChipRadioGroup.js';
import { ChipCheckGroup } from '../components/ChipCheckGroup.js';
import { Collapsible } from '../components/Collapsible.js';
import { GhostButton } from '../components/GhostButton.js';
import { postJson } from '../lib/ui-api.js';

function parentOption(options: SurveyOption[], value: string): SurveyOption | undefined {
  return options.find((o) => o.id === value || o.options?.some((sub) => sub.id === value));
}

function labels(question: SurveyQuestion, value: string | string[]): string[] {
  return (Array.isArray(value) ? value : [value]).map((id) => {
    const parent = parentOption(question.options, id);
    const sub = parent?.options?.find((o) => o.id === id);
    return sub ? `${parent?.label}: ${sub.label}` : (parent?.label ?? id);
  });
}

function QuestionChips({
  question: q,
  value,
  onChange,
}: Readonly<{
  question: SurveyQuestion;
  value: string | string[] | undefined;
  onChange: (value: string | string[], advance: boolean) => void;
}>): preact.JSX.Element {
  const singlePick = typeof value === 'string' ? [value] : [];
  const picks = Array.isArray(value) ? value : singlePick;
  const parents = picks.map((id) => parentOption(q.options, id)?.id ?? id);
  const chipOptions = q.options.map((o) => ({
    value: o.id,
    label: o.label,
    disabled:
      q.kind === 'multi' &&
      !!q.max &&
      picks.length >= q.max &&
      !parents.includes(o.id) &&
      o.id !== q.exclusive,
  }));
  const choose = (id: string): void => {
    if (q.kind === 'single') {
      onChange(id, !parentOption(q.options, id)?.options);
      return;
    }
    if (parents.includes(id)) {
      onChange(
        picks.filter((v) => parentOption(q.options, v)?.id !== id),
        false,
      );
      return;
    }
    const next = picks.filter((v) => v !== q.exclusive);
    onChange(id === q.exclusive ? [id] : [...next, id], false);
  };
  const subParents = q.options.filter((o) => o.options && parents.includes(o.id));
  return (
    <>
      {q.kind === 'single' ? (
        <ChipRadioGroup
          name={`survey-${q.id}`}
          label={q.label}
          value={parents[0] ?? ''}
          options={chipOptions}
          class={q.faces ? 'survey-faces' : undefined}
          onChange={choose}
        />
      ) : (
        <ChipCheckGroup
          name={`survey-${q.id}`}
          label={q.label}
          value={parents}
          options={chipOptions}
          onChange={choose}
        />
      )}
      {q.ends && (
        <div class="settings-actions multi-deck-note survey-ends">
          <span>{q.ends[0]}</span>
          <span class="grow" />
          <span>{q.ends[1]}</span>
        </div>
      )}
      {q.max && (
        <p class="multi-deck-note">
          {picks.length} of {q.max}
        </p>
      )}
      {q.id === 'features' && (
        <p class="multi-deck-note">Suggested from settings. Change freely.</p>
      )}
      {subParents.map((parent) => (
        <div key={parent.id}>
          <p class="multi-deck-note">Which one?</p>
          <ChipRadioGroup
            name={`survey-${parent.id}-detail`}
            label={`${parent.label}: which one?`}
            value={picks.find((id) => parent.options?.some((o) => o.id === id)) ?? ''}
            options={(parent.options ?? []).map((o) => ({ value: o.id, label: o.label }))}
            onChange={(id) =>
              onChange(
                q.kind === 'single'
                  ? id
                  : picks.map((v) => (parentOption(q.options, v)?.id === parent.id ? id : v)),
                q.kind === 'single',
              )
            }
          />
        </div>
      ))}
    </>
  );
}

const UNSENT: Record<NonNullable<SurveySendResult['reason']>, string> = {
  mock: 'Not sent: mock mode never sends feedback.',
  offline: 'Not sent: connection failed. Your answers are kept for retry during this session.',
  'no-curl': 'Not sent: curl is unavailable. Your answers are kept for retry during this session.',
  rejected:
    'Not sent: response rejected or device context changed. Retry after reviewing the updated preview.',
};

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
  const [comment, setComment] = useState('');
  const [useForOther, setUseForOther] = useState('');
  const [wantOther, setWantOther] = useState('');
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [message, setMessage] = useState('');
  const headingRef = useRef<HTMLHeadingElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const count = definition.questions.length;
  const total = count + 2;
  const question = definition.questions[step];
  const detail = answers['use-for']?.includes('other') ? useForOther.trim() : '';
  const request = answers.want?.includes('other') ? wantOther.trim() : '';
  const payload: SurveyPayload = {
    sv: definition.sv,
    ...definition.context,
    a: answers,
    ...(comment.trim() ? { c: comment.trim() } : {}),
    ...(detail ? { useForOther: detail } : {}),
    ...(request ? { wantOther: request } : {}),
  };

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

  const move = (next: number): void => {
    clearTimeout(timerRef.current);
    setStep(next);
  };
  const change = (value: string | string[], advance: boolean): void => {
    if (!question) return;
    clearTimeout(timerRef.current);
    setAnswers((old) => {
      const next = { ...old };
      if (Array.isArray(value) && !value.length) delete next[question.id];
      else next[question.id] = value;
      return next;
    });
    if (advance) timerRef.current = setTimeout(() => setStep((old) => old + 1), 300);
  };
  const skip = (): void => {
    if (question)
      setAnswers((old) => {
        const next = { ...old };
        delete next[question.id];
        return next;
      });
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
      {sent ? (
        <div class="survey-body" ref={bodyRef}>
          <h3 class="survey-q" ref={headingRef} tabIndex={-1}>
            Thanks for your feedback!
          </h3>
          <p class="help-lead">Your response was sent.</p>
          <div class="settings-actions">
            <a href="https://github.com/lukasMega/DeckBridge" target="_blank" rel="noopener">
              Star on GitHub
            </a>
            <a
              href="https://github.com/lukasMega/DeckBridge/discussions"
              target="_blank"
              rel="noopener"
            >
              Discussions
            </a>
            <a href="https://github.com/sponsors/lukasMega" target="_blank" rel="noopener">
              Sponsor
            </a>
          </div>
        </div>
      ) : (
        <>
          <div class="survey-progress" aria-label={`Step ${step + 1} of ${total}`}>
            {Array.from({ length: total }, (_, i) => (
              <i key={String(i)} class={i <= step ? 'on' : ''} aria-hidden="true" />
            ))}
            <span class="grow" />
            <span>
              {step + 1} / {total}
            </span>
          </div>
          <div class="survey-body" ref={bodyRef}>
            <h3 class="survey-q" ref={headingRef} tabIndex={-1}>
              {question?.label ?? (step === count ? 'Anything else?' : 'Review your feedback')}
            </h3>
            {question && (
              <QuestionChips question={question} value={answers[question.id]} onChange={change} />
            )}
            {question?.id === 'use-for' && answers['use-for']?.includes('other') && (
              <>
                <textarea
                  class="input survey-comment"
                  aria-label="Other use (optional)"
                  placeholder="Describe your other use (optional)"
                  maxLength={300}
                  value={useForOther}
                  onInput={(e) => setUseForOther(e.currentTarget.value.slice(0, 300))}
                />
                <p class="multi-deck-note">
                  {useForOther.length} / 300 · Please don't include personal info.
                </p>
              </>
            )}
            {question?.id === 'want' && answers.want?.includes('other') && (
              <>
                <input
                  type="text"
                  class="input survey-detail"
                  aria-label="Other request (optional)"
                  placeholder="Describe your request (optional)"
                  maxLength={100}
                  value={wantOther}
                  onInput={(e) => setWantOther(e.currentTarget.value.slice(0, 100))}
                />
                <p class="multi-deck-note">
                  {wantOther.length} / 100 · Please don't include personal info.
                </p>
              </>
            )}
            {step === count && (
              <>
                <textarea
                  class="input survey-comment"
                  aria-label="Anything else?"
                  maxLength={280}
                  value={comment}
                  onInput={(e) => setComment(e.currentTarget.value.slice(0, 280))}
                />
                <p class="multi-deck-note">
                  {comment.length} / 280 · Please don't include personal info.
                </p>
              </>
            )}
            {step === count + 1 && (
              <>
                <ul class="identity-list panel-inset survey-review">
                  {definition.questions
                    .filter((q) => answers[q.id])
                    .map((q, i) => (
                      <li key={q.id}>
                        <span>{q.label}</span>
                        <span class="chip-radio-group">
                          {labels(q, answers[q.id]!).map((label) => (
                            <span class="dock-chip" key={label}>
                              {label}
                            </span>
                          ))}
                          {q.id === 'use-for' && detail && <span>{detail}</span>}
                          {q.id === 'want' && request && <span>{request}</span>}
                        </span>
                        <button
                          type="button"
                          class="linkbtn"
                          disabled={busy}
                          onClick={() => move(definition.questions.indexOf(q))}
                        >
                          Edit<span class="visually-hidden"> {i + 1}</span>
                        </button>
                      </li>
                    ))}
                  {comment && (
                    <li>
                      <span>Comment</span>
                      <span>{comment}</span>
                      <button
                        type="button"
                        class="linkbtn"
                        disabled={busy}
                        onClick={() => move(count)}
                      >
                        Edit
                      </button>
                    </li>
                  )}
                </ul>
                <p class="multi-deck-note">
                  Nothing leaves your machine before Send. Responses are stored individually without
                  IP or install ID.
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
          <div class="settings-actions survey-nav">
            <GhostButton disabled={step === 0 || busy} onClick={() => move(step - 1)}>
              Back
            </GhostButton>
            <span class="grow" />
            {step < count + 1 ? (
              <>
                <GhostButton onClick={skip}>Skip</GhostButton>
                <GhostButton onClick={() => move(step + 1)}>Next ›</GhostButton>
              </>
            ) : (
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
            )}
          </div>
        </>
      )}
    </Modal>
  );
}
