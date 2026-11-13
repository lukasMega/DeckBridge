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
import { GhostButton } from '../components/GhostButton.js';

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
  onCancel,
  onSaved,
}: Readonly<{
  state: PageStateMsg;
  activeName?: string;
  onCancel: () => void;
  onSaved: () => void;
}>): preact.JSX.Element {
  const [name, setName] = useState('');
  const [ignored, setIgnored] = useState<ReadonlySet<number>>(() => new Set(state.suggestedIgnore));
  const touchedRef = useRef(false);
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const [showKeys, setShowKeys] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, run] = useAction();
  useEffect(function focusPageName() {
    nameInputRef.current?.focus();
  }, []);
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
    setSaving(true);
    run(
      postJson('/api/pages/snapshot', { name: name.trim(), ignore })
        .then(onSaved)
        .finally(() => setSaving(false)),
    );
  };
  return (
    <div class="page-form">
      <input
        id="pageNameInput"
        ref={nameInputRef}
        class="input"
        type="text"
        maxLength={PAGE_NAME_MAX}
        placeholder="Page name"
        aria-label="Page name"
        value={name}
        disabled={saving}
        onInput={(e) => setName((e.target as HTMLInputElement).value)}
      />
      <GhostButton
        class="page-disclosure"
        id="pageIgnoreToggle"
        aria-expanded={showKeys}
        aria-controls="pageSnapshotKeys"
        onClick={() => setShowKeys(!showKeys)}
      >
        Ignored keys ({ignored.size})
      </GhostButton>
      {showKeys && (
        <div id="pageSnapshotKeys">
          <p class="xkeys-sub">Exclude keys that change, such as clocks or animations.</p>
          <PageKeyGrid
            label="Keys to ignore"
            keyCount={state.keyCount}
            columns={state.columns}
            ignored={ignored}
            liveImages
            onToggle={toggle}
          />
        </div>
      )}
      {activeName !== undefined && (
        <p class="xkeys-sub">Already matches "{activeName}". Save creates another page.</p>
      )}
      {error !== '' && (
        <p class="xkeys-sub" role="alert">
          {error}
        </p>
      )}
      <div class="page-actions">
        <GhostButton
          id="pageSaveBtn"
          disabled={saving || name.trim() === '' || state.settling || state.held}
          onClick={save}
        >
          {saving ? 'Saving…' : 'Save'}
        </GhostButton>
        <GhostButton disabled={saving} onClick={onCancel}>
          Cancel
        </GhostButton>
      </div>
    </div>
  );
}

export function PagesSection(): preact.JSX.Element {
  const pages = useStore((s) => s.pages);
  const state = useStore((s) => s.pageState);
  const [adding, setAdding] = useState(false);
  const [managing, setManaging] = useState(false);
  const full = pages.length >= MAX_PAGES;
  const canCapture = !state.settling && !state.held;
  const reason = captureBlocker(full, state);
  const scores = new Map(state.scores.map((s) => [s.pageId, s]));
  const active = pages.find((p) => p.id === state.activePageId);
  return (
    <ConfigSection
      title="Follow Elgato pages"
      compact
      collapsible
      toggleId="pagesToggle"
      aside={
        !adding && (
          <GhostButton
            id="pageSnapshotBtn"
            disabled={!canCapture || full}
            title={reason}
            onClick={() => setAdding(true)}
          >
            Save current page…
          </GhostButton>
        )
      }
    >
      <p class="xkeys-sub" id="pagesStatus">
        {statusText(pages, state)}
      </p>
      {pages.length > 0 && (
        <GhostButton
          class="page-disclosure"
          id="pageManageBtn"
          aria-expanded={managing}
          aria-controls="savedPagesList"
          onClick={() => setManaging(!managing)}
        >
          Saved pages ({pages.length})
        </GhostButton>
      )}
      {adding && (
        <PageSnapshotForm
          state={state}
          activeName={active?.name}
          onCancel={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            setManaging(true);
          }}
        />
      )}
      {pages.length > 0 && (
        <ul class="pages-list" id="savedPagesList" hidden={!managing}>
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
      )}
    </ConfigSection>
  );
}
