import type { SurveyAnswers, SurveyOption, SurveyQuestion } from '../../contract-survey.js';
import { ChipRadioGroup } from '../components/ChipRadioGroup.js';
import { ChipCheckGroup } from '../components/ChipCheckGroup.js';

interface OtherDetail {
  label: string;
  placeholder: string;
  max: number;
  multiline?: boolean;
}

// Caps mirror validateSurvey (web/server/survey.ts).
const OTHER_DETAILS: Partial<Record<string, OtherDetail>> = {
  'use-for': {
    label: 'Other use (optional)',
    placeholder: 'Describe your other use (optional)',
    max: 300,
    multiline: true,
  },
  want: {
    label: 'Other request (optional)',
    placeholder: 'Describe your request (optional)',
    max: 100,
  },
};

const LINKS: [string, string][] = [
  ['Star on GitHub', 'https://github.com/lukasMega/DeckBridge'],
  ['Discussions', 'https://github.com/lukasMega/DeckBridge/discussions'],
  ['Sponsor', 'https://github.com/sponsors/lukasMega'],
];

function parentOption(options: SurveyOption[], value: string): SurveyOption | undefined {
  return options.find((o) => o.id === value || o.options?.some((sub) => sub.id === value));
}

function labels(question: SurveyQuestion, value: string | string[]): string[] {
  return [value].flat().map((id) => {
    const parent = parentOption(question.options, id);
    const sub = parent?.options?.find((o) => o.id === id);
    return sub ? `${parent?.label}: ${sub.label}` : (parent?.label ?? id);
  });
}

export function LimitedText({
  label,
  placeholder,
  max,
  multiline = false,
  value,
  onInput,
}: Readonly<{
  label: string;
  placeholder?: string;
  max: number;
  multiline?: boolean;
  value: string;
  onInput: (value: string) => void;
}>): preact.JSX.Element {
  const input = (e: { currentTarget: { value: string } }): void =>
    onInput(e.currentTarget.value.slice(0, max));
  return (
    <>
      {multiline ? (
        <textarea
          class="input survey-comment"
          aria-label={label}
          placeholder={placeholder}
          maxLength={max}
          value={value}
          onInput={input}
        />
      ) : (
        <input
          type="text"
          class="input survey-detail"
          aria-label={label}
          placeholder={placeholder}
          maxLength={max}
          value={value}
          onInput={input}
        />
      )}
      <p class="multi-deck-note">
        {value.length} / {max} · Please don't include personal info.
      </p>
    </>
  );
}

export function QuestionStep({
  question: q,
  value,
  draft,
  onChange,
  onDraft,
}: Readonly<{
  question: SurveyQuestion;
  value: string | string[] | undefined;
  draft: string | undefined;
  onChange: (value: string | string[], advance: boolean) => void;
  onDraft: (text: string) => void;
}>): preact.JSX.Element {
  const picks = value === undefined ? [] : [value].flat();
  const parentOf = (id: string): string => parentOption(q.options, id)?.id ?? id;
  const parents = picks.map(parentOf);
  const full = q.kind === 'multi' && !!q.max && picks.length >= q.max;
  const chipOptions = q.options.map((o) => ({
    value: o.id,
    label: o.label,
    disabled: full && !parents.includes(o.id) && o.id !== q.exclusive,
  }));
  const choose = (id: string): void => {
    if (q.kind === 'single') onChange(id, !q.options.find((o) => o.id === id)?.options);
    else if (parents.includes(id))
      onChange(
        picks.filter((v) => parentOf(v) !== id),
        false,
      );
    else if (id === q.exclusive) onChange([id], false);
    else onChange([...picks.filter((v) => v !== q.exclusive), id], false);
  };
  const detail = OTHER_DETAILS[q.id];
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
      {q.options
        .filter((o) => o.options && parents.includes(o.id))
        .map((parent) => (
          <div key={parent.id}>
            <p class="multi-deck-note">Which one?</p>
            <ChipRadioGroup
              name={`survey-${parent.id}-detail`}
              label={`${parent.label}: which one?`}
              value={picks.find((id) => parent.options?.some((o) => o.id === id)) ?? ''}
              options={(parent.options ?? []).map((o) => ({ value: o.id, label: o.label }))}
              onChange={(id) =>
                q.kind === 'single'
                  ? onChange(id, true)
                  : onChange(
                      picks.map((v) => (parentOf(v) === parent.id ? id : v)),
                      false,
                    )
              }
            />
          </div>
        ))}
      {detail && picks.includes('other') && (
        <LimitedText {...detail} value={draft ?? ''} onInput={onDraft} />
      )}
    </>
  );
}

export function ReviewList({
  questions,
  answers,
  others,
  comment,
  busy,
  onEdit,
}: Readonly<{
  questions: SurveyQuestion[];
  answers: SurveyAnswers;
  others: Record<string, string | undefined>;
  comment: string;
  busy: boolean;
  onEdit: (step: number) => void;
}>): preact.JSX.Element {
  return (
    <ul class="identity-list panel-inset survey-review">
      {questions
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
              {others[q.id] && <span>{others[q.id]}</span>}
            </span>
            <button
              type="button"
              class="linkbtn"
              disabled={busy}
              onClick={() => onEdit(questions.indexOf(q))}
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
            onClick={() => onEdit(questions.length)}
          >
            Edit
          </button>
        </li>
      )}
    </ul>
  );
}

export function SurveyProgress({
  step,
  total,
}: Readonly<{ step: number; total: number }>): preact.JSX.Element {
  return (
    <div class="survey-progress" aria-label={`Step ${step + 1} of ${total}`}>
      {Array.from({ length: total }, (_, i) => (
        <i key={String(i)} class={i <= step ? 'on' : ''} aria-hidden="true" />
      ))}
      <span class="grow" />
      <span>
        {step + 1} / {total}
      </span>
    </div>
  );
}

export function SurveyThanks(): preact.JSX.Element {
  return (
    <>
      <p class="help-lead">Your response was sent.</p>
      <div class="settings-actions">
        {LINKS.map(([label, href]) => (
          <a key={href} href={href} target="_blank" rel="noopener">
            {label}
          </a>
        ))}
      </div>
    </>
  );
}
