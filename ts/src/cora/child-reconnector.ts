// Outbound reconnect for the child CORA server: when the desktop app's child
// session drops, dial back to its last address instead of waiting for it to
// reconnect. Cold path — kept out of ElgatoChildServer's packet dispatch.
import * as net from '../platform/tcp.js';
import { ELGATO_CHILD_PORT, RECONNECT_DELAY_MS, clearTimer } from '../shared/types.js';

type ReconnectState = 'idle' | 'in-progress' | 'scheduled';

export interface ChildReconnectorHost {
  hasClient(): boolean;
  /** Adopt a connected outbound socket as the session client. */
  accept(socket: net.Socket): void;
  logInfo(message: string): void;
}

export class ChildReconnector {
  private remoteAddress: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private enabled = false;
  private state: ReconnectState = 'idle';
  private outboundSocket: net.Socket | null = null;

  constructor(
    private readonly host: ChildReconnectorHost,
    private readonly allowOutbound: boolean,
  ) {}

  start(): void {
    this.enabled = true;
  }

  stop(): void {
    this.enabled = false;
    if (this.outboundSocket) {
      this.outboundSocket.destroy();
      this.outboundSocket = null;
    }
    this.timer = clearTimer(this.timer);
  }

  /** An inbound client arrived: remember where to dial back, drop any pending dial. */
  onInbound(remoteAddress: string | null): void {
    this.remoteAddress = remoteAddress;
    this.state = 'idle';
    if (this.outboundSocket) {
      this.outboundSocket.destroy();
      this.outboundSocket = null;
      this.host.logInfo('destroyed pending outbound socket (inbound client connected)');
    }
    if (this.timer) {
      this.timer = clearTimer(this.timer);
      this.host.logInfo('cancelled pending outbound reconnect (inbound client connected)');
    }
  }

  onDisconnected(sessionId: number): void {
    this.host.logInfo(
      `reconnect state: inProgress=${this.state === 'in-progress'} scheduled=${this.state === 'scheduled'} hasClient=${this.host.hasClient()} sessionId=${sessionId}`,
    );
    if (!this.enabled || this.state !== 'idle') return;
    this.tryConnect();
  }

  private tryConnect(): void {
    if (!this.enabled || !this.remoteAddress || !this.allowOutbound) return;
    if (this.host.hasClient()) {
      this.host.logInfo('skip outbound reconnect — client already connected');
      return;
    }
    if (this.state === 'scheduled') {
      this.host.logInfo('skip outbound reconnect — already scheduled');
      return;
    }
    if (this.state === 'in-progress') {
      this.host.logInfo('skip outbound reconnect — in progress');
      return;
    }
    this.state = 'in-progress';
    const addr = this.remoteAddress;
    this.host.logInfo(`child outbound connect to ${addr}:${ELGATO_CHILD_PORT}`);
    const sock = net.createConnection({ host: addr, port: ELGATO_CHILD_PORT }, () => {
      this.timer = clearTimer(this.timer);
      this.host.logInfo(`child outbound connected to ${addr}`);
      this.state = 'idle';
      this.outboundSocket = null;
      this.host.accept(sock);
    });
    this.outboundSocket = sock;
    sock.on('error', (err) => {
      if (this.outboundSocket !== sock) return;
      this.host.logInfo(
        `child outbound connect failed: ${err.message}, retry ${RECONNECT_DELAY_MS}ms`,
      );
      sock.destroy();
      this.outboundSocket = null;
      this.state = 'scheduled';
      this.timer = setTimeout(() => {
        this.timer = null;
        this.state = 'idle';
        this.tryConnect();
      }, RECONNECT_DELAY_MS);
    });
  }
}
