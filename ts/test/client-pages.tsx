// "Follow Elgato pages" panel + layout scope (simple/pages-panel.tsx, layout-scope.tsx).
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { EMPTY_STATUS, getSnapshot, patch } from '../src/web/client/lib/store.js';
import { ExtraKeysPanel } from '../src/web/client/simple/extra-keys-panel.js';
import { scopeIsLive } from '../src/web/client/simple/layout-scope.js';
import { hydrate } from '../src/web/client/lib/hydrate.js';
import { applyImage, clearImageStore } from '../src/web/client/key-preview.js';
import type {
  DockUi,
  PageStateMsg,
  PageSummary,
  StateResponse,
} from '../src/web/client/ui-types.js';
import { DOCK_IDENTITY } from './helpers/dock-fixture.js';

type Check = (condition: boolean, message: string) => void;

const DOCK: DockUi = {
  index: 0,
  ...DOCK_IDENTITY,
  modelId: 'mirabox-293s',
  modelName: 'Mirabox 293S',
  keyCount: 15,
  columns: 5,
  rows: 3,
  primaryPort: 5343,
  primaryConnected: true,
  elgatoConnected: true,
  brightness: 100,
  extraKeys: [16, 17, 18],
};

const state = (over: Partial<PageStateMsg> = {}): PageStateMsg => ({
  activePageId: null,
  source: 'fingerprint',
  keyCount: 15,
  columns: 5,
  scores: [],
  suggestedIgnore: [],
  settling: false,
  held: false,
  ...over,
});

const page = (id: string, name: string, over: Partial<PageSummary> = {}): PageSummary => ({
  id,
  name,
  keyCount: 15,
  ignore: [],
  minMatch: 0.8,
  considered: 15,
  ...over,
});

interface Call {
  url: string;
  body: Record<string, unknown>;
}

const show = (pages: PageSummary[], pageState: PageStateMsg, scope: string | null = null) =>
  act(() => patch({ pages, pageState, layoutScope: scope }));

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

async function runPageDisclosures(root: HTMLElement, check: Check): Promise<void> {
  await show([page('p1', 'Main')], state());
  const manage = (): HTMLButtonElement => root.querySelector('#pageManageBtn')!;
  check(
    root.querySelector<HTMLUListElement>('#savedPagesList')!.hidden &&
      manage().getAttribute('aria-expanded') === 'false',
    'Saved pages start collapsed',
  );
  await act(() => manage().click());
  check(
    !root.querySelector<HTMLUListElement>('#savedPagesList')!.hidden &&
      root.querySelector('.page-name') === null,
    'Opening saved pages keeps occasional controls hidden',
  );
  const options = root.querySelector<HTMLButtonElement>('.page-options-toggle')!;
  await act(() => options.click());
  check(root.querySelector('.page-name') !== null, 'Options exposes rename and matching controls');
  await act(() => options.click());
  check(root.querySelector('.page-name') === null, 'Options can collapse again');
  await act(() => manage().click());
  check(
    root.querySelector<HTMLUListElement>('#savedPagesList')!.hidden === true,
    'Saved pages can collapse again',
  );
  await show([], state({ held: true }));
}

async function runScopeHydrate(main: PageSummary, check: Check): Promise<void> {
  const snapshot = (pages: PageSummary[]): StateResponse => {
    const current = getSnapshot();
    return {
      ...current.status,
      ...current,
      pages,
      pageState: state(),
      deviceIdentity: DOCK_IDENTITY,
      logLevel: 'info',
      logFilePath: '',
      multiDeck: false,
      elgatoAutoRestart: { enabled: true, delayS: 10, supported: true },
      updateInfo: current.updateInfo ?? { enabled: true, current: 'test', updateAvailable: false },
    };
  };
  for (const pages of [[], [page('p1', 'Main')]]) {
    await show([main], state(), 'p1');
    await act(() => hydrate(snapshot(pages)));
    check(
      getSnapshot().layoutScope === null,
      'Reconnect drops a deleted or inherited layout scope',
    );
  }
  await show([main], state(), 'p1');
  await act(() => hydrate(snapshot([main])));
  check(getSnapshot().layoutScope === 'p1', 'Reconnect keeps a valid own-layout scope');
}

async function runPageRename(root: HTMLElement, calls: Call[], check: Check): Promise<void> {
  const text = (selector: string): string => root.querySelector(selector)?.textContent ?? '';
  await act(() => root.querySelector<HTMLButtonElement>('.page-options-toggle')!.click());
  const rename = root.querySelector<HTMLInputElement>('.page-name')!;
  await act(() => {
    rename.focus();
    rename.value = 'Cancelled';
    rename.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const beforeCancel = calls.length;
  await act(() => {
    rename.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    rename.blur();
  });
  await settle();
  check(
    calls.length === beforeCancel && rename.value === 'Main',
    'Escape cancels rename without posting on blur',
  );

  const normalFetch = globalThis.fetch;
  let rejectRename!: () => void;
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    if (url !== '/api/pages/update') return normalFetch(url, init);
    calls.push({ url, body: JSON.parse(init!.body as string) as Record<string, unknown> });
    return new Promise<Response>((resolve) => {
      rejectRename = () =>
        resolve({
          ok: false,
          status: 400,
          json: () => Promise.resolve({ error: 'Rename rejected' }),
        } as Response);
    });
  }) as typeof fetch;
  await act(() => {
    rename.focus();
    rename.value = 'Keep draft';
    rename.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(() => {
    rename.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  check(rename.value === 'Keep draft', 'Pending rename retains the typed draft');
  await act(() => rejectRename());
  await settle();
  check(
    rename.value === 'Keep draft' && text('.page-row [role="alert"]') === 'Rename rejected',
    'Rejected rename retains the draft and reports the error',
  );
  const manage = root.querySelector<HTMLButtonElement>('#pageManageBtn')!;
  await act(() => manage.click());
  await act(() => manage.click());
  check(
    root.querySelector<HTMLInputElement>('.page-name')?.value === 'Keep draft',
    'Collapsing saved pages preserves a rejected rename draft',
  );
  globalThis.fetch = normalFetch;
}

async function runSnapshotFollow(
  root: HTMLElement,
  check: Check,
  keys: () => HTMLButtonElement[],
): Promise<void> {
  const pressed = (i: number): boolean => keys()[i]!.getAttribute('aria-pressed') === 'true';
  await show([], state({ suggestedIgnore: [1] }));
  await act(() => root.querySelector<HTMLButtonElement>('#pageSnapshotBtn')!.click());
  await show([], state({ suggestedIgnore: [7] }));
  check(keys().length === 0, 'Ignore suggestions update while their grid stays hidden');
  await act(() => root.querySelector<HTMLButtonElement>('#pageIgnoreToggle')!.click());
  check(pressed(7) && !pressed(1), 'The open form follows a changed ignore suggestion');
  await act(() => {
    clearImageStore();
    applyImage(2, { data: 'AAAA', format: 'jpeg' });
  });
  check(keys()[2]!.querySelector('img') !== null, 'A live key image appears in the open form');
  await act(() => keys()[0]!.click());
  await show([], state({ suggestedIgnore: [8] }));
  check(pressed(0) && pressed(7) && !pressed(8), 'Picked keys are no longer overwritten');
  const input = root.querySelector<HTMLInputElement>('#pageNameInput')!;
  await act(() => {
    input.value = 'X';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const save = (): HTMLButtonElement => root.querySelector('#pageSaveBtn')!;
  check(!save().disabled, 'A settled page can be saved');
  await show([], state({ settling: true }));
  check(save().disabled, 'Save is disabled while the page is still changing');
  await act(() => clearImageStore());
  await act(() =>
    root.querySelector<HTMLButtonElement>('.page-form .page-actions .ghostbtn:last-child')!.click(),
  );
}

async function runSnapshotSave(
  root: HTMLElement,
  calls: Call[],
  check: Check,
  keys: () => HTMLButtonElement[],
): Promise<void> {
  await act(() => root.querySelector<HTMLButtonElement>('#pageSnapshotBtn')!.click());
  check(
    keys().length === 0 && document.activeElement?.id === 'pageNameInput',
    'Saving starts with a focused name and a collapsed key grid',
  );
  await act(() => root.querySelector<HTMLButtonElement>('#pageIgnoreToggle')!.click());
  check(
    keys().length === 15 &&
      keys()[3]!.getAttribute('aria-pressed') === 'true' &&
      keys()[4]!.getAttribute('aria-pressed') === 'true' &&
      keys()[0]!.getAttribute('aria-pressed') === 'false',
    'The snapshot form pre-ticks the suggested ignored keys',
  );
  const input = root.querySelector<HTMLInputElement>('#pageNameInput')!;
  await act(() => {
    input.value = 'Main';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const normalFetch = globalThis.fetch;
  let finishSave!: () => void;
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    const response = normalFetch(url, init);
    if (url !== '/api/pages/snapshot') return response;
    return new Promise<Response>((resolve) => {
      finishSave = () => {
        void response.then(resolve);
      };
    });
  }) as typeof fetch;
  try {
    const save = root.querySelector<HTMLButtonElement>('#pageSaveBtn')!;
    await act(() => save.click());
    check(save.disabled && input.disabled, 'A pending save blocks repeated submissions');
    await act(() => save.click());
    check(
      calls.filter((c) => c.url === '/api/pages/snapshot').length === 1,
      'Clicking Save again does not create another snapshot',
    );
    await act(() => finishSave());
    await settle();
    const snap = calls.findLast((c) => c.url === '/api/pages/snapshot');
    check(
      JSON.stringify(snap?.body) === JSON.stringify({ name: 'Main', ignore: [3, 4] }),
      'Save posts the name and the ignored keys',
    );
    check(root.querySelector('.page-form') === null, 'The form closes after saving');
  } finally {
    globalThis.fetch = normalFetch;
  }
}

export async function runPagesPanel(root: HTMLElement, check: Check): Promise<void> {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      calls.push({ url, body: JSON.parse(init.body as string) as Record<string, unknown> });
    }
    const payload =
      url === '/api/plugins'
        ? { dir: '', files: [], status: { '16': 'err' }, pageStatus: { p1: { '16': 'ok' } } }
        : { ok: true };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) });
  }) as typeof fetch;
  const text = (selector: string): string => root.querySelector(selector)?.textContent ?? '';
  const snapshotBtn = (): HTMLButtonElement => root.querySelector('#pageSnapshotBtn')!;
  const keys = (): HTMLButtonElement[] => [
    ...root.querySelectorAll<HTMLButtonElement>('.page-form .crop-key'),
  ];
  try {
    await act(() => patch({ status: { ...EMPTY_STATUS, docks: [DOCK], selectedDock: 0 } }));
    await show([], state({ held: true }));
    await act(() => render(<ExtraKeysPanel />, root));
    await settle();
    await runPageDisclosures(root, check);
    check(
      text('#pagesStatus').startsWith('Waiting for the Elgato app') && snapshotBtn().disabled,
      'No page yet: status waits for the app and Save is disabled',
    );
    await show([], state({ settling: true }));
    check(snapshotBtn().disabled, 'Save is disabled while a key burst is still arriving');
    await show([], state({ suggestedIgnore: [3, 4] }));
    check(
      !snapshotBtn().disabled && text('#pagesStatus').startsWith('Save an Elgato page'),
      'A settled page enables Save',
    );

    await runSnapshotSave(root, calls, check, keys);
    await runSnapshotFollow(root, check, keys);

    const main = page('p1', 'Main', { extraKeys: { '16': { widget: 'text', param: 'on Main' } } });
    await runScopeHydrate(main, check);
    await show(
      [main],
      state({
        activePageId: 'p1',
        scores: [{ pageId: 'p1', matched: 14, considered: 15, mismatched: [4] }],
      }),
    );
    check(
      root.querySelector<HTMLButtonElement>('#pageManageBtn')?.getAttribute('aria-expanded') ===
        'true',
      'Saving reveals saved pages so their layout action is discoverable',
    );
    check(
      text('#pagesStatus') === 'Showing "Main" — side keys use its layout' &&
        text('.page-row .dock-chip--paired') === 'Active',
      'The active page is named in the status and badged',
    );
    await runPageRename(root, calls, check);
    const keysBtn = [...root.querySelectorAll<HTMLButtonElement>('.page-row .ghostbtn')].find((b) =>
      b.textContent.startsWith('Ignored keys'),
    )!;
    await act(() => keysBtn.click());
    const grid = root.querySelectorAll('.page-row .crop-key');
    check(
      grid.length === 15 && grid[4]!.classList.contains('page-key--changed'),
      'A key that differs from the saved page is marked in its Keys grid',
    );

    await show([main], state());
    check(
      text('#pagesStatus').includes('not saved — side keys use the default layout'),
      'An unknown page falls back to the default layout in the status',
    );
    await show([page('p1', 'Old', { stale: true })], state());
    check(text('.page-row').includes('Recorded for another layout'), 'A stale page is badged');
    await show([page('p1', 'Odd', { minMatch: 0.75 })], state());
    check(
      root.querySelector<HTMLInputElement>('input[name="pageStrictness-p1"]:checked')?.value ===
        '0.8',
      'A free-form minMatch selects the nearest strictness chip',
    );

    // Layout scope: edits go to the scoped page's own layout.
    await show([main], state({ activePageId: 'p1' }));
    const scope = root.querySelector<HTMLSelectElement>('#layoutScopeSelect')!;
    await act(() => {
      scope.value = 'p1';
      scope.dispatchEvent(new Event('change', { bubbles: true }));
    });
    check(getSnapshot().layoutScope === 'p1', 'Choosing a page scopes the editor to it');
    const widget = root.querySelector<HTMLSelectElement>('.xkey-card select.xkey-select')!;
    check(widget.value === 'text', 'The scoped side key shows the page layout, not the default');
    widget.value = 'clock';
    await act(() => {
      widget.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const edit = calls.findLast((c) => c.url === '/api/extra-key');
    check(
      edit?.body.pageId === 'p1' && edit.body.widget === 'clock',
      'A widget change under a page scope posts the pageId',
    );
    check(
      scopeIsLive(getSnapshot()) && root.querySelector('.layout-scope .xkeys-sub') === null,
      'The active page layout is on the deck: no warning',
    );
    await show([main], state({ activePageId: null }), 'p1');
    check(
      !scopeIsLive(getSnapshot()) &&
        text('.layout-scope .xkeys-sub').startsWith('Not on the deck right now'),
      'A layout that is not on the deck says so',
    );
    await runPagePlugins(root, check);
  } finally {
    globalThis.fetch = original;
    await act(() => render(null, root));
    await act(() => patch({ pages: [], layoutScope: null }));
  }
}

async function runPagePlugins(root: HTMLElement, check: Check): Promise<void> {
  const before = getSnapshot().extraKeys;
  const plugin = { widget: 'plugin' as const, param: 'page-only.js' };
  await act(() => patch({ extraKeys: { '16': plugin } }));
  await show([page('p1', 'Main', { extraKeys: { '16': plugin } })], state(), 'p1');
  await settle();
  await act(() => root.querySelector<HTMLButtonElement>('.xkey-config-btn')!.click());
  check(
    root.querySelector('.xkey-status')?.textContent === 'ok',
    'Scoped plugin shows its page status',
  );
  await act(() => patch({ layoutScope: null }));
  check(
    root.querySelector('.xkey-status')?.textContent === 'ERR',
    'Default plugin keeps its own status on the same wire',
  );
  await act(() => patch({ extraKeys: before }));
}
