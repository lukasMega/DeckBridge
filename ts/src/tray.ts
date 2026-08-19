import { warn } from './logger.js';
import { platformName } from './os-utils.ts';

export interface TrayState {
  icon: 'full' | 'usb_only' | 'disconnected';
  status: string;
  reconnectAttempts: number;
}

export interface TrayHandle {
  push(state: TrayState): void;
  close(): void;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

class TrayProcess implements TrayHandle {
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private socket: TjsTCPSocket | null = null;
  private pending: TrayState | null = null;
  private proc: TjsProcess | null = null;

  private constructor() {}

  static create(binaryPath: string, onQuit: () => void): TrayProcess {
    const self = new TrayProcess();
    // Only set cwd for absolute paths — tjs resolves the binary path relative to cwd,
    // so a relative binaryPath + cwd would produce a wrong path like "rust/deckbridge-tray/deckbridge-tray".
    const cwd = isAbsolutePath(binaryPath) ? parentDir(binaryPath) : undefined;
    const proc = tjs.spawn([binaryPath], { stdout: 'pipe', ...(cwd ? { cwd } : {}) });
    self.proc = proc;
    void self._readLoop(proc, onQuit);
    return self;
  }

  private _handleTrayEvent(ev: { event: string; port?: number }, onQuit: () => void): void {
    if (ev.event === 'ready' && ev.port) void this._connect(ev.port);
    if (ev.event === 'quit') onQuit();
  }

  private async _readLoop(proc: TjsProcess, onQuit: () => void): Promise<void> {
    const reader = proc.stdout.getReader();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            this._handleTrayEvent(JSON.parse(trimmed) as { event: string; port?: number }, onQuit);
          } catch {
            /* ignore malformed stdout */
          }
        }
      }
    } catch {
      /* process exited */
    }
  }

  private async _connect(port: number): Promise<void> {
    try {
      this.socket = await tjs.connect('tcp', '127.0.0.1', port);
      const { writable } = await this.socket.opened;
      this.writer = writable.getWriter();
      if (this.pending) {
        void this._send(this.pending);
        this.pending = null;
      }
    } catch (e) {
      warn('tray', `TCP connect failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async _send(state: TrayState): Promise<void> {
    try {
      await this.writer!.write(enc.encode(JSON.stringify(state) + '\n'));
    } catch (e) {
      warn('tray', `send error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  push(state: TrayState): void {
    if (!this.writer) {
      this.pending = state;
      return;
    }
    void this._send(state);
  }

  close(): void {
    this.socket?.close();
    // deckbridge-tray's behavior on stdin EOF / socket close is unverified — SIGTERM
    // it explicitly on shutdown so it can't be orphaned across restarts.
    if (this.proc) {
      try {
        this.proc.kill('SIGTERM');
      } catch {
        /* already exited */
      }
      this.proc = null;
    }
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
 * Where the tray binary actually comes from, in priority order:
 *   1. $DECKBRIDGE_TRAY_BIN (dev via mise, and the Homebrew formula)
 *   2. a `deckbridge-tray` sidecar next to the executable (every packaged release)
 *
 * Both app.ts (which spawns it) and the /requirements check call this, so the
 * page can't claim "not set" while the tray is visibly running from the sidecar.
 * Returns '' when neither exists.
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

export function startTray(binaryPath: string, onQuit: () => void): TrayHandle | null {
  try {
    return TrayProcess.create(binaryPath, onQuit);
  } catch {
    return null;
  }
}
