// Extensions: one ExtensionHost (worker) per enabled extension, the enable switch, and the
// fan-out of dock events to every running one. See docs/extensions.md.
import { ExtensionHost } from '../../extension/extension-host.js';
import type {
  ExtensionHostOptions,
  ExtensionReply,
  ExtensionRunState,
} from '../../extension/extension-host.js';
import { EXTENSION_EVENT_TYPES } from '../../extension/api.js';
import type { ExtensionEvent, ExtensionEventType, ExtensionRequest } from '../../extension/api.js';
import { extensionsDir } from '../../infra/settings-store.js';
import type { ExtensionGrant } from '../../infra/settings-store.js';
import { extensionsDisabled } from '../../shared/cli.js';
import { log } from '../../shared/logger.js';
import { readExtension, scanExtensions } from './extension-manifest.js';
import type { FoundExtension } from './extension-manifest.js';
import type { ControllerHost, ExtensionInfo, ExtensionsView, ReqError } from './types.js';

/** What the controller needs from an ExtensionHost — injectable for tests. */
export interface ExtensionHostLike {
  readonly state: ExtensionRunState;
  readonly error: string | undefined;
  start(): void;
  stop(): void;
  emit(event: ExtensionEvent): void;
  request(req: ExtensionRequest): Promise<ExtensionReply>;
}

export interface ExtensionsControllerOptions {
  dir?: string;
  /** DeckBridge process start, handed to each extension. */
  appStartedAt?: number;
  createHost?: (opts: ExtensionHostOptions) => ExtensionHostLike;
}

const CHANGED_TEXT =
  'files changed since you switched it on; switch it off and on to run the new files';

function stateOf(
  f: FoundExtension,
  h: ExtensionHostLike | undefined,
  grant: ExtensionGrant | undefined,
): ExtensionInfo['state'] {
  if (f.problem !== undefined) return 'invalid';
  if (h) return h.state;
  // A switched-on extension whose files moved on does not run until the user switches it again.
  if (grant && grant.digest !== f.digest) return 'changed';
  return 'disabled';
}

/** Grant entries that name a known event type; unknown names are dropped, not fatal. */
function knownEvents(events: readonly string[]): ExtensionEventType[] {
  return events.filter((e): e is ExtensionEventType =>
    (EXTENSION_EVENT_TYPES as readonly string[]).includes(e),
  );
}

function errorOf(
  f: FoundExtension,
  h: ExtensionHostLike | undefined,
  state: ExtensionInfo['state'],
): string | undefined {
  return f.problem ?? h?.error ?? (state === 'changed' ? CHANGED_TEXT : undefined);
}

export class ExtensionsController {
  readonly dir: string;
  private readonly appStartedAt: number;
  private readonly createHost: (opts: ExtensionHostOptions) => ExtensionHostLike;
  private found = new Map<string, FoundExtension>();
  private readonly hosts = new Map<string, ExtensionHostLike>();
  private readonly revs = new Map<string, number>();
  private deckSource: () => ExtensionEvent[] = () => [];
  private scanSeq = 0;
  private disposed = false;

  constructor(
    private readonly host: Pick<ControllerHost, 'settings' | 'broadcast'>,
    opts: ExtensionsControllerOptions = {},
  ) {
    this.dir = opts.dir ?? extensionsDir(host.settings.cacheRoot);
    this.appStartedAt = opts.appStartedAt ?? Date.now();
    this.createHost = opts.createHost ?? ((o) => new ExtensionHost(o));
  }

  /** False = no running extension takes this type, so the dock hooks skip building it. */
  wants(type: ExtensionEventType): boolean {
    for (const [id, h] of this.hosts) {
      if (h.state !== 'error' && this.grant(id)?.events.includes(type)) return true;
    }
    return false;
  }

  /** The decks already attached, replayed to an extension when it starts. */
  setDeckSource(source: () => ExtensionEvent[]): void {
    this.deckSource = source;
  }

  emit(event: ExtensionEvent): void {
    for (const h of this.hosts.values()) h.emit(event);
  }

  /** Re-read the folder: start enabled newcomers, stop what vanished or broke. A failed
   *  read keeps the last result, so a hiccup does not stop running extensions. */
  async rescan(): Promise<void> {
    const seq = ++this.scanSeq;
    let found: Map<string, FoundExtension>;
    try {
      found = await scanExtensions(this.dir);
    } catch (e) {
      log('warn', 'extensions', `cannot read ${this.dir}: ${(e as Error).message}`);
      return;
    }
    // Overlapping rescans: only the newest may apply.
    if (this.disposed || seq !== this.scanSeq) return;
    this.found = found;
    this.warnChanged(found);
    for (const id of this.hosts.keys()) if (!this.runnable(id)) this.stopHost(id);
    // Safe mode: the list still shows what is installed, but nothing starts.
    if (!extensionsDisabled()) {
      for (const id of Object.keys(this.host.settings.extensionGrants)) {
        if (this.runnable(id) && !this.hosts.has(id)) this.startHost(id);
      }
    }
    this.publish();
  }

  /** Enabling a running extension restarts it: the way out of 'error', and a code reload.
   *  Enabling pins the folder as it is now; the digest is what the user approved. */
  async setEnabled(id: unknown, enabled: unknown): Promise<ReqError | null> {
    if (typeof id !== 'string' || typeof enabled !== 'boolean') {
      return { error: 'id (string) and enabled (boolean) are required', status: 400 };
    }
    if (enabled && extensionsDisabled()) {
      return { error: 'extensions are off for this session (--no-extensions)', status: 409 };
    }
    // Off is always allowed: a deleted folder must not leave its id switched on.
    if (!enabled) {
      const wasOn = this.grant(id) !== undefined;
      this.host.settings.revokeExtension(id);
      this.stopHost(id);
      if (wasOn) log('info', 'extensions', `${id} switched off`);
      this.publish();
      return null;
    }
    if (!this.found.has(id)) return { error: `unknown extension: ${id}`, status: 404 };
    // Re-read: the digest pinned must be of the files as they are now.
    const fresh = await readExtension(this.dir, id);
    if (this.disposed) return null;
    this.found.set(id, fresh);
    if (fresh.problem !== undefined || !fresh.manifest || !fresh.digest) {
      // A running copy of the old files must not outlive the folder it came from.
      this.stopHost(id);
      this.publish();
      return { error: fresh.problem ?? 'unreadable', status: 409 };
    }
    const grant = { digest: fresh.digest, events: [...fresh.manifest.permissions.events] };
    this.host.settings.grantExtension(id, grant);
    log('info', 'extensions', `${id} switched on (digest ${grant.digest.slice(0, 12)})`);
    this.stopHost(id);
    this.startHost(id);
    this.publish();
    return null;
  }

  view(): ExtensionsView {
    return {
      dir: this.dir,
      extensions: [...this.found.values()].map((f) => this.info(f)),
      ...(extensionsDisabled() ? { safeMode: true as const } : {}),
    };
  }

  /** Never rejects; an extension that is not running answers 404. */
  request(id: string, req: ExtensionRequest): Promise<ExtensionReply> {
    const h = this.hosts.get(id);
    if (!h) {
      return Promise.resolve({
        status: 404,
        json: JSON.stringify({ error: 'extension not running' }),
      });
    }
    return h.request(req);
  }

  /** ui.js of a running extension that declares a page; null = 404. */
  uiScript(id: string): string | null {
    const found = this.found.get(id);
    if (!found?.manifest?.page || this.hosts.get(id)?.state !== 'running') return null;
    return found.uiJs ?? null;
  }

  /** Shutdown: stop every worker; later rescans do nothing. */
  dispose(): void {
    this.disposed = true;
    for (const id of this.hosts.keys()) this.stopHost(id);
  }

  /** The grant for `id`, if switched on. Own keys only: an id like 'constructor' must not match. */
  private grant(id: string): ExtensionGrant | undefined {
    const grants = this.host.settings.extensionGrants;
    return Object.hasOwn(grants, id) ? grants[id] : undefined;
  }

  /** A switched-on extension whose files moved on stays stopped; say so once per rescan. */
  private warnChanged(found: Map<string, FoundExtension>): void {
    for (const id of Object.keys(this.host.settings.extensionGrants)) {
      const f = found.get(id);
      const changed =
        f?.problem === undefined && f?.digest !== undefined && f.digest !== this.grant(id)?.digest;
      if (changed)
        log('warn', 'extensions', `${id}: files changed since it was switched on; not started`);
    }
  }

  private runnable(id: string): boolean {
    const f = this.found.get(id);
    const grant = this.grant(id);
    return (
      f !== undefined && f.problem === undefined && grant !== undefined && grant.digest === f.digest
    );
  }

  private startHost(id: string): void {
    const found = this.found.get(id)!;
    const grant = this.grant(id);
    this.revs.set(id, (this.revs.get(id) ?? 0) + 1);
    const h = this.createHost({
      id,
      serverPath: `${found.dir}/server.js`,
      appStartedAt: this.appStartedAt,
      onState: () => this.publish(),
      initialEvents: () => this.deckSource(),
      events: grant ? knownEvents(grant.events) : [],
    });
    this.hosts.set(id, h);
    h.start();
  }

  private stopHost(id: string): void {
    this.hosts.get(id)?.stop();
    this.hosts.delete(id);
  }

  private info(f: FoundExtension): ExtensionInfo {
    const h = this.hosts.get(f.id);
    const grant = this.grant(f.id);
    const state = stateOf(f, h, grant);
    const error = errorOf(f, h, state);
    const m = f.manifest;
    return {
      id: f.id,
      name: m?.name ?? f.id,
      version: m?.version ?? '',
      ...(m?.description === undefined ? {} : { description: m.description }),
      enabled: grant !== undefined,
      state,
      ...(error === undefined ? {} : { error }),
      ...(m?.page ? { page: m.page } : {}),
      rev: this.revs.get(f.id) ?? 0,
    };
  }

  private publish(): void {
    if (!this.disposed) this.host.broadcast('extensions', this.view());
  }
}
