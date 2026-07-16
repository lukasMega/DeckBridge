/** Plugin Worker thread entry point. Runs user-authored JS plugins in isolation
 *  from the main thread so a slow/looping/throwing plugin can never stall the
 *  CORA ACK loop (USB-priority rule).
 *
 *  SECURITY: a plugin is arbitrary code with the SAME trust level as the command
 *  widget — full fs/spawn/ffi via the tjs global (the Worker is a crash/CPU
 *  isolation boundary, not a capability sandbox). It is opt-in per key and meant
 *  for a trusted personal LAN; the WebUI has no auth. Same posture as the
 *  command widget in extra-keys.ts.
 *
 *  HARD CONSTRAINT (Phase 0 S2/S3): calling the global `fetch` or constructing a
 *  `WebSocket` inside a Worker SIGABRTs the ENTIRE process (uncatchable
 *  libwebsockets assertion). We delete both globals BEFORE importing any plugin
 *  so a plugin touching them gets a plain JS error instead of killing DeckBridge;
 *  all plugin HTTP goes through ctx.fetch, a proxy to the main thread. */
import { PLUGIN_INTERVAL_DEFAULT_MS, PLUGIN_INTERVAL_MIN_MS, PLUGIN_VALUE_MAX } from './types.js';
import type {
  MainToPluginWorker,
  PluginFetchInit,
  PluginRunConfig,
  PluginWorkerToMain,
} from './plugin-worker-protocol.js';

// Delete the process-killing globals before any plugin is imported (see header).
for (const name of ['fetch', 'WebSocket'] as const) {
  try {
    delete (globalThis as Record<string, unknown>)[name];
  } catch {
    /* non-configurable on some builds — best effort */
  }
}

const scope = globalThis as unknown as {
  postMessage(msg: PluginWorkerToMain): void;
  addEventListener(type: 'message', listener: (ev: MessageEvent) => void): void;
};
const post = scope.postMessage.bind(scope);

/** The v1 plugin contract: `export default { interval?, async fetch(ctx) }`.
 *  `fetch` returns a string (→ textLines) or null (→ clear); the return type is
 *  `unknown` because a plugin is untyped user JS — we validate at runtime. */
interface PluginModule {
  interval?: number;
  fetch(ctx: PluginContext): unknown;
}
interface PluginResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}
interface PluginContext {
  param: string;
  fetch(url: string, init?: PluginFetchInit): Promise<PluginResponse>;
  log(message: string): void;
}

interface RunningPlugin extends PluginRunConfig {
  cancelled: boolean;
}
const running = new Map<string, RunningPlugin>();

// ── ctx.fetch proxy (worker → main → worker) ─────────────────────────────────
let fetchSeq = 0;
const pendingFetches = new Map<
  number,
  {
    resolve: (r: { ok: boolean; status: number; body: string }) => void;
    reject: (e: Error) => void;
  }
>();

function proxiedFetch(url: string, init?: PluginFetchInit): Promise<PluginResponse> {
  const fetchId = ++fetchSeq;
  const init2: PluginFetchInit | undefined = init
    ? { method: init.method, headers: init.headers, body: init.body }
    : undefined;
  return new Promise<{ ok: boolean; status: number; body: string }>((resolve, reject) => {
    pendingFetches.set(fetchId, { resolve, reject });
    post({ type: 'fetch', fetchId, url, init: init2 });
  }).then((r) => ({
    ok: r.ok,
    status: r.status,
    text: (): Promise<string> => Promise.resolve(r.body),
    json: (): Promise<unknown> => Promise.resolve(JSON.parse(r.body) as unknown),
  }));
}

function pluginName(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function effectiveInterval(rp: RunningPlugin, plugin: PluginModule): number {
  const requested = rp.intervalMs ?? plugin.interval ?? PLUGIN_INTERVAL_DEFAULT_MS;
  return Math.max(PLUGIN_INTERVAL_MIN_MS, requested);
}

/** Import a plugin once, then poll it until its config is removed. A load
 *  failure is terminal (posts one error, stops); a per-poll throw is transient
 *  (posts an error, keeps polling — a network blip shouldn't wedge the key). */
async function pollLoop(rp: RunningPlugin): Promise<void> {
  let plugin: PluginModule;
  try {
    // Plain absolute path, NOT a file:// URL (Phase 0 S1: file:// fails).
    const mod = (await import(rp.path)) as { default?: PluginModule };
    const candidate = mod.default;
    if (!candidate || typeof candidate.fetch !== 'function') {
      throw new Error('plugin must `export default { async fetch(ctx) { … } }`');
    }
    plugin = candidate;
  } catch (e) {
    post({ type: 'error', key: rp.key, message: `load failed: ${(e as Error).message}` });
    running.delete(rp.key);
    return;
  }

  const name = pluginName(rp.path);
  // Read through a function so TS doesn't narrow `cancelled` to always-false
  // across the awaits (it's flipped by handleConfigure on another turn).
  const stopped = (): boolean => rp.cancelled;
  const ctx: PluginContext = {
    get param() {
      return rp.param;
    },
    fetch: proxiedFetch,
    log: (message: string) =>
      post({ type: 'log', level: 'info', component: `plugin:${name}`, message }),
  };

  while (!stopped()) {
    try {
      const result = await plugin.fetch(ctx);
      if (stopped()) break;
      if (result === null || result === undefined) {
        post({ type: 'value', key: rp.key, value: null });
      } else if (typeof result === 'string') {
        post({ type: 'value', key: rp.key, value: result.slice(0, PLUGIN_VALUE_MAX) });
      } else {
        throw new Error('fetch() must return a string or null');
      }
    } catch (e) {
      if (stopped()) break;
      post({ type: 'error', key: rp.key, message: (e as Error).message });
    }
    await sleep(effectiveInterval(rp, plugin));
  }
}

function handleConfigure(plugins: PluginRunConfig[]): void {
  const wanted = new Set(plugins.map((p) => p.key));
  for (const [key, rp] of running) {
    if (!wanted.has(key)) {
      rp.cancelled = true;
      running.delete(key);
    }
  }
  for (const p of plugins) {
    const existing = running.get(p.key);
    if (existing) {
      // Live-update param/interval/path; the poll loop reads them each cycle.
      existing.param = p.param;
      existing.intervalMs = p.intervalMs;
      existing.path = p.path;
      continue;
    }
    const rp: RunningPlugin = { ...p, cancelled: false };
    running.set(p.key, rp);
    void pollLoop(rp);
  }
}

function handleFetchResult(msg: Extract<MainToPluginWorker, { type: 'fetchResult' }>): void {
  const p = pendingFetches.get(msg.fetchId);
  if (!p) return;
  pendingFetches.delete(msg.fetchId);
  if (msg.error) p.reject(new Error(msg.error));
  else p.resolve({ ok: msg.ok, status: msg.status, body: msg.body });
}

scope.addEventListener('message', (ev: MessageEvent) => {
  const msg = ev.data as MainToPluginWorker;
  switch (msg.type) {
    case 'configure':
      handleConfigure(msg.plugins);
      break;
    case 'fetchResult':
      handleFetchResult(msg);
      break;
    case 'ping':
      post({ type: 'pong', seq: msg.seq });
      break;
  }
});
