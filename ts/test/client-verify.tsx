// Device verify wizard in a real DOM: step transitions, the request bodies each answer
// produces, cancel → end, the session-ended screen (410 and WS), the no-canvas message and
// the two entry points. The /api/verify server side is covered by verify-controller.test.ts.
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { getSnapshot, patch } from '../src/web/client/lib/store.js';
import { VerifyWizard } from '../src/web/client/simple/verify-wizard/verify-modal.js';
import {
  VerifyButton,
  VerifyHost,
  VerifyOffer,
} from '../src/web/client/simple/verify-wizard/verify-entry.js';
import {
  applyOrder,
  orderCandidates,
  orientationFix,
} from '../src/web/client/simple/verify-wizard/verify-math.js';
import { DeckPicture } from '../src/web/client/simple/verify-wizard/verify-steps.js';
import type { VerifySpec } from '../src/web/contract-verify.js';
import type { DockUi } from '../src/web/client/ui-types.js';
import { DOCK_IDENTITY } from './helpers/dock-fixture.js';

type Check = (condition: boolean, message: string) => void;

interface Call {
  url: string;
  body: Record<string, unknown> | undefined;
}

const SPEC: VerifySpec = {
  dockIndex: 0,
  modelId: 'ajazz-akp153',
  modelName: 'Ajazz AKP153',
  tested: false,
  rows: 3,
  columns: 5,
  keyCount: 15,
  sourceSize: { width: 72, height: 72 },
  extraKeys: 0,
  encoders: 0,
  touchStrip: false,
  frameOrientation: { rotate: 180, flipH: false },
  image: {
    rotate: 90,
    flipH: false,
    flipV: false,
    width: 85,
    height: 85,
    quality: 0.9,
    maxBytes: 0,
  },
  coraToWireImage: Array.from({ length: 15 }, (_, i) => i + 1),
  splash: { rotate: 270, flipH: false, flipV: false },
  hasAppFrames: false,
  appVersion: 'test',
};

const settle = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
};

/** Routes by path; `status` overrides the reply status per path. */
function stubFetch(
  status: Record<string, number> = {},
  spec: VerifySpec = SPEC,
): { calls: Call[]; restore: () => void } {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    const body =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as Call['body']) : undefined;
    calls.push({ url, body });
    const path = url.split('?')[0]!;
    const replies: Record<string, unknown> = {
      '/api/verify/start': { token: 't1', leaseMs: 30000, spec },
      '/api/verify/save': { ok: true, reconnecting: false },
      '/api/verify/spec': { ok: true, spec: SPEC },
      '/api/device-overrides': {
        modelId: SPEC.modelId,
        overrides: { image: { rotate: 0 } },
        effective: {},
      },
    };
    const code = status[path] ?? 200;
    return Promise.resolve({
      ok: code < 400,
      status: code,
      json: () =>
        Promise.resolve(
          code === 410 ? { error: 'verify session ended' } : (replies[path] ?? { ok: true }),
        ),
    });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

const posts = (calls: Call[], path: string): Call[] => calls.filter((c) => c.url === path);

/** `value/max:text` of the wizard's progress bar. */
function progress(root: HTMLElement): string {
  const bar = root.querySelector<HTMLProgressElement>('.survey-progress progress');
  return `${bar?.value}/${bar?.max}:${root.querySelector('.survey-progress')?.textContent}`;
}

/** Each option as `pick:picture`: img (canvas tile), grid (CSS mini grid) or - (text only). */
function optionPictures(root: HTMLElement): string {
  return [...root.querySelectorAll('.chip-radio')]
    .map((chip) => {
      const kind = chip.querySelector('img') ? 'img' : chip.querySelector('.verify-grid') && 'grid';
      return `${chip.querySelector('input')!.value}:${kind || '-'}`;
    })
    .join();
}

async function pick(root: HTMLElement, id: string, value: string): Promise<void> {
  const input = root.querySelector<HTMLInputElement>(
    `input[name="verify-q-${id}"][value="${value}"]`,
  );
  if (!input) throw new Error(`Missing answer ${id}=${value}: ${root.textContent}`);
  await act(() => input.click());
  await settle();
}

async function press(root: HTMLElement, selector: string): Promise<void> {
  const button = root.querySelector<HTMLButtonElement>(selector);
  if (!button) throw new Error(`Missing ${selector}: ${root.textContent}`);
  await act(() => button.click());
  await settle();
}

async function mount(root: HTMLElement, onClose = (): void => {}): Promise<void> {
  await act(() => render(<VerifyWizard dockIndex={0} onClose={onClose} />, root));
  await press(root, '#verify-start');
}

/** Steps 0–6 with one pick each, checking the request each answer sends. */
async function walkToConfirm(root: HTMLElement, check: Check, calls: Call[]): Promise<void> {
  await act(() => render(<VerifyWizard dockIndex={0} onClose={() => {}} />, root));
  check(root.querySelector('#verify-back')?.hasAttribute('disabled') === true, 'Intro has no Back');
  await settle();
  check(
    root.querySelectorAll('svg.verify-deck text').length === 15,
    'The intro draws the deck from GET /api/verify/spec before the session starts',
  );
  check(
    progress(root) === '1/9:Step 1 of 9',
    `Intro is stage 1 of 9: no app frames, so no real-image stage (got ${progress(root)})`,
  );
  await press(root, '#verify-start');
  check(progress(root) === '2/9:Step 2 of 9', 'Visible is stage 2');
  check(
    JSON.stringify(posts(calls, '/api/verify/start')[0]?.body) === '{"dockIndex":0}',
    'Start posts the dock index',
  );
  const paint = posts(calls, '/api/verify/paint')[0]?.body as
    | { token: string; keys: { key: number; data: string }[] }
    | undefined;
  check(
    paint?.token === 't1' &&
      paint.keys.length === 15 &&
      paint.keys.every((k, i) => k.key === i && k.data.startsWith('/9j/')),
    'Step 1 paints a JPEG test pattern on every key',
  );
  check(root.textContent.includes('Do all keys show a number?'), 'Step 1 asks visibility');

  await pick(root, 'visible', 'all');
  check(root.querySelectorAll('img.verify-thumb').length === 8, 'Orientation shows 8 thumbnails');
  await pick(root, 'orient', '90');
  const fix = orientationFix(SPEC.image, SPEC.frameOrientation, { rotate: 90, flipH: false });
  const draft = posts(calls, '/api/verify/draft')[0]?.body;
  check(
    fix.rotate === 0 && JSON.stringify(draft) === '{"token":"t1","image":{"rotate":0}}',
    `Orientation pick drafts T' as a diff (got ${JSON.stringify(draft)})`,
  );
  await pick(root, 'upright', 'yes');
  check(root.textContent.includes('Colours, left to right?'), 'Upright → colours');
  await pick(root, 'colours', 'rgb');

  const paintsBefore = posts(calls, '/api/verify/paint').length;
  await pick(root, 'order', '1');
  check(
    posts(calls, '/api/verify/paint').length === paintsBefore + 1,
    'A key-order pick repaints the simulated order',
  );
  await pick(root, 'ordered', 'yes');
  await pick(root, 'size', 'cut');
  const sizeDraft = posts(calls, '/api/verify/draft').at(-1)?.body;
  check(
    JSON.stringify(sizeDraft) === '{"token":"t1","image":{"rotate":0,"width":80,"height":80}}',
    `Outer ring cut drafts the next smaller size over the kept rotation (got ${JSON.stringify(sizeDraft)})`,
  );
  await pick(root, 'size', 'fits');
  check(root.textContent.includes('All keys look right?'), 'Fits → confirm');
}

/** Save, the post-save steps and the report. */
async function saveAndReport(
  root: HTMLElement,
  check: Check,
  calls: Call[],
  sink: { copied: string; opened: string },
): Promise<void> {
  await pick(root, 'confirm', 'yes');
  const sigma = orderCandidates(3, 5)[1]!;
  const save = posts(calls, '/api/verify/save')[0]?.body;
  check(
    JSON.stringify(save) ===
      JSON.stringify({
        token: 't1',
        image: { rotate: 0, width: 80, height: 80 },
        coraToWireImage: applyOrder(SPEC.coraToWireImage, sigma),
        splash: { rotate: 180, flipH: false, flipV: false },
      }),
    `Save posts image diff, corrected keyMap and derived splash (got ${JSON.stringify(save)})`,
  );
  check(
    root.querySelector('input[name="verify-q-buttons"]') !== null,
    'No app frames: save skips the real-image check and offers the buttons step',
  );
  check(
    root.querySelector('#verify-back')?.hasAttribute('disabled') === true,
    'No Back into the ended session',
  );
  check(progress(root) === '8/9:Step 8 of 9', 'Buttons is stage 8 of 9');
  await pick(root, 'buttons', 'skip');
  check(progress(root) === '9/9:Step 9 of 9', 'Result is the last stage');
  check(root.textContent.includes('Saved'), 'Skip → result');
  check(root.querySelector('#verify-cancel')?.textContent === 'Done', 'Result closes with Done');

  await press(root, '#verify-copy');
  const report = JSON.parse(sink.copied) as {
    modelId: string;
    verify: { answers: Record<string, string[]>; results: Record<string, string> };
  };
  check(
    report.modelId === SPEC.modelId &&
      report.verify.answers.orient?.join() === '90' &&
      report.verify.answers.upright?.join() === 'yes' &&
      report.verify.answers.size?.join() === 'cut,fits' &&
      JSON.stringify(report.verify.results) ===
        '{"image":"fixed","input":"unknown","colours":"pass","size":"fixed","realImages":"unknown"}',
    `Copy report carries answers and results (got ${JSON.stringify(report.verify)})`,
  );
  await press(root, '#verify-issue');
  const q = new URL(sink.opened).searchParams;
  check(
    q.get('template') === 'device_verification.yml' && q.get('report') === sink.copied,
    'Open GitHub issue prefills the report',
  );
  check(posts(calls, '/api/verify/end').length === 0, 'A saved run never calls end');
}

async function runHappyPath(root: HTMLElement, check: Check): Promise<void> {
  const stub = stubFetch();
  const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  const originalOpen = window.open.bind(window);
  const sink = { copied: '', opened: '' };
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: (text: string) => ((sink.copied = text), Promise.resolve()) },
  });
  window.open = ((url: string) => ((sink.opened = url), null)) as typeof window.open;
  try {
    await walkToConfirm(root, check, stub.calls);
    await saveAndReport(root, check, stub.calls, sink);
  } finally {
    await act(() => render(null, root));
    stub.restore();
    window.open = originalOpen;
    if (original) Object.defineProperty(navigator, 'clipboard', original);
    else delete (navigator as { clipboard?: unknown }).clipboard;
  }
}

async function runCancelAndBlank(root: HTMLElement, check: Check): Promise<void> {
  const stub = stubFetch();
  try {
    let closed = 0;
    await mount(root, () => closed++);
    await press(root, '#verify-cancel');
    check(closed === 1, 'Cancel closes the wizard');
    await act(() => render(null, root));
    check(
      JSON.stringify(posts(stub.calls, '/api/verify/end')[0]?.body) === '{"token":"t1"}',
      'Closing a running session calls end with its token',
    );

    stub.calls.length = 0;
    await mount(root);
    await pick(root, 'visible', 'none');
    check(progress(root) === '2/9:Step 2 of 9', 'The blank ladder keeps its stage number');
    const rungs = (): unknown[] =>
      posts(stub.calls, '/api/verify/draft').map((c) => (c.body as { image: unknown }).image);
    check(
      JSON.stringify(rungs()) === '[{"maxBytes":10240}]',
      `All black starts the blank ladder at the first cap (got ${JSON.stringify(rungs())})`,
    );
    for (let i = 0; i < 6; i++) await pick(root, 'blank', 'no');
    check(
      JSON.stringify(rungs().at(-1)) === '{"quality":0.6,"maxBytes":4096}',
      'The ladder ends at the smallest cap and lowest quality',
    );
    await pick(root, 'blank', 'no');
    check(root.textContent.includes('Not fixed'), 'Still black at the end → result, not saved');
    check(posts(stub.calls, '/api/verify/end').length === 1, 'A failed ladder ends the session');
    check(posts(stub.calls, '/api/verify/save').length === 0, 'A failed ladder saves nothing');
    check(
      root.querySelector('#verify-back')?.hasAttribute('disabled') === true,
      'No Back after a failed run',
    );
  } finally {
    await act(() => render(null, root));
    stub.restore();
  }
}

async function runTapMode(root: HTMLElement, check: Check): Promise<void> {
  const stub = stubFetch();
  try {
    await mount(root);
    await pick(root, 'visible', 'all');
    await pick(root, 'orient', '0');
    check(posts(stub.calls, '/api/verify/draft').length === 0, 'An upright pick drafts nothing');
    await pick(root, 'colours', 'rgb');
    await pick(root, 'order', 'tap');
    const cells = [...root.querySelectorAll<HTMLButtonElement>('.verify-tap button')];
    // Reversed taps in one batch: each tap must see the ones before it.
    await act(() => cells.toReversed().forEach((c) => c.click()));
    const done = root.querySelector<HTMLButtonElement>('#verify-tap-done');
    check(
      cells.length === 15 &&
        done?.disabled === false &&
        root.textContent.includes('All keys tapped'),
      'Tapping every key once completes the order',
    );
    const paints = posts(stub.calls, '/api/verify/paint').length;
    await press(root, '#verify-tap-done');
    check(
      posts(stub.calls, '/api/verify/paint').length === paints + 1 &&
        root.querySelector('input[name="verify-q-ordered"]') !== null,
      'Continue repaints the tapped order and asks again',
    );
  } finally {
    await act(() => render(null, root));
    stub.restore();
  }
}

async function runSessionEnded(root: HTMLElement, check: Check): Promise<void> {
  const stub = stubFetch({ '/api/verify/draft': 410 });
  try {
    await mount(root);
    await pick(root, 'visible', 'all');
    await pick(root, 'orient', '180');
    check(root.textContent.includes('Session ended'), 'A 410 shows the session-ended screen');
    check(!root.textContent.includes('verify session ended'), 'The 410 error text stays hidden');
    await press(root, '#verify-restart');
    check(root.querySelector('#verify-start') !== null, 'Restart goes back to the intro');
    stub.restore();

    const ok = stubFetch();
    await press(root, '#verify-start');
    await act(() => patch({ verifyEnded: { dockIndex: 0, reason: 'saved' } }));
    await act(() => patch({ verifyEnded: { dockIndex: 1, reason: 'lease' } }));
    check(!root.textContent.includes('Session ended'), 'Own ends and other docks are ignored');
    await act(() => patch({ verifyEnded: { dockIndex: 0, reason: 'lease' } }));
    check(root.textContent.includes('Session ended'), 'WS verifyEnded (lease) ends it');
    await act(() => render(null, root));
    check(posts(ok.calls, '/api/verify/end').length === 0, 'An ended session is not ended again');
    ok.restore();
  } finally {
    await act(() => render(null, root));
    stub.restore();
    patch({ verifyEnded: null });
  }
}

/** Every question with pictures, captions kept beside them (alt=""): a run that has app
 *  frames, so the real-image step shows too. */
async function runPictures(root: HTMLElement, check: Check): Promise<void> {
  const stub = stubFetch({}, { ...SPEC, hasAppFrames: true });
  const seen = (id: string, expected: string): void =>
    check(optionPictures(root) === expected, `${id} options show ${expected}`);
  try {
    await mount(root);
    seen('visible', 'all:grid,some:grid,none:grid,garbled:grid');
    check(
      [...root.querySelectorAll('.chip-radio')]
        .map((c) => c.textContent.replace(/\d/g, ''))
        .join() === 'Yes,Some are black,All are black,Garbled',
      'Each picture keeps its text caption',
    );
    await pick(root, 'visible', 'some');
    seen('blank', 'yes:grid,no:grid');
    await pick(root, 'blank', 'yes');
    check(
      optionPictures(root).split(',').length === 8 &&
        [...root.querySelectorAll('.chip-radio img')].every((i) => i.getAttribute('alt') !== ''),
      'Orientation thumbnails are the labels, so they keep alt text',
    );
    await pick(root, 'orient', '90');
    seen('upright', 'yes:img,no:img');
    await pick(root, 'upright', 'yes');
    seen('colours', 'rgb:img,bgr:img,other:-');
    await pick(root, 'colours', 'rgb');
    await pick(root, 'order', '1');
    seen('ordered', 'yes:grid,no:grid');
    await pick(root, 'ordered', 'yes');
    seen('size', 'fits:img,cut:img,gap:img,other:-');
    await pick(root, 'size', 'fits');
    seen('confirm', 'yes:grid,no:grid');
    await pick(root, 'confirm', 'no');
    seen('redo', 'visible:grid,orient:img,order:grid,size:img');
    await pick(root, 'redo', 'size');
    await pick(root, 'size', 'fits');
    await pick(root, 'confirm', 'yes');
    seen('real', 'yes:img,cut:img,wrong:grid');
    check(
      progress(root) === '8/10:Step 8 of 10',
      'With app frames the real-image check is a stage',
    );
    check(
      [...root.querySelectorAll('.chip-radio img')].every((i) => i.getAttribute('alt') === ''),
      'Option pictures beside a caption have alt=""',
    );
    await pick(root, 'real', 'yes');
    seen('buttons', 'yes:-,no:-,skip:-');
  } finally {
    await act(() => render(null, root));
    stub.restore();
  }
}

/** Runs first: no thumbnail is cached yet, so a canvas lost mid-run leaves text options. */
async function runCanvasLost(root: HTMLElement, check: Check): Promise<void> {
  const stub = stubFetch();
  const proto = HTMLCanvasElement.prototype;
  const getContext = Object.getOwnPropertyDescriptor(proto, 'getContext')!;
  try {
    await mount(root);
    Object.defineProperty(proto, 'getContext', { configurable: true, value: () => null });
    await pick(root, 'visible', 'all');
    check(
      root.querySelector('img') === null && root.textContent.includes('90° mirrored'),
      'Without a canvas the orientation options fall back to their captions',
    );
    await pick(root, 'orient', '0');
    check(
      optionPictures(root) === 'rgb:-,bgr:-,other:-' &&
        root.textContent.includes('Red, green, blue'),
      'Without a canvas the colour options are text only',
    );
  } finally {
    Object.defineProperty(proto, 'getContext', getContext);
    await act(() => render(null, root));
    stub.restore();
  }
}

/** The deck schematic: app keys numbered, the rest dashed with a legend. */
async function runDeckPicture(root: HTMLElement, check: Check): Promise<void> {
  const akp05e = {
    ...SPEC,
    rows: 2,
    columns: 4,
    keyCount: 8,
    extraKeys: 2,
    encoders: 4,
    touchStrip: true,
  };
  await act(() => render(<DeckPicture spec={akp05e} />, root));
  const svg = root.querySelector('svg[role="img"]');
  const extras = [...root.querySelectorAll('rect.verify-off')].filter(
    (r) => r.getAttribute('x') === '96',
  );
  check(
    root.querySelectorAll('svg text').length === 8 &&
      extras.map((r) => r.getAttribute('y')).join() === '0,24' &&
      root.querySelectorAll('rect.verify-off').length === 3 &&
      root.querySelectorAll('circle.verify-off').length === 4,
    'AKP05E: 8 numbered keys, 2 dashed extra keys in the right column, strip and 4 dials',
  );
  check(
    root.textContent.includes('The Stream Deck app draws keys 1–8. This check tests those.') &&
      root.textContent.includes(
        'Dashed: DeckBridge keys, dials, touch strip. Not part of this check.',
      ) &&
      svg?.getAttribute('aria-label')?.startsWith('Keys 1–8 in 2 rows of 4.') === true,
    'AKP05E: caption, legend and a summarising label',
  );
  await act(() => render(<DeckPicture spec={SPEC} />, root));
  check(
    root.querySelectorAll('svg text').length === 15 &&
      root.querySelector('.verify-off') === null &&
      !root.textContent.includes('Dashed') &&
      root.textContent.includes('keys 1–15'),
    'A plain 15-key deck: all keys numbered, no legend',
  );
  await act(() => render(<VerifyWizard dockIndex={1} onClose={() => {}} />, root));
  check(progress(root) === '1/8:Step 1 of 8', 'Off dock 0 the buttons stage is not counted');
  await act(() => render(null, root));
}

async function runNoCanvas(root: HTMLElement, check: Check): Promise<void> {
  const proto = HTMLCanvasElement.prototype;
  const getContext = Object.getOwnPropertyDescriptor(proto, 'getContext')!;
  Object.defineProperty(proto, 'getContext', { configurable: true, value: () => null });
  try {
    await act(() => render(<VerifyWizard dockIndex={0} onClose={() => {}} />, root));
    check(
      root.textContent.includes("This browser can't draw test images.") &&
        root.querySelector('#verify-start') === null,
      'Without a 2D canvas the wizard explains instead of starting',
    );
    check(
      root.querySelector('img, .chip-radio') === null,
      'The no-canvas screen has no options and no pictures',
    );
  } finally {
    Object.defineProperty(proto, 'getContext', getContext);
    await act(() => render(null, root));
  }
}

const DOCK: DockUi = {
  index: 0,
  ...DOCK_IDENTITY,
  modelId: SPEC.modelId,
  modelName: SPEC.modelName,
  tested: false,
  keyCount: 15,
  columns: 5,
  rows: 3,
  primaryPort: 5343,
  primaryConnected: false,
  elgatoConnected: false,
  brightness: 100,
};

async function runEntryPoints(root: HTMLElement, check: Check): Promise<void> {
  const stub = stubFetch();
  const status = getSnapshot().status;
  try {
    await act(() => patch({ status: { ...status, docks: [{ ...DOCK, tested: true }] } }));
    await act(() => render(<VerifyOffer index={0} />, root));
    await settle();
    check(
      root.textContent === '' && stub.calls.length === 0,
      'Tested models get no offer, no fetch',
    );
    await act(() =>
      patch({ status: { ...status, docks: [DOCK], verifyDismissed: [SPEC.modelId] } }),
    );
    await settle();
    check(root.textContent === '' && stub.calls.length === 0, 'Dismissed models get no offer');
    await act(() => patch({ status: { ...status, docks: [DOCK], verifyDismissed: [] } }));
    await settle();
    check(
      stub.calls[0]?.url === `/api/verify/spec?dock=0&model=${SPEC.modelId}` &&
        root.querySelector('#verify-offer-0') !== null,
      'An untested, available dock shows the offer',
    );
    const buttons = [...root.querySelectorAll<HTMLButtonElement>('#verify-offer-0 button')];
    await act(() => buttons[1]!.click());
    await act(() => buttons[2]!.click());
    check(
      JSON.stringify(posts(stub.calls, '/api/verify/dismiss').map((c) => c.body)) ===
        `[{"modelId":"${SPEC.modelId}","never":false},{"modelId":"${SPEC.modelId}","never":true}]`,
      'Not now / Don’t ask again post session and permanent dismissals',
    );
    await act(() => buttons[0]!.click());
    check(getSnapshot().verifyDock === 0, 'Check my device opens the wizard on that dock');
    await act(() => render(<VerifyHost />, root));
    check(root.querySelector('#verify-wizard') !== null, 'The host shows the open wizard');
    await press(root, '#verify-cancel');
    check(getSnapshot().verifyDock === null && root.textContent === '', 'Closing clears the host');

    await act(() => patch({ status: { ...getSnapshot().status, selectedDock: 1 } }));
    await act(() => render(<VerifyButton modelId={SPEC.modelId} />, root));
    await settle();
    await press(root, '#tuning-verify');
    check(getSnapshot().verifyDock === 1, 'The device-tuning button opens the wizard');
  } finally {
    await act(() => render(null, root));
    stub.restore();
    patch({ status, verifyDock: null });
  }
}

export async function runVerifyWizard(root: HTMLElement, check: Check): Promise<void> {
  await runCanvasLost(root, check);
  await runHappyPath(root, check);
  await runPictures(root, check);
  await runCancelAndBlank(root, check);
  await runTapMode(root, check);
  await runSessionEnded(root, check);
  await runNoCanvas(root, check);
  await runDeckPicture(root, check);
  await runEntryPoints(root, check);
}
