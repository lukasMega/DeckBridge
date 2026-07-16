/** Main-thread host for the shared plugin Worker. Owns the worker lifecycle
 *  (lazy start when the first plugin key is configured, stop when none remain),
 *  caches the latest value per (plugin file, arg), runs the ctx.fetch proxy on
 *  the main thread (worker fetch would SIGABRT — Phase 0 S2), and watches the
 *  worker with a heartbeat: a hung/crashed worker is terminated and respawned,
 *  and after MAX_CONSECUTIVE_KILLS respawns the plugins are disabled (ERR) until
 *  their config changes, so a crash-looping plugin can't burn the CPU. */
import pluginWorkerSource from 'virtual:plugin-worker';
import { pluginsDir } from './settings-store.js';
import { log } from './logger.js';
import type { MainToPluginWorker, PluginWorkerToMain } from './plugin-worker-protocol.js';

const HEARTBEAT_MS = 2000;
const MAX_MISSED_PONGS = 2; // ~4 s of silence → presume the worker wedged
const MAX_CONSECUTIVE_KILLS = 3;
const STALE_MS = 3000; // a key not re-requested this long (≥2 scheduler ticks) is dropped
const FETCH_TIMEOUT_MS = 10_000;

export type PluginStatus = 'pending' | 'ok' | 'err' | 'disabled';
export interface PluginValue {
  /** undefined = no value yet; null = plugin returned null (clear the key). */
  value: string | null | undefined;
  status: PluginStatus;
}

/** The subset of Worker the host uses — injectable so tests drive a fake. */
export interface WorkerLike {
  postMessage(msg: MainToPluginWorker): void;
  terminate(): void;
  addEventListener(type: 'message' | 'error', listener: (ev: MessageEvent) => void): void;
}
export type WorkerFactory = () => WorkerLike;

function defaultWorkerFactory(): WorkerLike {
  const url = URL.createObjectURL(
    new Blob([pluginWorkerSource], { type: 'application/javascript' }),
  );
  const w = new Worker(url, { type: 'module' });
  return {
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Worker.postMessage takes no targetOrigin
    postMessage: (m) => w.postMessage(m),
    terminate: () => {
      try {
        w.terminate();
      } finally {
        try {
          URL.revokeObjectURL(url);
        } catch {
          /* ignore */
        }
      }
    },
    addEventListener: (t, l) => w.addEventListener(t, l as EventListener),
  };
}

interface HostEntry {
  key: string;
  file: string;
  param: string;
  path: string;
  intervalMs?: number;
  configSig: string;
  value: string | null | undefined;
  status: PluginStatus;
  lastRequested: number;
  onUpdate: () => void;
}

const entryKey = (file: string, arg: string): string => `${file}\0${arg}`;

/** A plugin `param` is either a bare file name (resolved against the plugins
 *  dir) or an absolute path to a plugin anywhere on disk (WebUI "Custom path…"). */
const isAbsolutePath = (p: string): boolean => p.startsWith('/') || /^[a-z]:[\\/]/i.test(p);

export class PluginHost {
  private readonly dir: string;
  private readonly workerFactory: WorkerFactory;
  private readonly entries = new Map<string, HostEntry>();
  private worker: WorkerLike | null = null;
  private hbTimer: ReturnType<typeof setInterval> | undefined;
  private awaitingPong = false;
  private missedPongs = 0;
  private pingSeq = 0;
  private killCount = 0;
  private configSent = '';

  constructor(opts?: { pluginsDir?: string; workerFactory?: WorkerFactory }) {
    this.dir = opts?.pluginsDir ?? pluginsDir();
    this.workerFactory = opts?.workerFactory ?? defaultWorkerFactory;
  }

  /** Cached value for a plugin key, registering/refreshing it as a side effect.
   *  `file` is the plugin file name (ExtraKeyConfig.param); `arg` is the per-key
   *  argument (ExtraKeyConfig.pluginArg). Empty file = unconfigured → pending. */
  request(
    file: string | undefined,
    arg: string | undefined,
    intervalMs: number | undefined,
    onUpdate: () => void,
  ): PluginValue {
    const f = file?.trim();
    if (!f) return { value: undefined, status: 'pending' };
    const param = arg ?? '';
    const key = entryKey(f, param);
    const sig = String(intervalMs ?? '');
    const now = Date.now();

    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        key,
        file: f,
        param,
        path: isAbsolutePath(f) ? f : `${this.dir}/${f}`,
        intervalMs,
        configSig: sig,
        value: undefined,
        status: 'pending',
        lastRequested: now,
        onUpdate,
      };
      this.entries.set(key, entry);
      this.killCount = 0; // fresh config → the worker gets fresh tries
      this.syncConfig();
    } else {
      entry.onUpdate = onUpdate;
      entry.lastRequested = now;
      if (entry.configSig !== sig) {
        entry.configSig = sig;
        entry.intervalMs = intervalMs;
        if (entry.status === 'disabled') {
          entry.status = 'pending';
          entry.value = undefined;
        }
        this.killCount = 0;
        this.syncConfig();
      }
    }
    return { value: entry.value, status: entry.status };
  }

  /** Current status of a plugin key for the WebUI (no side effects). */
  statusOf(file: string, arg?: string): PluginStatus {
    return this.entries.get(entryKey(file, arg ?? ''))?.status ?? 'pending';
  }

  /** Terminate the worker and stop the heartbeat. Cached entries are kept. */
  stop(): void {
    if (this.hbTimer !== undefined) {
      clearInterval(this.hbTimer);
      this.hbTimer = undefined;
    }
    this.teardownWorker();
  }

  // ── config push ────────────────────────────────────────────────────────────
  private activeEntries(): HostEntry[] {
    return [...this.entries.values()].filter((e) => e.status !== 'disabled');
  }

  private syncConfig(): void {
    const active = this.activeEntries();
    if (active.length === 0) {
      this.configSent = '';
      this.stop();
      return;
    }
    this.ensureWorker();
    const plugins = active.map((e) => ({
      key: e.key,
      path: e.path,
      param: e.param,
      intervalMs: e.intervalMs,
    }));
    const sig = JSON.stringify(plugins);
    if (sig === this.configSent) return; // no change since last push
    this.configSent = sig;
    this.post({ type: 'configure', plugins });
  }

  // ── worker lifecycle + heartbeat ─────────────────────────────────────────────
  private ensureWorker(): void {
    if (this.worker) return;
    this.worker = this.workerFactory();
    this.worker.addEventListener('message', (e) => this.onMessage(e.data as PluginWorkerToMain));
    this.worker.addEventListener('error', (e) =>
      this.onWorkerDead((e as unknown as { message?: string }).message ?? 'worker error'),
    );
    this.awaitingPong = false;
    this.missedPongs = 0;
    this.configSent = '';
    if (this.hbTimer === undefined) {
      this.hbTimer = setInterval(() => this.hbTick(), HEARTBEAT_MS);
    }
  }

  private teardownWorker(): void {
    const w = this.worker;
    this.worker = null;
    this.awaitingPong = false;
    // Defer terminate a macrotask: killing a worker synchronously from inside an
    // onmessage/onerror callback races txiki's worker libuv loop (see
    // hid-worker-host.cleanupWorker for the same footgun).
    if (w) setTimeout(() => w.terminate(), 0);
  }

  private hbTick(): void {
    if (this.awaitingPong) {
      this.missedPongs++;
      if (this.missedPongs >= MAX_MISSED_PONGS) {
        this.onWorkerDead('heartbeat timeout');
        return;
      }
    } else {
      this.missedPongs = 0;
    }
    this.post({ type: 'ping', seq: ++this.pingSeq });
    this.awaitingPong = true;
    this.reap();
  }

  /** Drop keys no scheduler has asked about recently (config removed / dock
   *  gone), pushing a fresh config so the worker stops those poll loops. */
  private reap(): void {
    const now = Date.now();
    let changed = false;
    for (const [key, e] of this.entries) {
      if (now - e.lastRequested > STALE_MS) {
        this.entries.delete(key);
        changed = true;
      }
    }
    if (changed) this.syncConfig();
  }

  private onWorkerDead(reason: string): void {
    log('warn', 'plugin', `plugin worker died (${reason}); respawning`);
    this.teardownWorker();
    this.killCount++;
    if (this.killCount >= MAX_CONSECUTIVE_KILLS) {
      log(
        'warn',
        'plugin',
        `plugin worker killed ${this.killCount}× — disabling plugins until config change`,
      );
      for (const e of this.entries.values()) {
        e.status = 'disabled';
        e.value = undefined;
        e.onUpdate();
      }
      this.stop();
      return;
    }
    this.syncConfig(); // respawn + reload every active plugin
  }

  // ── worker → main ────────────────────────────────────────────────────────────
  private onMessage(msg: PluginWorkerToMain): void {
    switch (msg.type) {
      case 'value':
        this.applyValue(msg.key, msg.value);
        break;
      case 'error':
        this.applyError(msg.key, msg.message);
        break;
      case 'fetch':
        void this.runFetch(msg.fetchId, msg.url, msg.init);
        break;
      case 'pong':
        this.awaitingPong = false;
        this.killCount = 0;
        break;
      case 'log':
        log(msg.level, msg.component, msg.message);
        break;
    }
  }

  private applyValue(key: string, value: string | null): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.value = value;
    entry.status = 'ok';
    entry.onUpdate();
  }

  private applyError(key: string, message: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    log('warn', 'plugin', `${entry.file}: ${message}`);
    entry.status = 'err';
    entry.onUpdate();
  }

  /** Run a plugin's proxied fetch on the main thread. Only plain http:// works
   *  (the slim build has no TLS); a per-call timeout guards a slow endpoint. */
  private async runFetch(
    fetchId: number,
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string } | undefined,
  ): Promise<void> {
    try {
      if (!/^http:\/\//i.test(url)) {
        throw new Error('only http:// is supported (no TLS in this build)');
      }
      const res = await withTimeout(
        fetch(url, { method: init?.method, headers: init?.headers, body: init?.body }),
        FETCH_TIMEOUT_MS,
      );
      const body = await res.text();
      this.post({ type: 'fetchResult', fetchId, ok: res.ok, status: res.status, body });
    } catch (e) {
      this.post({
        type: 'fetchResult',
        fetchId,
        ok: false,
        status: 0,
        body: '',
        error: (e as Error).message,
      });
    }
  }

  private post(msg: MainToPluginWorker): void {
    this.worker?.postMessage(msg);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error('fetch timeout')), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

// ── module-level singleton (mirrors the weather/command caches in extra-keys) ──
let host: PluginHost | null = null;
function getPluginHost(): PluginHost {
  host ??= new PluginHost();
  return host;
}

/** Cached value for a plugin widget key, kicking off the poll loop as a side
 *  effect (repaints via onUpdate when a value arrives). */
export function pluginValueFor(
  file: string | undefined,
  arg: string | undefined,
  intervalMs: number | undefined,
  onUpdate: () => void,
): PluginValue {
  return getPluginHost().request(file, arg, intervalMs, onUpdate);
}

/** Status of a configured plugin key for the WebUI (Phase 2 consumer). */
export function pluginKeyStatus(file: string, arg?: string): PluginStatus {
  return getPluginHost().statusOf(file, arg);
}

/** List the *.js plugin files the user has dropped in the plugins dir — for the
 *  WebUI dropdown. Returns [] if the dir is missing/unreadable. */
export async function listPluginFiles(dir: string = pluginsDir()): Promise<string[]> {
  try {
    const out: string[] = [];
    for await (const e of await tjs.readDir(dir)) {
      if (e.isFile && e.name.endsWith('.js')) out.push(e.name);
    }
    return out.toSorted((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}
