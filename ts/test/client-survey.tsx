import { render } from 'preact';
import { act } from 'preact/test-utils';
import { SimpleApp } from '../src/web/client/simple/SimpleApp.js';
import { getSnapshot, patch, EMPTY_STATUS } from '../src/web/client/lib/store.js';
import { SurveyModal } from '../src/web/client/simple/survey-modal.js';
import { SURVEY_QUESTIONS, SURVEY_VERSION } from '../src/web/server/survey-questions.js';
import type { SurveyDefinition } from '../src/web/contract-survey.js';
import { runSurveyShort } from './client-survey-short.js';

type Check = (condition: boolean, message: string) => void;
const settle = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
};
const waitAdvance = async (): Promise<void> => {
  await act(() => new Promise((r) => setTimeout(r, 350)));
  await settle();
};

export async function runSurvey(root: HTMLElement, check: Check): Promise<void> {
  const original = globalThis.fetch;
  const bodies: unknown[] = [];
  let succeeds = false;
  let notifications = 0;
  const definition: SurveyDefinition = {
    sv: SURVEY_VERSION,
    questions: SURVEY_QUESTIONS,
    short: ['rating', 'nps', 'want'],
    context: { v: '0.20.0', os: 'macos', ov: 'macos-26', dv: 'mirabox-293s' },
    prefill: { features: ['pages'] },
    nudge: true,
    state: {},
  };
  globalThis.fetch = ((_url: string, init?: RequestInit) => {
    if (typeof init?.body !== 'string') throw new Error('Expected JSON body');
    bodies.push(JSON.parse(init.body));
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(succeeds ? { sent: true } : { sent: false, reason: 'mock' }),
    } as Response);
  }) as typeof fetch;
  let open = true;
  const draw = (): void =>
    render(
      <SurveyModal
        definition={definition}
        open={open}
        onClose={() => {
          open = false;
          draw();
        }}
        onSent={() => notifications++}
        onRefresh={() => Promise.resolve()}
      />,
      root,
    );
  const button = (text: string): HTMLButtonElement =>
    Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(
      (el) => el.textContent === text,
    )!;
  const click = async (text: string): Promise<void> => {
    await act(() => button(text).click());
    await settle();
  };
  const choose = async (name: string, value: string): Promise<void> => {
    await act(() =>
      root
        .querySelector<HTMLInputElement>(`input[name="survey-${name}"][value="${value}"]`)!
        .click(),
    );
    await settle();
  };
  const title = (): string | null => root.querySelector('.survey-q')?.textContent ?? null;
  try {
    localStorage.removeItem('deckbridge.surveyDraft');
    await act(() => {
      render(null, root);
      draw();
    });
    await settle();
    check(
      document.activeElement === root.querySelector('.survey-q'),
      'Survey focuses question rather than first chip',
    );
    check(
      root.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow') === '1',
      'Progress starts at first step',
    );
    await choose('rating', '4');
    check(
      title() === SURVEY_QUESTIONS[0]!.label,
      'Survey choice remains visible before auto-advance',
    );
    await waitAdvance();
    check(title() === SURVEY_QUESTIONS[1]!.label, 'Single pick auto-advances');
    check(
      root.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow') === '2',
      'Progress follows auto-advance',
    );
    await click('Back');
    check(
      root.querySelector<HTMLInputElement>('input[value="4"]')!.checked,
      'Back preserves survey answer',
    );
    await click('Skip');
    await click('Skip');
    await choose('found', 'ai');
    await waitAdvance();
    check(title() === SURVEY_QUESTIONS[2]!.label, 'Discovery waits for detail');
    await choose('ai-detail', 'ai-claude');
    await waitAdvance();
    check(title() === SURVEY_QUESTIONS[3]!.label, 'Discovery detail auto-advances');
    await click('Skip');
    check(root.querySelector('textarea') === null, 'Other use detail starts hidden');
    await choose('use-for', 'other');
    check(document.activeElement === root.querySelector('textarea'), 'Other use focuses its field');
    check(root.querySelector('textarea')?.required === true, 'Other use detail is required');
    check(button('Next ›').disabled, 'Empty Other use blocks Next');
    await act(() => {
      const input = root.querySelector<HTMLTextAreaElement>('textarea')!;
      input.value = '   ';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
    await click('Next ›');
    check(
      button('Next ›').disabled && title() === SURVEY_QUESTIONS[4]!.label,
      'Whitespace Other use cannot advance',
    );
    check(root.querySelector('textarea')?.maxLength === 300, 'Other use allows 300 characters');
    await act(() => {
      const input = root.querySelector<HTMLTextAreaElement>('textarea')!;
      input.value = 'x'.repeat(301);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
    check(root.textContent.includes('300 / 300'), 'Other use counter enforces cap');
    check(
      document.activeElement === root.querySelector('textarea'),
      'Typing keeps Other use focus',
    );
    check(!button('Next ›').disabled, 'Other use text enables Next');
    await choose('use-for', 'other');
    check(root.querySelector('textarea') === null, 'Deselecting Other hides detail');
    check(!button('Next ›').disabled, 'Deselecting Other removes use detail requirement');
    await choose('use-for', 'other');
    await click('Next ›');
    await click('Back');
    check(root.querySelector('textarea')?.value === 'x'.repeat(300), 'Back preserves Other draft');
    check(
      document.activeElement === root.querySelector('.survey-q'),
      'Back focuses question heading',
    );
    await click('Next ›');
    check(
      root.querySelector<HTMLInputElement>('input[value="pages"]')!.checked,
      'Feature evidence is prechecked',
    );
    await choose('features', 'pages');
    check(
      !root.querySelector<HTMLInputElement>('input[value="pages"]')!.checked,
      'Prefilled features can be unchecked',
    );
    await click('Next ›');
    for (const id of ['setup', 'disconnects', 'image-lag']) await choose('pain', id);
    check(
      root.querySelector<HTMLInputElement>('input[value="docs"]')!.disabled,
      'Fourth complaint is disabled at cap',
    );
    check(
      !root.querySelector<HTMLInputElement>('input[value="nothing"]')!.disabled,
      'Nothing stays enabled at cap',
    );
    await choose('pain', 'nothing');
    check(root.querySelectorAll('input:checked').length === 1, 'Nothing clears complaints');
    await choose('pain', 'docs');
    check(
      !root.querySelector<HTMLInputElement>('input[value="nothing"]')!.checked,
      'Complaint clears Nothing',
    );
    await click('Next ›');
    await choose('want', 'more-devices');
    await choose('more-devices-detail', 'more-devices-ajazz');
    await choose('want', 'widgets');
    await choose('want', 'multi-host');
    check(
      root.querySelector<HTMLInputElement>('input[value="other"]')!.disabled,
      'Brand detail counts as one of three wishes',
    );
    check(root.querySelector('.survey-detail') === null, 'Other request detail starts hidden');
    await choose('want', 'multi-host');
    await choose('want', 'other');
    const requestInput = (): HTMLInputElement | null => root.querySelector('.survey-detail');
    check(document.activeElement === requestInput(), 'Other request focuses its field');
    check(
      requestInput()?.required === true && button('Next ›').disabled,
      'Empty Other request blocks Next',
    );
    await act(() => {
      requestInput()!.value = '   ';
      requestInput()!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
    await click('Next ›');
    check(
      button('Next ›').disabled && title() === SURVEY_QUESTIONS[7]!.label,
      'Whitespace Other request cannot advance',
    );
    check(requestInput()?.maxLength === 100, 'Other request allows 100 characters');
    await act(() => {
      const input = requestInput()!;
      input.value = 'y'.repeat(101);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
    check(root.textContent.includes('100 / 100'), 'Other request counter enforces cap');
    check(document.activeElement === requestInput(), 'Typing keeps Other request focus');
    check(!button('Next ›').disabled, 'Other request text enables Next');
    await choose('want', 'other');
    check(requestInput() === null, 'Deselecting Other hides request');
    check(!button('Next ›').disabled, 'Deselecting Other removes request requirement');
    await choose('want', 'other');
    await click('Back');
    await click('Next ›');
    check(requestInput()?.value === 'y'.repeat(100), 'Back preserves Other request draft');
    check(
      document.activeElement === root.querySelector('.survey-q'),
      'Return focuses question heading',
    );
    await click('Next ›');
    await click('Skip');
    await click('Skip');
    await act(() => {
      const input = root.querySelector<HTMLTextAreaElement>('textarea')!;
      check(!input.required, 'Final comment remains optional');
      input.value = 'x'.repeat(300);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
    check(root.textContent.includes('280 / 280'), 'Comment counter enforces cap');
    await click('Next ›');
    const preview = JSON.parse(root.querySelector('#survey-preview')!.textContent) as {
      a: Record<string, unknown>;
      useForOther?: string;
      wantOther?: string;
    };
    check(
      root.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow') === '12',
      'Skipped questions still advance progress',
    );
    check(
      !('rating' in preview.a) && !('features' in preview.a),
      'Skip and cleared features are omitted',
    );
    check(preview.a.found === 'ai-claude', 'Discovery uses wire detail');
    check(preview.useForOther === 'x'.repeat(300), 'Preview includes Other use detail');
    check(preview.wantOther === 'y'.repeat(100), 'Preview includes Other request detail');
    check(
      root.querySelector('.survey-review')!.textContent.includes('y'.repeat(100)),
      'Review shows Other request detail',
    );
    check(
      root.querySelector('.survey-review')!.textContent.includes('x'.repeat(300)),
      'Review shows Other use detail',
    );
    await click('Send');
    check(JSON.stringify(bodies[0]) === JSON.stringify(preview), 'Preview equals exact POST body');
    check(root.textContent.includes('mock mode never sends'), 'Mock failure is explicit');
    check(
      root.querySelector('.survey-celebrate') === null && notifications === 0,
      'Unsent review never celebrates submission',
    );
    await click("Don't send");
    open = true;
    await act(draw);
    await settle();
    check(
      root.querySelector('#survey-preview')!.textContent.includes('ai-claude'),
      'Unsent answers survive closing this session',
    );
    const edit = root.querySelector<HTMLButtonElement>('.survey-review .linkbtn')!;
    await act(() => edit.click());
    await settle();
    check(title() === SURVEY_QUESTIONS[2]!.label, 'Review Edit returns directly to question');
    await choose('found', 'friend');
    await act(() => {
      root.querySelector<HTMLButtonElement>('.pop-close')!.click();
    });
    await waitAdvance();
    open = true;
    await act(draw);
    await settle();
    check(title() === SURVEY_QUESTIONS[2]!.label, 'Closing cancels pending auto-advance');
    await click('Next ›');
    await click('Next ›');
    await choose('use-for', 'other');
    await click('Next ›');
    for (let i = 0; i < 6; i++) await click('Next ›');
    check(
      !root.querySelector('#survey-preview')!.textContent.includes('useForOther'),
      'Deselected Other omits detail from payload',
    );
    for (let i = 0; i < 4; i++) await click('Back');
    await click('Skip');
    for (let i = 0; i < 3; i++) await click('Next ›');
    check(
      !root.querySelector('#survey-preview')!.textContent.includes('wantOther'),
      'Skipping wishes omits request detail',
    );
    succeeds = true;
    await click('Send');
    check(
      root.querySelector('.survey-celebrate') !== null && notifications === 1,
      'Successful sending celebrates once',
    );
    check(
      root.querySelector('[role="progressbar"]') === null &&
        title() === 'Thanks for your feedback!',
      'Success ends survey journey',
    );
  } finally {
    localStorage.removeItem('deckbridge.surveyDraft');
    await act(() => render(null, root));
    globalThis.fetch = original;
  }
  await runSurveyDraft(root, check);
  await runSurveyNudge(root, check);
  await runSurveyShort(root, check);
}

const DRAFT_KEY = 'deckbridge.surveyDraft';

const stored = (): { step: number; answers: Record<string, unknown> } | null =>
  JSON.parse(localStorage.getItem(DRAFT_KEY) ?? 'null') as {
    step: number;
    answers: Record<string, unknown>;
  } | null;

async function runSurveyDraft(root: HTMLElement, check: Check): Promise<void> {
  const original = globalThis.fetch;
  const definition: SurveyDefinition = {
    sv: SURVEY_VERSION,
    questions: SURVEY_QUESTIONS,
    short: ['rating', 'nps', 'want'],
    context: { v: '0.20.0', os: 'macos', ov: 'macos-26', dv: 'mirabox-293s' },
    prefill: { features: ['pages'] },
    nudge: false,
    state: {},
  };
  globalThis.fetch = () =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ sent: true }),
    } as Response);
  const mount = async (): Promise<void> => {
    await act(() => {
      render(null, root);
      render(
        <SurveyModal
          definition={definition}
          open
          onClose={() => undefined}
          onSent={() => undefined}
          onRefresh={() => Promise.resolve()}
        />,
        root,
      );
    });
    await settle();
  };
  const click = async (text: string): Promise<void> => {
    await act(() =>
      Array.from(root.querySelectorAll<HTMLButtonElement>('button'))
        .find((el) => el.textContent === text)!
        .click(),
    );
    await settle();
  };
  const title = (): string | null => root.querySelector('.survey-q')?.textContent ?? null;
  const banner = (): boolean => root.textContent.includes('Continue your unfinished feedback?');
  try {
    localStorage.removeItem(DRAFT_KEY);
    await mount();
    check(!banner() && stored() === null, 'Untouched survey saves no draft');
    await act(() =>
      root.querySelector<HTMLInputElement>('input[name="survey-rating"][value="4"]')!.click(),
    );
    await act(() => new Promise((r) => setTimeout(r, 350)));
    await settle();
    check(
      stored()?.answers.rating === '4' && stored()?.step === 1,
      'Answering stores a local draft with the step',
    );
    await mount();
    check(banner(), 'Reopened survey offers to continue the draft');
    check(
      !root.querySelector<HTMLInputElement>('input[value="4"]')!.checked,
      'Draft is not applied before the user chooses',
    );
    await click('Continue');
    check(
      !banner() && title() === SURVEY_QUESTIONS[1]!.label,
      'Continue resumes at the saved step',
    );
    await click('Back');
    check(
      root.querySelector<HTMLInputElement>('input[value="4"]')!.checked,
      'Continue restores answers',
    );
    await mount();
    await click('Start over');
    check(!banner() && stored() === null, 'Start over discards the draft');
    check(title() === SURVEY_QUESTIONS[0]!.label, 'Start over begins at the first question');
    await act(() =>
      root.querySelector<HTMLInputElement>('input[name="survey-rating"][value="2"]')!.click(),
    );
    await click('Next ›');
    await mount();
    await click('Continue');
    await click('Back');
    check(
      root.querySelector<HTMLInputElement>('input[value="2"]')!.checked,
      'Close without sending keeps the draft',
    );
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        sv: SURVEY_VERSION,
        savedAt: Date.now() - 31 * 86_400_000,
        step: 1,
        answers: { rating: '5' },
        drafts: {},
        comment: '',
      }),
    );
    await mount();
    check(!banner() && stored() === null, 'Draft older than 30 days is dropped');
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        sv: SURVEY_VERSION + 1,
        savedAt: Date.now(),
        step: 1,
        answers: { rating: '5' },
        drafts: {},
        comment: '',
      }),
    );
    await mount();
    check(!banner() && stored() === null, 'Draft from another survey version is dropped');
    localStorage.setItem(DRAFT_KEY, '{broken');
    await mount();
    check(!banner() && stored() === null, 'Corrupt draft is dropped');
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        sv: SURVEY_VERSION,
        savedAt: Date.now(),
        step: 99,
        answers: { rating: '3', features: ['standby'], nope: 'x' },
        drafts: {},
        comment: 'hi',
      }),
    );
    await mount();
    await click('Continue');
    check(
      root.querySelector('#survey-preview')?.textContent.includes('"standby"') === true &&
        !root.querySelector('#survey-preview')!.textContent.includes('"pages"') &&
        !root.querySelector('#survey-preview')!.textContent.includes('nope'),
      'Draft features beat prefill; unknown ids and out-of-range steps are sanitized',
    );
    await click('Send');
    check(stored() === null, 'Successful send clears the draft');
  } finally {
    localStorage.removeItem(DRAFT_KEY);
    await act(() => render(null, root));
    globalThis.fetch = original;
  }
}

async function runSurveyNudge(root: HTMLElement, check: Check): Promise<void> {
  const original = globalThis.fetch;
  const before = getSnapshot();
  const calls: { url: string; body: unknown }[] = [];
  const definition: SurveyDefinition = {
    sv: SURVEY_VERSION,
    questions: SURVEY_QUESTIONS,
    short: ['rating', 'nps', 'want'],
    context: { v: 'test', os: 'unknown', ov: 'unknown', dv: 'none' },
    prefill: { features: ['pages'] },
    nudge: true,
    state: {},
  };
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    calls.push({ url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(url === '/api/survey' ? definition : {}),
    } as Response);
  }) as typeof fetch;
  const ready = { ...EMPTY_STATUS, driverConnected: true, elgatoConnected: true };
  const mount = async (): Promise<void> => {
    await act(() => {
      render(null, root);
      patch({ status: ready, connection: 'live' });
      render(<SimpleApp />, root);
    });
    await settle();
  };
  const button = (text: string): HTMLButtonElement =>
    Array.from(root.querySelectorAll<HTMLButtonElement>('.survey-nudge button')).find(
      (el) => el.textContent === text,
    )!;
  try {
    await mount();
    check(root.querySelector('.survey-nudge') !== null, 'Eligible Ready screen shows survey nudge');
    await act(() => patch({ status: EMPTY_STATUS }));
    await settle();
    check(root.querySelector('.survey-nudge') === null, 'No-device stage never shows nudge');
    await act(() => patch({ status: { ...EMPTY_STATUS, driverConnected: true } }));
    await settle();
    check(root.querySelector('.survey-nudge') === null, 'Pairing stage never shows nudge');
    await mount();
    await act(() => button("Don't ask again").click());
    await settle();
    check(
      root.querySelector('.survey-nudge') === null &&
        calls.some(
          (c) => c.url === '/api/survey/dismiss' && JSON.stringify(c.body) === '{"never":true}',
        ),
      'Permanent dismissal sends never preference',
    );
    definition.prefill = { features: ['standby'] };
    await act(() => root.querySelector<HTMLButtonElement>('#footerFeedback')!.click());
    await settle();
    for (let i = 0; i < 5; i++) {
      await act(() =>
        Array.from(root.querySelectorAll<HTMLButtonElement>('#survey-modal button'))
          .find((el) => el.textContent === 'Skip')!
          .click(),
      );
      await settle();
    }
    check(
      root.querySelector<HTMLInputElement>('input[value="standby"]')!.checked &&
        !root.querySelector<HTMLInputElement>('input[value="pages"]')!.checked,
      'First open refreshes feature suggestions after settings changes',
    );
  } finally {
    localStorage.removeItem(DRAFT_KEY);
    await act(() => render(null, root));
    await act(() => patch(before));
    globalThis.fetch = original;
  }
}
