import { warn } from '../shared/logger.js';
import { platformName } from './os-utils.ts';
import type { UpdateInfo } from './update-check.js';

export interface TrayState {
  icon: 'full' | 'usb_only' | 'disconnected';
  status: string;
  reconnectAttempts: number;
  updateAvailable: boolean;
  updateText: string;
  version: string;
}

export interface TrayHandle {
  push(state: TrayState): void;
  /** Close the socket and stop the sidecar; resolves once it has exited (or did not
   *  exit even after SIGKILL within the grace). */
  close(): Promise<void>;
}

/** SIGTERM → SIGKILL grace, then the same again for the exit itself. */
const TRAY_EXIT_GRACE_MS = 500;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Tray stdout events routed to app.ts. `onRestartElgatoApp` is the manual path
 *  for the "Restart Elgato App" menu item — the tray only emits the event, TS
 *  owns settings/logging/isElgatoAppRunning (see rust/deckbridge-tray/README.md). */
export interface TrayHandlers {
  onQuit(): void;
  onRestartElgatoApp(): void;
}

/** What the tray shows, from the live state app.ts gathers. `deviceName` is
 *  whatever model is open (Mirabox or Elgato hardware); "Elgato" in the strings
 *  means the Stream Deck app on the other end of CORA. */
export function buildTrayState(input: {
  deviceName: string | undefined;
  driverConnected: boolean;
  elgatoConnected: boolean;
  reconnectAttempts: number;
  update: UpdateInfo;
}): TrayState {
  const { driverConnected, elgatoConnected, reconnectAttempts: attempts, update } = input;
  const deviceName = input.deviceName ?? 'Device';
  let icon: TrayState['icon'];
  let status: string;
  if (driverConnected && elgatoConnected) {
    icon = 'full';
    status = `${deviceName} + Elgato app connected`;
  } else if (driverConnected) {
    icon = 'usb_only';
    status = `${deviceName} connected (Elgato app not paired)`;
  } else {
    icon = 'disconnected';
    status = attempts > 0 ? `No device (attempt ${attempts})` : 'No device';
  }
  let updateText = 'Using latest version';
  if (!update.enabled) {
    updateText = 'Update checks disabled';
  } else if (update.updateAvailable) {
    updateText = `Update available: v${update.latest ?? '?'}`;
  } else if (update.lastCheckedAt === undefined) {
    updateText = 'Checking for updates…';
  }
  return {
    icon,
    status,
    reconnectAttempts: attempts,
    updateAvailable: update.updateAvailable && update.latest !== update.dismissedVersion,
    updateText,
    version: __VERSION__,
  };
}

const enc = new TextEncoder();

export function serializeTrayState(state: TrayState): string {
  return JSON.stringify(state) + '\n';
}

class TrayProcess implements TrayHandle {
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private socket: TjsTCPSocket | null = null;
  private pending: TrayState | null = null;
  private closed = false;
  private sending = false;
  private proc: TjsProcess | null = null;

  private constructor() {}

  static create(binaryPath: string, handlers: TrayHandlers): TrayProcess {
    const self = new TrayProcess();
    // Only set cwd for absolute paths — tjs resolves the binary path relative to cwd,
    // so a relative binaryPath + cwd would produce a wrong path like "rust/deckbridge-tray/deckbridge-tray".
    const cwd = isAbsolutePath(binaryPath) ? parentDir(binaryPath) : undefined;
    const proc = tjs.spawn([binaryPath], { stdout: 'pipe', ...(cwd ? { cwd } : {}) });
    self.proc = proc;
    void self._readLoop(proc, handlers);
    return self;
  }

  private _handleTrayEvent(ev: { event: string; port?: number }, handlers: TrayHandlers): void {
    if (ev.event === 'ready' && ev.port) void this._connect(ev.port);
    if (ev.event === 'quit') handlers.onQuit();
    if (ev.event === 'restart_elgato_app') handlers.onRestartElgatoApp();
    // Unknown events (open_webui, check_requirements — acted on in Rust) are ignored.
  }

  private async _readLoop(proc: TjsProcess, handlers: TrayHandlers): Promise<void> {
    const reader = proc.stdout.getReader();
    const dispatch = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        this._handleTrayEvent(JSON.parse(trimmed) as { event: string; port?: number }, handlers);
      } catch {
        /* ignore malformed stdout */
      }
    };
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) dispatch(line);
      }
      // Flush the decoder and a last line the tray wrote without a trailing newline.
      buf += decoder.decode();
      dispatch(buf);
    } catch {
      /* process exited */
    } finally {
      reader.releaseLock();
    }
  }

  private async _connect(port: number): Promise<void> {
    try {
      const socket = await tjs.connect('tcp', '127.0.0.1', port);
      // close() ran while connecting: this socket has no owner any more.
      if (this.closed) {
        socket.close();
        return;
      }
      this.socket = socket;
      const { writable } = await socket.opened;
      this.writer = writable.getWriter();
      if (this.pending) {
        void this._send(this.pending);
      }
    } catch (e) {
      warn('tray', `TCP connect failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** One write in flight; pushes meanwhile collapse into `pending` (newest wins). */
  private async _send(state: TrayState): Promise<void> {
    this.sending = true;
    try {
      let next: TrayState | null = state;
      while (next && this.writer) {
        this.pending = null;
        try {
          await this.writer.write(enc.encode(serializeTrayState(next)));
        } catch (e) {
          warn('tray', `send error: ${e instanceof Error ? e.message : String(e)}`);
        }
        next = this.pending;
      }
    } finally {
      this.sending = false;
    }
  }

  push(state: TrayState): void {
    this.pending = state;
    if (!this.writer || this.sending) return;
    void this._send(state);
  }

  async close(): Promise<void> {
    this.closed = true;
    const writer = this.writer;
    this.writer = null;
    this.pending = null;
    if (writer) {
      void writer.abort().catch(() => undefined);
      writer.releaseLock();
    }
    this.socket?.close();
    this.socket = null;
    // deckbridge-tray's behavior on stdin EOF / socket close is unverified — SIGTERM
    // it explicitly on shutdown so it can't be orphaned across restarts.
    const proc = this.proc;
    this.proc = null;
    if (!proc) return;
    const state = { exited: false };
    const exit = (async (): Promise<void> => {
      await proc.wait();
      state.exited = true;
    })();
    killQuietly(proc, 'SIGTERM');
    await Promise.race([exit, sleep(TRAY_EXIT_GRACE_MS)]);
    if (state.exited) return;
    killQuietly(proc, 'SIGKILL');
    await Promise.race([exit, sleep(TRAY_EXIT_GRACE_MS)]);
  }
}

function killQuietly(proc: TjsProcess, signal: string): void {
  try {
    proc.kill(signal);
  } catch {
    /* already exited */
  }
}

export function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || /^[a-z]:[/\\]/i.test(p);
}

export function parentDir(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i > 0 ? p.slice(0, i) : '.';
}

/**
 * Where the tray binary comes from, in priority order: $DECKBRIDGE_TRAY_BIN (dev via
 * mise, and the Homebrew formula), then a `deckbridge-tray` sidecar next to the
 * executable (every packaged release). Returns '' when neither exists. Shared with the
 * /requirements check so it can't report "not set" while the sidecar tray is running.
 */
export async function resolveTrayBin(): Promise<string> {
  const fromEnv = tjs.env.DECKBRIDGE_TRAY_BIN ?? '';
  if (fromEnv) return fromEnv;

  // parentDir handles both separators — tjs.exePath is backslash-separated on Windows.
  const candidate = `${parentDir(tjs.exePath)}/deckbridge-tray${platformName() === 'Windows' ? '.exe' : ''}`;
  try {
    const st = await tjs.stat(candidate);
    if (st.isFile) return candidate;
  } catch {}
  return '';
}

export function startTray(binaryPath: string, handlers: TrayHandlers): TrayHandle | null {
  try {
    return TrayProcess.create(binaryPath, handlers);
  } catch {
    return null;
  }
}
