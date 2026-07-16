import { EventEmitter } from 'node:events';
import * as net from './platform/tcp.js';
import {
  ELGATO_KEEPALIVE_MS,
  KEEPALIVE_PAYLOAD_SIZE,
  KEEPALIVE_PKT_SEQ_OFFSET,
  KEEPALIVE_SUBTYPE,
  PKT_EVENT,
  EVENT_SUBTYPE_KEEPALIVE,
  SERVER_LISTEN_ADDRESS,
  CLIENT_EVICTION_GRACE_MS,
} from './types.js';
import {
  CORA_FLAG_ACKNAK,
  CORA_FLAG_VERBATIM,
  CoraFrameReader,
  encodeCoraFrame,
} from './cora-frame.js';
import { formatCommHex } from './comm-format.js';

export abstract class CoraServerBase extends EventEmitter {
  protected server: net.Server;
  protected client: net.Socket | null = null;
  protected keepaliveTimer: NodeJS.Timeout | null = null;
  protected keepaliveSeq = 0;
  protected reader = new CoraFrameReader();
  private serverErrorHandler: ((err: Error) => void) | null = null;

  protected readonly port: number;
  public keepaliveIntervalMs = ELGATO_KEEPALIVE_MS;
  public evictionGraceMs = CLIENT_EVICTION_GRACE_MS;
  protected lastClientRxTs = 0;
  protected abstract componentName: string;

  protected constructor(port: number) {
    super();
    this.port = port;
    this.server = net.createServer((socket) => this.acceptConnection(socket));
  }

  /** True while a CORA client socket is attached. On the primary server this
   *  means the Elgato app discovered + connected to the Network Dock; on the
   *  child server it means a panel is paired & actively streaming. */
  get hasClient(): boolean {
    return this.client !== null;
  }

  protected startServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      let started = false;
      const onError = (err: Error): void => {
        if (started) {
          this.emitLog('error', `${this.componentName} server error after start: ${err.message}`);
        } else {
          reject(err);
        }
      };
      if (this.serverErrorHandler) this.server.removeListener('error', this.serverErrorHandler);
      this.serverErrorHandler = onError;
      this.server.on('error', onError);
      this.server.listen(this.port, SERVER_LISTEN_ADDRESS, () => {
        started = true;
        resolve();
      });
    });
  }

  protected stopServer(): Promise<void> {
    this.clearKeepalive();
    if (this.serverErrorHandler) {
      this.server.removeListener('error', this.serverErrorHandler);
      this.serverErrorHandler = null;
    }
    if (this.client) {
      this.client.destroy();
      this.client = null;
    }
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }

  protected sendFrame(
    payload: Buffer,
    flags: number,
    hidOp: number,
    messageId: number,
    description?: string,
  ): void {
    const frame = encodeCoraFrame(payload, flags, hidOp, messageId);
    this.client?.write(frame);
    if (description) this.emitComm('tx', description, frame);
  }

  protected sendKeepalive(): void {
    const payload = Buffer.alloc(KEEPALIVE_PAYLOAD_SIZE);
    payload[0] = PKT_EVENT;
    payload[1] = EVENT_SUBTYPE_KEEPALIVE;
    payload[2] = KEEPALIVE_SUBTYPE;
    payload[4] = 0x01;
    payload[KEEPALIVE_PKT_SEQ_OFFSET] = this.keepaliveSeq;
    this.sendFrame(payload, 0, 0, this.keepaliveSeq, `CORA keepalive seq=${this.keepaliveSeq}`);
    this.keepaliveSeq = (this.keepaliveSeq + 1) & 0xff;
  }

  protected sendAckNak(messageId: number, hidOp = 0): void {
    this.sendFrame(
      Buffer.alloc(4),
      CORA_FLAG_VERBATIM | CORA_FLAG_ACKNAK,
      hidOp,
      messageId,
      `CORA AckNak for msgId=${messageId} hidOp=${hidOp}`,
    );
  }

  protected emitComm(direction: 'rx' | 'tx', human: string, data: Buffer): void {
    const hex = formatCommHex(data);
    this.emit('comm', {
      direction,
      protocol: 'elgato',
      component: this.componentName,
      human,
      hex,
      totalBytes: data.length,
    });
  }

  protected emitLog(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    this.emit('serverLog', { level, component: this.componentName, message });
  }

  protected logInfo(message: string): void {
    this.emitLog('info', message);
  }

  private clearKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  protected abstract onClientConnected(socket: net.Socket): void;

  protected acceptConnection(socket: net.Socket): void {
    if (this.client) {
      if (Date.now() - this.lastClientRxTs < this.evictionGraceMs) {
        this.emitLog('warn', `rejected takeover from ${socket.remoteAddress} — active client`);
        socket.destroy();
        return;
      }
      this.client.destroy();
      this.client = null;
      this.clearKeepalive();
    }

    this.client = socket;
    this.reader = new CoraFrameReader();
    this.keepaliveSeq = 0;
    this.lastClientRxTs = Date.now();

    this.emit('clientConnected', socket.remoteAddress);

    this.onClientConnected(socket);

    this.keepaliveTimer = setInterval(() => {
      // A synchronous throw here would kill the process (no global hook for
      // sync setInterval callbacks) — keep it non-throwing.
      try {
        this.sendKeepalive();
      } catch (e) {
        this.emitLog('error', `keepalive failed: ${(e as Error).message}`);
      }
    }, this.keepaliveIntervalMs);

    socket.on('data', (chunk: Buffer) => {
      this.lastClientRxTs = Date.now();
      this.reader.append(chunk);
      for (const frame of this.reader.drainFrames()) {
        this.handleCoraPacket(frame.flags, frame.hidOp, frame.messageId, frame.payload);
      }
    });

    socket.on('close', (hadTransportErr: boolean) => {
      if (this.client !== socket) return;
      this.clearKeepalive();
      this.client = null;
      if (hadTransportErr) {
        this.emitLog('warn', `connection closed with transport error (RST)`);
      } else {
        this.emitLog('info', `connection closed gracefully (FIN)`);
      }
      this.emit('clientDisconnected');
    });

    socket.on('error', (err: Error) => {
      this.emitLog('error', `socket error: ${err.message}`);
      socket.destroy();
    });
  }

  protected abstract handleCoraPacket(
    flags: number,
    hidOp: number,
    messageId: number,
    payload: Buffer,
  ): void;
}
