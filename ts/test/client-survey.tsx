import { render } from 'preact';
import { act } from 'preact/test-utils';
import { SimpleApp } from '../src/web/client/simple/SimpleApp.js';
import { getSnapshot, patch, EMPTY_STATUS } from '../src/web/client/lib/store.js';
import { SurveyModal } from '../src/web/client/simple/survey-modal.js';
import { SURVEY_QUESTIONS, SURVEY_VERSION } from '../src/web/server/survey-questions.js';
import type { SurveyDefinition } from '../src/web/contract-survey.js';

type Check = (condition: boolean, message: string) => void;
const settle = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
};

export async function runSurvey(root: HTMLElement, check: Check): Promise<void> {
  const original = globalThis.fetch;
  const bodies: unknown[] = [];
  const definition: SurveyDefinition = {
    sv: SURVEY_VERSION,
    questions: SURVEY_QUESTIONS,
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
      json: () => Promise.resolve({ sent: false, reason: 'mock' }),
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
        onSent={() => undefined}
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
  const waitAdvance = async (): Promise<void> => {
    await act(() => new Promise((r) => setTimeout(r, 350)));
    await settle();
  };
  const title = (): string | null => root.querySelector('.survey-q')?.textContent ?? null;
  try {
    await act(() => {
      render(null, root);
      draw();
    });
    await settle();
    check(
      document.activeElement === root.querySelector('.survey-q'),
      'Survey focuses question rather than first chip',
    );
    await choose('rating', '4');
    check(
      title() === SURVEY_QUESTIONS[0]!.label,
      'Survey choice remains visible before auto-advance',
    );
    await waitAdvance();
    check(title() === SURVEY_QUESTIONS[1]!.label, 'Single pick auto-advances');
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
    check(root.querySelector('textarea')?.maxLength === 300, 'Other use allows 300 characters');
    await act(() => {
      const input = root.querySelector<HTMLTextAreaElement>('textarea')!;
      input.value = 'x'.repeat(301);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
    check(root.textContent.includes('300 / 300'), 'Other use counter enforces cap');
    await choose('use-for', 'other');
    check(root.querySelector('textarea') === null, 'Deselecting Other hides detail');
    await choose('use-for', 'other');
    await click('Next ›');
    await click('Back');
    check(root.querySelector('textarea')?.value === 'x'.repeat(300), 'Back preserves Other draft');
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
    check(requestInput()?.maxLength === 100, 'Other request allows 100 characters');
    await act(() => {
      const input = requestInput()!;
      input.value = 'y'.repeat(101);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
    check(root.textContent.includes('100 / 100'), 'Other request counter enforces cap');
    await choose('want', 'other');
    check(requestInput() === null, 'Deselecting Other hides request');
    await choose('want', 'other');
    await click('Back');
    await click('Next ›');
    check(requestInput()?.value === 'y'.repeat(100), 'Back preserves Other request draft');
    await click('Next ›');
    await click('Skip');
    await click('Skip');
    await act(() => {
      const input = root.querySelector<HTMLTextAreaElement>('textarea')!;
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
  } finally {
    await act(() => render(null, root));
    globalThis.fetch = original;
  }
  await runSurveyNudge(root, check);
}

async function runSurveyNudge(root: HTMLElement, check: Check): Promise<void> {
  const original = globalThis.fetch;
  const before = getSnapshot();
  const calls: { url: string; body: unknown }[] = [];
  const definition: SurveyDefinition = {
    sv: SURVEY_VERSION,
    questions: SURVEY_QUESTIONS,
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
    await act(() => patch({ status: ready }));
    await settle();
    await act(() => button('Not now').click());
    await settle();
    check(
      root.querySelector('.survey-nudge') === null &&
        calls.some(
          (c) => c.url === '/api/survey/dismiss' && JSON.stringify(c.body) === '{"never":false}',
        ),
      'Not now dismisses with snooze request',
    );
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
    await act(() => render(null, root));
    await act(() => patch(before));
    globalThis.fetch = original;
  }
}
