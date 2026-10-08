// One saved Elgato page: name, badges, strictness, ignored keys, layout, re-capture, delete.
import { useEffect, useRef, useState } from 'preact/hooks';
import { patch } from '../lib/store.js';
import { postJson } from '../lib/ui-api.js';
import type { PageScoreMsg, PageSummary } from '../ui-types.js';
import { ChipRadioGroup } from '../components/ChipRadioGroup.js';
import { nearestStrictness, PAGE_NAME_MAX, STRICTNESS } from '../lib/page-limits.js';
import { PageKeyGrid } from './page-key-grid.js';

const DELETE_CONFIRM_MS = 4000;

/** Run a request; show the server's message under the row when it fails. */
export function useAction(): [string, (request: Promise<unknown>) => void] {
  const [error, setError] = useState('');
  const run = (request: Promise<unknown>): void => {
    void request
      .then(() => setError(''))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  return [error, run];
}

export function PageRow({
  page,
  columns,
  score,
  active,
  canCapture,
}: Readonly<{
  page: PageSummary;
  columns: number;
  score?: PageScoreMsg;
  active: boolean;
  canCapture: boolean;
}>): preact.JSX.Element {
  const [error, run] = useAction();
  const [showOptions, setShowOptions] = useState(false);
  const [showKeys, setShowKeys] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // Local edit in progress; null shows the saved name.
  const [draft, setDraft] = useState<string | null>(null);
  const [savingName, setSavingName] = useState(false);
  const cancelledNameRef = useRef(false);
  const name = draft ?? page.name;
  const post = (path: string, body: object): Promise<unknown> =>
    postJson(path, { id: page.id, ...body });

  useEffect(
    function resetDeleteConfirm() {
      if (!confirming) return undefined;
      const timer = setTimeout(() => setConfirming(false), DELETE_CONFIRM_MS);
      return () => clearTimeout(timer);
    },
    [confirming],
  );
  const commitName = (): void => {
    if (cancelledNameRef.current) {
      cancelledNameRef.current = false;
      return;
    }
    if (draft === null || savingName) return;
    const next = name.trim();
    if (next === '' || next === page.name) {
      setDraft(null);
      return;
    }
    setSavingName(true);
    run(
      post('/api/pages/update', { name: next })
        .then(() => setDraft(null))
        .finally(() => setSavingName(false)),
    );
  };
  const toggleKey = (key: number): void => {
    const ignore = new Set(page.ignore);
    if (!ignore.delete(key)) ignore.add(key);
    run(post('/api/pages/update', { ignore: [...ignore].toSorted((a, b) => a - b) }));
  };
  const editLayout = (): void => {
    const open = (): void => patch({ layoutScope: page.id });
    if (page.extraKeys) open();
    else run(post('/api/pages/layout', { mode: 'own' }).then(open));
  };

  return (
    <li class="page-row" data-page-id={page.id}>
      <div class="page-row-head">
        <span class="page-title" title={page.name}>
          {page.name}
        </span>
        {active && <span class="dock-chip dock-chip--paired">Active</span>}
        <button class="ghostbtn" type="button" onClick={editLayout}>
          Edit layout
        </button>
        <button
          class="ghostbtn page-options-toggle"
          type="button"
          title="Page options"
          aria-label={`Options for page ${page.name}`}
          aria-expanded={showOptions}
          aria-controls={`page-options-${page.id}`}
          onClick={() => setShowOptions(!showOptions)}
        >
          <span aria-hidden="true">⋯</span>
        </button>
      </div>
      {page.stale && <span class="dock-chip dock-chip--waiting">Recorded for another layout</span>}
      {showOptions && (
        <div class="page-options" id={`page-options-${page.id}`}>
          <label class="page-actions">
            <span class="preview-label">Page name</span>
            <input
              class="input page-name"
              type="text"
              maxLength={PAGE_NAME_MAX}
              value={name}
              disabled={savingName}
              aria-label={`Name of page ${page.name}`}
              onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
              onBlur={commitName}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  cancelledNameRef.current = true;
                  setDraft(null);
                  (e.target as HTMLInputElement).blur();
                } else if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              }}
            />
          </label>
          <p class="xkeys-sub">
            {page.extraKeys ? 'Own layout' : 'Default layout'}
            {score && ` · ${score.matched}/${score.considered} keys match`}
          </p>
          <div class="page-actions">
            <span class="preview-label">Matching</span>
            <ChipRadioGroup
              name={`pageStrictness-${page.id}`}
              label={`Strictness of page ${page.name}`}
              value={nearestStrictness(page.minMatch)}
              options={STRICTNESS.map(({ value, label }) => ({
                value,
                label,
                title: `${Math.round(value * 100)}% of keys must match`,
              }))}
              onChange={(minMatch) => run(post('/api/pages/update', { minMatch }))}
            />
          </div>
          {!page.stale && (
            <button
              class="ghostbtn page-disclosure"
              type="button"
              aria-expanded={showKeys}
              aria-controls={`page-keys-${page.id}`}
              onClick={() => setShowKeys(!showKeys)}
            >
              Ignored keys ({page.ignore.length})
            </button>
          )}
          {showKeys && !page.stale && (
            <div id={`page-keys-${page.id}`}>
              <p class="xkeys-sub">Exclude keys that change, such as clocks or animations.</p>
              <PageKeyGrid
                label={`Keys ignored for page ${page.name}`}
                keyCount={page.keyCount}
                columns={columns}
                ignored={new Set(page.ignore)}
                changed={new Set(score?.mismatched)}
                onToggle={toggleKey}
              />
            </div>
          )}
          <div class="page-actions">
            {page.extraKeys && (
              <button
                class="ghostbtn"
                type="button"
                onClick={() => run(post('/api/pages/layout', { mode: 'default' }))}
              >
                Use default layout
              </button>
            )}
            <button
              class="ghostbtn"
              type="button"
              disabled={!canCapture}
              onClick={() => run(post('/api/pages/recapture', {}))}
            >
              Re-capture
            </button>
            <button
              class="ghostbtn"
              type="button"
              onClick={() =>
                confirming ? run(post('/api/pages/delete', {})) : setConfirming(true)
              }
            >
              {confirming ? 'Confirm delete' : 'Delete'}
            </button>
          </div>
        </div>
      )}
      {error !== '' && (
        <p class="xkeys-sub" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}
