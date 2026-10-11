// Extensions: one ExtensionHost (worker) per enabled extension, the enable switch, and the
// fan-out of dock events to every running one. See docs/extensions.md.
import { ExtensionHost } from '../../extension/extension-host.js';
import type {
  ExtensionHostOptions,
  ExtensionReply,
  ExtensionRunState,
} from '../../extension/extension-host.js';
import type { ExtensionEvent, ExtensionRequest } from '../../extension/api.js';
import { extensionsDir } from '../../infra/settings-store.js';
import { log } from '../../shared/logger.js';
import { scanExtensions } from './extension-manifest.js';
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

function stateOf(f: FoundExtension, h: ExtensionHostLike | undefined): ExtensionInfo['state'] {
  if (f.problem !== undefined) return 'invalid';
  return h ? h.state : 'disabled';
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

  /** False = no extension takes events, so the dock hooks skip building them. */
  get active(): boolean {
    for (const h of this.hosts.values()) if (h.state !== 'error') return true;
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
      log('warn', 'ext', `cannot read ${this.dir}: ${(e as Error).message}`);
      return;
    }
    // Overlapping rescans: only the newest may apply.
    if (this.disposed || seq !== this.scanSeq) return;
    this.found = found;
    for (const id of this.hosts.keys()) if (!this.runnable(id)) this.stopHost(id);
    for (const id of this.host.settings.enabledExtensions) {
      if (this.runnable(id) && !this.hosts.has(id)) this.startHost(id);
    }
    this.publish();
  }

  /** Enabling a running extension restarts it: the way out of 'error', and a code reload. */
  setEnabled(id: unknown, enabled: unknown): ReqError | null {
    if (typeof id !== 'string' || typeof enabled !== 'boolean') {
      return { error: 'id (string) and enabled (boolean) are required', status: 400 };
    }
    const found = this.found.get(id);
    // Off is always allowed: a deleted folder must not leave its id switched on.
    if (enabled && !found) return { error: `unknown extension: ${id}`, status: 404 };
    if (enabled && found?.problem !== undefined) return { error: found.problem, status: 409 };
    this.host.settings.setExtensionEnabled(id, enabled);
    this.stopHost(id);
    if (enabled) this.startHost(id);
    this.publish();
    return null;
  }

  view(): ExtensionsView {
    return { dir: this.dir, extensions: [...this.found.values()].map((f) => this.info(f)) };
  }

  /** Never rejects; an extension that is not running answers 404. */
  request(id: string, req: ExtensionRequest): Promise<ExtensionReply> {
    const h = this.hosts.get(id);
    if (!h) return Promise.resolve({ status: 404, body: { error: 'extension not running' } });
    return h.request(req);
  }

  /** ui.js of a running extension that declares a page; null = 404. */
  async uiScript(id: string): Promise<string | null> {
    const found = this.found.get(id);
    if (!found?.manifest?.page || this.hosts.get(id)?.state !== 'running') return null;
    try {
      return new TextDecoder().decode(await tjs.readFile(`${found.dir}/ui.js`));
    } catch {
      return null;
    }
  }

  /** Shutdown: stop every worker; later rescans do nothing. */
  dispose(): void {
    this.disposed = true;
    for (const id of this.hosts.keys()) this.stopHost(id);
  }

  private runnable(id: string): boolean {
    const f = this.found.get(id);
    return f !== undefined && f.problem === undefined;
  }

  private startHost(id: string): void {
    const found = this.found.get(id)!;
    this.revs.set(id, (this.revs.get(id) ?? 0) + 1);
    const h = this.createHost({
      id,
      serverPath: `${found.dir}/server.js`,
      appStartedAt: this.appStartedAt,
      onState: () => this.publish(),
      initialEvents: () => this.deckSource(),
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
    const error = f.problem ?? h?.error;
    const m = f.manifest;
    return {
      id: f.id,
      name: m?.name ?? f.id,
      version: m?.version ?? '',
      ...(m?.description === undefined ? {} : { description: m.description }),
      enabled: this.host.settings.enabledExtensions.includes(f.id),
      state: stateOf(f, h),
      ...(error === undefined ? {} : { error }),
      ...(m?.page ? { page: m.page } : {}),
      rev: this.revs.get(f.id) ?? 0,
    };
  }

  private publish(): void {
    if (!this.disposed) this.host.broadcast('extensions', this.view());
  }
}
