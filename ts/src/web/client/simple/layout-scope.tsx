// Which side-key layout the editor below edits: the default one, or a saved page's own.
import { patch, useStore } from '../lib/store.js';
import type { StoreState } from '../lib/store.js';
import type { ExtraKeyCfg } from '../ui-types.js';
import { ChipRadioGroup } from '../components/ChipRadioGroup.js';

type ScopeState = Pick<StoreState, 'extraKeys' | 'pages' | 'pageState' | 'layoutScope'>;

const DEFAULT_SCOPE = 'default';

/** The configs the editor shows: the scoped page's own layout, else the default map. */
export function scopedConfigs(state: ScopeState): Record<string, ExtraKeyCfg> {
  const page = state.pages.find((p) => p.id === state.layoutScope);
  return page?.extraKeys ?? state.extraKeys;
}

/** True when the scoped layout is the one on the deck now (Run now only works there). */
export function scopeIsLive(state: ScopeState): boolean {
  const active = state.pages.find((p) => p.id === state.pageState.activePageId);
  if (state.layoutScope === null) return !active?.extraKeys;
  return state.pageState.activePageId === state.layoutScope;
}

export function LayoutScopeBar(): preact.JSX.Element | null {
  const pages = useStore((s) => s.pages);
  const scope = useStore((s) => s.layoutScope);
  const live = useStore((s) => scopeIsLive(s));
  const own = pages.filter((p) => p.extraKeys);
  if (own.length === 0) return null;
  return (
    <div class="layout-scope">
      <ChipRadioGroup
        name="layoutScope"
        label="Layout to edit"
        value={scope ?? DEFAULT_SCOPE}
        options={[
          { value: DEFAULT_SCOPE, label: 'Default' },
          ...own.map((p) => ({ value: p.id, label: p.name })),
        ]}
        onChange={(value) => patch({ layoutScope: value === DEFAULT_SCOPE ? null : value })}
      />
      {!live && (
        <p class="xkeys-sub">Not on the deck right now — previews show the active layout.</p>
      )}
    </div>
  );
}
