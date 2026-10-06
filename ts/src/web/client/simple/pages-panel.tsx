// "Follow Elgato pages": save what the Elgato app shows as a page, give it its own
// side-key layout, and the layout follows the page when the app switches to it.
import { useEffect, useRef, useState } from 'preact/hooks';
import { MAX_PAGES, PAGE_NAME_MAX } from '../lib/page-limits.js';
import { useStore } from '../lib/store.js';
import { postJson } from '../lib/ui-api.js';
import type { PageStateMsg, PageSummary } from '../ui-types.js';
import { ConfigSection } from './config-section.js';
import { PageKeyGrid } from './page-key-grid.js';
import { PageRow, useAction } from './page-row.js';

function statusText(pages: readonly PageSummary[], state: PageStateMsg): string {
  const active = pages.find((p) => p.id === state.activePageId);
  if (active) {
    const layout = active.extraKeys ? 'its layout' : 'the default layout';
    return `Showing "${active.name}" — side keys use ${layout}`;
  }
  if (pages.length === 0) {
    return state.held
      ? 'Waiting for the Elgato app to show a page'
      : 'Save an Elgato page to give it its own side-key layout';
  }
  return state.held
    ? 'Waiting for the Elgato app to show a page'
    : 'This Elgato page is not saved — side keys use the default layout';
}

/** Why Save is off, shown as its tooltip; undefined = it can save. */
function captureBlocker(full: boolean, state: PageStateMsg): string | undefined {
  if (full) return `At most ${MAX_PAGES} pages per device`;
  if (state.settling) return 'The page is still changing';
  return state.held ? 'Waiting for the Elgato app to show a page' : undefined;
}

function PageSnapshotForm({
  state,
  activeName,
  onDone,
}: Readonly<{ state: PageStateMsg; activeName?: string; onDone: () => void }>): preact.JSX.Element {
  const [name, setName] = useState('');
  const [ignored, setIgnored] = useState<ReadonlySet<number>>(() => new Set(state.suggestedIgnore));
  const touchedRef = useRef(false);
  const [error, run] = useAction();
  // The deck can change page or reveal an animated key while the form is open: follow the
  // suggestion until the user picks keys themselves.
  const suggested = state.suggestedIgnore.join(',');
  useEffect(
    function followSuggestion() {
      if (!touchedRef.current)
        setIgnored(new Set(suggested === '' ? [] : suggested.split(',').map(Number)));
    },
    [suggested],
  );
  const toggle = (key: number): void => {
    touchedRef.current = true;
    const next = new Set(ignored);
    if (!next.delete(key)) next.add(key);
    setIgnored(next);
  };
  const save = (): void => {
    const ignore = [...ignored].toSorted((a, b) => a - b);
    run(postJson('/api/pages/snapshot', { name: name.trim(), ignore }).then(onDone));
  };
  return (
    <div class="page-form">
      <input
        id="pageNameInput"
        class="input"
        type="text"
        maxLength={PAGE_NAME_MAX}
        placeholder="Page name"
        aria-label="Page name"
        value={name}
        onInput={(e) => setName((e.target as HTMLInputElement).value)}
      />
      <p class="xkeys-sub">Ignore keys that change on their own (clock, GIF, counters).</p>
      <PageKeyGrid
        label="Keys to ignore"
        keyCount={state.keyCount}
        columns={state.columns}
        ignored={ignored}
        liveImages
        onToggle={toggle}
      />
      {activeName !== undefined && (
        <p class="xkeys-sub">
          Looks like saved page "{activeName}" — save anyway or re-capture "{activeName}".
        </p>
      )}
      {error !== '' && (
        <p class="xkeys-sub" role="alert">
          {error}
        </p>
      )}
      <div class="page-actions">
        <button
          class="ghostbtn"
          id="pageSaveBtn"
          type="button"
          disabled={name.trim() === '' || state.settling || state.held}
          onClick={save}
        >
          Save
        </button>
        <button class="ghostbtn" type="button" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function PagesSection(): preact.JSX.Element {
  const pages = useStore((s) => s.pages);
  const state = useStore((s) => s.pageState);
  const [adding, setAdding] = useState(false);
  const full = pages.length >= MAX_PAGES;
  const canCapture = !state.settling && !state.held;
  const reason = captureBlocker(full, state);
  const scores = new Map(state.scores.map((s) => [s.pageId, s]));
  const active = pages.find((p) => p.id === state.activePageId);
  return (
    <ConfigSection title="Follow Elgato pages" compact>
      <p class="xkeys-sub" id="pagesStatus">
        {statusText(pages, state)}
      </p>
      <div class="page-actions">
        <button
          class="ghostbtn"
          id="pageSnapshotBtn"
          type="button"
          disabled={!canCapture || full}
          title={reason}
          onClick={() => setAdding(true)}
        >
          Save current page…
        </button>
      </div>
      {adding && (
        <PageSnapshotForm state={state} activeName={active?.name} onDone={() => setAdding(false)} />
      )}
      <ul class="pages-list">
        {pages.map((page) => (
          <PageRow
            key={page.id}
            page={page}
            columns={state.columns}
            score={scores.get(page.id)}
            active={page.id === state.activePageId}
            canCapture={canCapture}
          />
        ))}
      </ul>
    </ConfigSection>
  );
}
