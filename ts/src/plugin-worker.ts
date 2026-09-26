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
  /** A runNow arrived: the next poll starts at once (repeats before it collapse). */
  runNow: boolean;
  /** Ends the current inter-poll sleep early. */
  wake?: () => void;
}
const running = new Map<string, RunningPlugin>();

// ctx.fetch proxy (worker → main → worker)
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

/** Sleep until the next poll, cut short by a runNow (handleRunNow). */
function sleepUntilDue(rp: RunningPlugin, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      rp.wake = undefined;
      resolve();
    }
    rp.wake = done;
  });
}

function effectiveInterval(rp: RunningPlugin, plugin: PluginModule): number {
  const requested = rp.intervalMs ?? plugin.interval ?? PLUGIN_INTERVAL_DEFAULT_MS;
  return Math.max(PLUGIN_INTERVAL_MIN_MS, requested);
}

/** Import a plugin once, then poll it until its config is removed. A load
 *  failure is terminal (posts one error, stops); a per-poll throw is transient
 *  (posts an error, keeps polling — a network blip shouldn't wedge the key). */
async function loadPlugin(rp: RunningPlugin): Promise<PluginModule | null> {
  try {
    // Plain absolute path, NOT a file:// URL (Phase 0 S1: file:// fails).
    const mod = (await import(rp.path)) as { default?: PluginModule };
    const candidate = mod.default;
    if (!candidate || typeof candidate.fetch !== 'function') {
      throw new Error('plugin must `export default { async fetch(ctx) { … } }`');
    }
    return candidate;
  } catch (e) {
    const message = `load failed: ${(e as Error).message}`;
    post({ type: 'error', key: rp.key, message, forced: rp.runNow });
    running.delete(rp.key);
    return null;
  }
}

/** Post one poll result. Throws on a non-string, non-nullish return — the
 *  caller's catch turns that into the same transient error a throw gets. */
function postPollResult(rp: RunningPlugin, result: unknown, forced: boolean): void {
  if (result === null || result === undefined) {
    post({ type: 'value', key: rp.key, value: null, forced });
  } else if (typeof result === 'string') {
    post({ type: 'value', key: rp.key, value: result.slice(0, PLUGIN_VALUE_MAX), forced });
  } else {
    throw new Error('fetch() must return a string or null');
  }
}

async function pollLoop(rp: RunningPlugin): Promise<void> {
  const plugin = await loadPlugin(rp);
  if (!plugin) return;

  const name = pluginName(rp.path);
  // Read through functions so TS doesn't narrow `cancelled`/`runNow` to always-false
  // across the awaits (it's flipped by handleConfigure on another turn).
  const stopped = (): boolean => rp.cancelled;
  const runNowQueued = (): boolean => rp.runNow;
  const ctx: PluginContext = {
    get param() {
      return rp.param;
    },
    fetch: proxiedFetch,
    log: (message: string) =>
      post({ type: 'log', level: 'info', component: `plugin:${name}`, message }),
  };

  while (!stopped()) {
    const forced = rp.runNow;
    rp.runNow = false;
    try {
      const result = await plugin.fetch(ctx);
      if (stopped()) break;
      postPollResult(rp, result, forced);
    } catch (e) {
      if (stopped()) break;
      post({ type: 'error', key: rp.key, message: (e as Error).message, forced });
    }
    // A runNow that landed mid-poll gets its own poll right away.
    if (!runNowQueued()) await sleepUntilDue(rp, effectiveInterval(rp, plugin));
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
    const rp: RunningPlugin = { ...p, cancelled: false, runNow: false };
    running.set(p.key, rp);
    void pollLoop(rp);
  }
}

function handleRunNow(key: string): void {
  const rp = running.get(key);
  if (!rp) {
    // Load failed (or the key is going away): answer, so the host's refresh ends.
    post({ type: 'error', key, message: 'plugin is not running', forced: true });
    return;
  }
  rp.runNow = true;
  rp.wake?.();
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
    case 'runNow':
      handleRunNow(msg.key);
      break;
  }
});
