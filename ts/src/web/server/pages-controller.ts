// WebUI side of page-following layouts for the SELECTED dock: the recognition state the
// docks push in (main/page-tracker.ts), and the saved-page edits. Frame hashes stay here;
// the browser only sees PageSummary / PageStateMsg.
import {
  MAX_PAGES,
  consideredKeys,
  nextPageId,
  pageIgnoreError,
  pageMinMatchError,
  pageNameError,
  toPageSummary,
  withPageLayout,
} from '../../shared/page-config.js';
import type { PageDefinition } from '../../shared/page-config.js';
import type { PageObservation } from '../../shared/page-match.js';
import type { ExtraKeyConfig } from '../../shared/types.js';
import type { PageStateMsg, PageSummary } from '../contract.js';
import type { ControllerHost, PageLayoutPort, ReqError } from './types.js';

/** Before the first observation: nothing known, nothing to snapshot. */
export const EMPTY_PAGE_STATE: PageStateMsg = {
  activePageId: null,
  source: 'fingerprint',
  keyCount: 0,
  columns: 0,
  scores: [],
  suggestedIgnore: [],
  settling: false,
  held: true,
};

const NOTHING_TO_MATCH = 'every key is ignored — leave at least one key that identifies the page';
const NO_DEVICE: ReqError = { error: 'no connected device to configure', status: 409 };
const err = (error: string, status: number): ReqError => ({ error, status });
const unknownPage = (): ReqError => err('unknown page', 404);

const stateOf = (obs: PageObservation): PageStateMsg => ({
  activePageId: obs.activePageId,
  source: 'fingerprint',
  keyCount: obs.keyCount,
  columns: obs.columns,
  scores: obs.scores,
  suggestedIgnore: obs.suggestedIgnore,
  settling: obs.settling,
  held: obs.held,
});

const asIndexList = (v: number[]): number[] => [...new Set(v)].toSorted((a, b) => a - b);

export class PagesController implements PageLayoutPort {
  private readonly observations = new Map<number, PageObservation>();
  /** JSON of the last pageState sent per dock, so an unchanged one costs no WS traffic. */
  private readonly sent = new Map<number, string>();

  constructor(private readonly host: ControllerHost) {}

  private get prefs() {
    return this.host.settings.for(this.host.selectedDeviceKey());
  }

  private get observation(): PageObservation | undefined {
    return this.observations.get(this.host.selectedDock());
  }

  notifyObservation(dock: number, obs: PageObservation): void {
    this.observations.set(dock, obs);
    if (dock !== this.host.selectedDock()) return;
    const state = stateOf(obs);
    const json = JSON.stringify(state);
    if (this.sent.get(dock) === json) return;
    this.sent.set(dock, json);
    this.host.broadcast('pageState', state);
  }

  pruneDeadDocks(live: ReadonlySet<number>): void {
    for (const dock of this.observations.keys()) {
      if (live.has(dock)) continue;
      this.observations.delete(dock);
      this.sent.delete(dock);
    }
  }

  selectedState(): PageStateMsg {
    const obs = this.observation;
    return obs ? stateOf(obs) : EMPTY_PAGE_STATE;
  }

  selectedPages(): PageSummary[] {
    const status = this.host.selectedDockStatus();
    const obs = this.observation;
    const profile = obs?.profile ?? status?.coraProfile ?? status?.modelId ?? '';
    const keyCount = obs?.keyCount ?? status?.keyCount ?? 0;
    return this.prefs.pages().map((page) => toPageSummary(page, profile, keyCount));
  }

  selectedActivePage(): PageDefinition | undefined {
    const id = this.observation?.activePageId;
    return id ? this.prefs.pages().find((p) => p.id === id) : undefined;
  }

  /** Re-push the selected dock's list and recognition (dock switch, settings import). */
  broadcastSelected(): void {
    this.host.broadcast('pages', { pages: this.selectedPages() });
    const state = this.selectedState();
    this.sent.set(this.host.selectedDock(), JSON.stringify(state));
    this.host.broadcast('pageState', state);
  }

  trySnapshot(body: { name?: unknown; ignore?: unknown }): { page: PageSummary } | ReqError {
    const nameError = pageNameError(body.name);
    if (nameError) return err(nameError, 400);
    const captured = this.capturable();
    if ('error' in captured) return captured;
    const pages = this.prefs.pages();
    if (pages.length >= MAX_PAGES) return err(`at most ${MAX_PAGES} pages per device`, 409);
    const ignore = this.ignoreOf(body.ignore ?? captured.suggestedIgnore, captured.keyCount);
    if (typeof ignore === 'string') return err(ignore, 400);
    const page: PageDefinition = {
      id: nextPageId(pages),
      name: (body.name as string).trim(),
      profile: captured.profile,
      keyCount: captured.keyCount,
      hashes: [...captured.hashes],
      ...(ignore.length > 0 ? { ignore } : {}),
    };
    if (consideredKeys(page).length === 0) return err(NOTHING_TO_MATCH, 422);
    return this.commit([...pages, page], page.id);
  }

  tryUpdate(body: {
    id?: unknown;
    name?: unknown;
    ignore?: unknown;
    minMatch?: unknown;
  }): { page: PageSummary } | ReqError {
    const page = this.find(body.id);
    if (!page) return unknownPage();
    const next: PageDefinition = { ...page };
    if (body.name !== undefined) {
      const nameError = pageNameError(body.name);
      if (nameError) return err(nameError, 400);
      next.name = (body.name as string).trim();
    }
    if (body.ignore !== undefined) {
      const ignore = this.ignoreOf(body.ignore, page.keyCount);
      if (typeof ignore === 'string') return err(ignore, 400);
      if (ignore.length > 0) next.ignore = ignore;
      else delete next.ignore;
    }
    if (body.minMatch !== undefined) {
      const minMatchError = pageMinMatchError(body.minMatch);
      if (minMatchError) return err(minMatchError, 400);
      next.minMatch = body.minMatch as number;
    }
    if (consideredKeys(next).length === 0) return err(NOTHING_TO_MATCH, 422);
    return this.commit(this.replace(next), next.id);
  }

  /** Re-record the hashes (and profile / key count) from what the deck shows now. */
  tryRecapture(body: { id?: unknown }): { page: PageSummary } | ReqError {
    const page = this.find(body.id);
    if (!page) return unknownPage();
    const captured = this.capturable();
    if ('error' in captured) return captured;
    const ignore = (page.ignore ?? []).filter((k) => k < captured.keyCount);
    const next: PageDefinition = {
      ...page,
      profile: captured.profile,
      keyCount: captured.keyCount,
      hashes: [...captured.hashes],
      ignore,
    };
    if (ignore.length === 0) delete next.ignore;
    if (consideredKeys(next).length === 0) return err(NOTHING_TO_MATCH, 422);
    return this.commit(this.replace(next), next.id);
  }

  /** 'own' copies the default layout into the page; 'default' drops the page's own layout. */
  trySetLayout(body: { id?: unknown; mode?: unknown }): { page: PageSummary } | ReqError {
    const page = this.find(body.id);
    if (!page) return unknownPage();
    if (body.mode !== 'own' && body.mode !== 'default') {
      return err("mode must be 'own' or 'default'", 400);
    }
    const own =
      body.mode === 'own' ? (page.extraKeys ?? { ...this.prefs.extraKeyConfigs() }) : undefined;
    return this.commit(withPageLayout(this.prefs.pages(), page.id, own), page.id);
  }

  tryDelete(body: { id?: unknown }): { ok: true } | ReqError {
    const page = this.find(body.id);
    if (!page) return unknownPage();
    const failed = this.persist(this.prefs.pages().filter((p) => p.id !== page.id));
    return failed ?? { ok: true };
  }

  /** Apply `edit` to a page's own layout map (the extra-key POSTs with a pageId). */
  tryEditLayout(
    pageId: string,
    edit: (map: Record<string, ExtraKeyConfig>) => Record<string, ExtraKeyConfig>,
  ): ReqError | null {
    const page = this.find(pageId);
    if (!page) return unknownPage();
    if (!page.extraKeys) {
      return err('this page uses the default layout — give it its own layout first', 409);
    }
    const next = withPageLayout(this.prefs.pages(), page.id, edit({ ...page.extraKeys }));
    return this.persist(next);
  }

  private find(id: unknown): PageDefinition | undefined {
    return typeof id === 'string' ? this.prefs.pages().find((p) => p.id === id) : undefined;
  }

  private replace(page: PageDefinition): PageDefinition[] {
    return this.prefs.pages().map((p) => (p.id === page.id ? page : p));
  }

  /** The deck's current frames, when a snapshot of them is trustworthy. */
  private capturable(): ReqError | PageObservation {
    const obs = this.observation;
    if (!obs) return err('the Elgato app has not shown a page yet', 409);
    if (obs.settling) return err('the page is still changing — try again in a moment', 409);
    if (obs.held) return err('not enough different key images to recognize this page', 409);
    return obs;
  }

  private ignoreOf(v: unknown, keyCount: number): number[] | string {
    const invalid = pageIgnoreError(v, keyCount);
    return invalid ?? asIndexList(v as number[]);
  }

  private commit(next: PageDefinition[], id: string): { page: PageSummary } | ReqError {
    const failed = this.persist(next);
    if (failed) return failed;
    const page = this.selectedPages().find((p) => p.id === id);
    return { page: page! };
  }

  /** Persist, tell WS clients, and have the dock re-match (app.ts → Dock.pages.reload). */
  private persist(next: PageDefinition[]): ReqError | null {
    if (!this.prefs.setPages(next)) return NO_DEVICE;
    this.host.broadcast('pages', { pages: this.selectedPages() });
    this.host.emit('pagesChanged', this.host.selectedDock());
    return null;
  }
}
