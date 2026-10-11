/** Extension worker entry: runs ONE extension's server.js off the main thread, so a
 *  slow, looping or throwing extension cannot stall the CORA ACK loop. A crash/CPU
 *  boundary, not a sandbox: the code keeps full tjs rights (docs/extensions.md#trust). */
import type { ExtensionServer, ExtensionServerFactory } from './api.js';
import type { ExtensionWorkerToMain, MainToExtensionWorker } from './extension-worker-protocol.js';

// The global fetch / WebSocket SIGABRT the whole process inside a worker (plugin-worker.ts).
for (const name of ['fetch', 'WebSocket'] as const) {
  try {
    delete (globalThis as Record<string, unknown>)[name];
  } catch {
    /* non-configurable on some builds — best effort */
  }
}

const scope = globalThis as unknown as {
  postMessage(msg: ExtensionWorkerToMain): void;
  addEventListener(type: 'message', listener: (ev: MessageEvent) => void): void;
};

const post = scope.postMessage.bind(scope);

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

let server: ExtensionServer | null = null;

async function load(msg: Extract<MainToExtensionWorker, { type: 'load' }>): Promise<void> {
  try {
    const mod = (await import(msg.path)) as { default?: unknown };
    if (typeof mod.default !== 'function') {
      throw new Error('server.js must `export default (ctx) => ({ onEvents, handle })`');
    }
    server = (mod.default as ExtensionServerFactory)({
      id: msg.id,
      appStartedAt: msg.appStartedAt,
      // Untyped extension JS may log anything.
      log: (message: unknown) => post({ type: 'log', level: 'info', message: String(message) }),
    });
    post({ type: 'loaded' });
  } catch (e) {
    post({ type: 'loadError', message: errorMessage(e) });
  }
}

function deliver(events: Parameters<NonNullable<ExtensionServer['onEvents']>>[0]): void {
  try {
    server?.onEvents?.(events);
  } catch (e) {
    post({ type: 'log', level: 'warn', message: `onEvents threw: ${errorMessage(e)}` });
  }
}

async function answer(msg: Extract<MainToExtensionWorker, { type: 'request' }>): Promise<void> {
  const { reqId, method, path, query, body } = msg;
  try {
    if (!server?.handle) {
      post({ type: 'response', reqId, status: 404, body: { error: 'not found' } });
      return;
    }
    const res = await server.handle({ method, path, query, body });
    // postMessage throws on a body that cannot be cloned; the catch turns that into a 500.
    post({ type: 'response', reqId, status: res.status ?? 200, body: res.body });
  } catch (e) {
    post({ type: 'response', reqId, status: 500, body: { error: errorMessage(e) } });
  }
}

scope.addEventListener('message', (ev: MessageEvent) => {
  const msg = ev.data as MainToExtensionWorker;
  switch (msg.type) {
    case 'load':
      void load(msg);
      break;
    case 'events':
      deliver(msg.events);
      break;
    case 'request':
      void answer(msg);
      break;
    case 'ping':
      post({ type: 'pong', seq: msg.seq });
      break;
  }
});
