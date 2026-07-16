import * as net from './platform/tcp.js';
import {
  ELGATO_CHILD_PORT,
  ELGATO_PKT_SIZE_TX,
  HID_OP_SEND_REPORT,
  HID_OP_GET_REPORT,
  PAYLOAD_TYPE_FEATURE,
  REPORT_BUTTON_STATE_INPUT,
  REPORT_SECONDARY_DETECT,
  KEY_EVENT_RESERVED_BYTE,
  KEY_EVENT_STATE_OFFSET,
  RECONNECT_DELAY_MS,
} from './types.js';
import type { KeyState } from './types.js';
import { CORA_FLAG_VERBATIM, encodeCoraFrame } from './cora-frame.js';
import { CoraServerBase } from './cora-server-base.js';
import { describeChildPayload } from './cora-describe.js';
import type { DeviceConfig } from './elgato-types.js';
import { buildCapabilitiesPacket, type ChildGeometry, MK2_CHILD_GEOMETRY } from './capabilities.js';
import {
  handleChildVerbatimProbe,
  handleChildFeatureRequest,
  handleChildOutputReportPacket,
  extractChildBrightness,
  assembleChildImageChunk,
  assembleChildGen1ImageChunk,
  type SendFrameFn,
  type LogFn,
} from './elgato-child-payload.js';
import { createGetReportHandlers, type GetReportHandler } from './elgato-child-report-handlers.js';

type ReconnectState = 'idle' | 'in-progress' | 'scheduled';

export class ElgatoChildServer extends CoraServerBase {
  private imagePages: Map<number, Buffer[]> = new Map();
  private gen1ImagePages: Map<number, Buffer[]> = new Map();
  private warnedOobKeys = new Set<number>();
  private childGeometry: ChildGeometry = MK2_CHILD_GEOMETRY;
  private keyStates: Uint8Array = new Uint8Array(this.childGeometry.keyCount);
  private readonly deviceConfig: DeviceConfig;
  private remoteAddress: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectEnabled = false;
  private reconnectState: ReconnectState = 'idle';
  private outboundSocket: net.Socket | null = null;
  private readonly enableOutboundReconnect: boolean;
  private sessionStartTs = 0;
  private sessionId = 0;

  // Stable bound refs handed to the extracted payload handlers so the
  // ACK-paced hot path (handleCoraPacket, image chunks) doesn't allocate a
  // fresh closure per packet.
  private readonly sendFrameFn: SendFrameFn = this.sendFrame.bind(this);
  private readonly emitLogFn: LogFn = this.emitLog.bind(this);
  private readonly sendAckNakFn = this.sendAckNak.bind(this);
  private readonly handleImageChunkFn = this.handleImageChunk.bind(this);
  private readonly handleGen1ImageChunkFn = this.handleGen1ImageChunk.bind(this);
  private readonly buildSelfDeviceInfoFn = (): Buffer => this.buildSelfDeviceInfo();
  private readonly getReportHandlers: Map<number, GetReportHandler>;

  protected componentName = 'elgato-child';

  constructor(port: number, deviceConfig: DeviceConfig, enableOutboundReconnect = true) {
    super(port);
    this.deviceConfig = deviceConfig;
    this.enableOutboundReconnect = enableOutboundReconnect;
    this.getReportHandlers = createGetReportHandlers(
      this.deviceConfig,
      this.sendFrameFn,
      this.emitLogFn,
    );
    this.on('clientDisconnected', this.onChildClientDisconnected);
  }

  setChildGeometry(geo: ChildGeometry): void {
    this.childGeometry = geo;
    const next = new Uint8Array(geo.keyCount);
    next.set(this.keyStates.subarray(0, Math.min(this.keyStates.length, geo.keyCount)));
    this.keyStates = next;
    this.warnedOobKeys.clear();
  }

  private readonly onChildClientDisconnected = (): void => {
    const duration = this.sessionStartTs ? `${Date.now() - this.sessionStartTs}ms` : 'unknown';
    this.logInfo(`child session ended (duration=${duration})`);
    this.sessionStartTs = 0;
    this.sessionId++;
    this.logInfo(
      `reconnect state: inProgress=${this.reconnectState === 'in-progress'} scheduled=${this.reconnectState === 'scheduled'} hasClient=${!!this.client} sessionId=${this.sessionId}`,
    );
    if (!this.reconnectEnabled || this.reconnectState !== 'idle') return;
    this.tryConnectOutbound();
  };

  async start(): Promise<void> {
    await this.startServer();
    this.reconnectEnabled = true;
  }

  async stop(): Promise<void> {
    this.reconnectEnabled = false;
    if (this.outboundSocket) {
      this.outboundSocket.destroy();
      this.outboundSocket = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    await this.stopServer();
  }

  sendKeyEvent(keyIndex: number, state: KeyState): void {
    if (keyIndex >= this.childGeometry.keyCount) {
      this.logInfo(
        `key event dropped: keyIndex=${keyIndex} >= keyCount=${this.childGeometry.keyCount}`,
      );
      return;
    }
    if (!this.client) {
      const msSinceConnect = this.sessionStartTs ? Date.now() - this.sessionStartTs : 0;
      this.logInfo(
        `key event dropped (no client, session=${msSinceConnect}ms): mk2=${keyIndex} ${state}`,
      );
      return;
    }

    this.keyStates[keyIndex] = state === 'down' ? 1 : 0;
    this.sendAllKeyStates();
  }

  private sendAllKeyStates(): void {
    const pkt = Buffer.alloc(ELGATO_PKT_SIZE_TX);
    const kc = this.childGeometry.keyCount;
    pkt[0] = REPORT_BUTTON_STATE_INPUT;
    pkt[1] = KEY_EVENT_RESERVED_BYTE;
    pkt[2] = kc;
    for (let i = 0; i < kc; i++) {
      pkt[KEY_EVENT_STATE_OFFSET + i] = this.keyStates[i] ?? 0;
    }
    this.sendFrame(pkt, 0, 0, 0, `CORA button-state keys=${kc}`);
  }

  private buildSelfDeviceInfo(): Buffer {
    return buildCapabilitiesPacket(this.deviceConfig, this.port, this.childGeometry);
  }

  protected handleCoraPacket(
    flags: number,
    hidOp: number,
    messageId: number,
    payload: Buffer,
  ): void {
    if (payload.length < 1) return;

    try {
      this.emitComm(
        'rx',
        describeChildPayload(
          payload,
          flags,
          hidOp,
          messageId,
          this.deviceConfig.productId,
          this.port,
        ),
        payload,
      );

      const byte0 = payload[0]!;
      const byte1 = payload.length > 1 ? payload[1]! : 0;
      const isVerbatim = (flags & CORA_FLAG_VERBATIM) !== 0;

      // Only Bitfocus Companion's CORA client queries the legacy
      // secondary-detect report — the genuine Elgato app never sends it (see
      // .claude/plans/2026-07-14_try-distinguish-bitfocus-companion-connection.md).
      if (isVerbatim && byte0 === REPORT_SECONDARY_DETECT) {
        this.emit('clientAppDetected', 'bitfocus');
      }

      if (
        isVerbatim &&
        handleChildVerbatimProbe(byte0, hidOp, messageId, this.deviceConfig, this.sendFrameFn)
      )
        return;
      if (
        byte0 === PAYLOAD_TYPE_FEATURE &&
        handleChildFeatureRequest(
          byte1,
          hidOp,
          messageId,
          this.buildSelfDeviceInfoFn,
          this.sendFrameFn,
        )
      )
        return;
      if (hidOp === HID_OP_GET_REPORT) {
        this.handleGetReport(byte0, flags, hidOp, messageId, payload);
        return;
      }
      if (hidOp === HID_OP_SEND_REPORT || byte0 === PAYLOAD_TYPE_FEATURE) {
        this.handleSendReport(payload, flags, hidOp, messageId);
        return;
      }
      handleChildOutputReportPacket(
        byte0,
        byte1,
        flags,
        hidOp,
        messageId,
        payload,
        this.sessionStartTs ? Date.now() - this.sessionStartTs : 0,
        this.emitLogFn,
        this.sendAckNakFn,
        this.handleImageChunkFn,
        this.handleGen1ImageChunkFn,
      );
    } catch (err) {
      this.emitLog('error', `child handleCoraPacket error: ${(err as Error).message}`);
      this.emitLog('debug', `child handleCoraPacket stack: ${(err as Error).stack}`);
    }
  }

  private handleGetReport(
    reportId: number,
    _flags: number,
    _hidOp: number,
    messageId: number,
    payload: Buffer,
  ): void {
    this.getReportHandlers.get(reportId)?.(messageId, payload);
  }

  private handleSendReport(
    payload: Buffer,
    flags: number,
    _hidOp: number,
    messageId: number,
  ): void {
    if (payload.length < 3) return;
    extractChildBrightness(
      payload,
      flags,
      messageId,
      (level) => this.emit('brightness', level),
      this.sendAckNakFn,
    );
  }

  private handleImageChunk(pkt: Buffer, _messageId: number): void {
    assembleChildImageChunk(
      pkt,
      this.imagePages,
      this.childGeometry.keyCount,
      this.warnedOobKeys,
      this.emitLogFn,
      (event) => this.emit('image', event),
    );
  }

  private handleGen1ImageChunk(pkt: Buffer, _messageId: number): void {
    assembleChildGen1ImageChunk(
      pkt,
      this.gen1ImagePages,
      this.childGeometry.keyCount,
      this.warnedOobKeys,
      this.emitLogFn,
      (event) => this.emit('image', event),
    );
  }

  private tryConnectOutbound(): void {
    if (!this.reconnectEnabled || !this.remoteAddress || !this.enableOutboundReconnect) return;
    if (this.client) {
      this.logInfo('skip outbound reconnect — client already connected');
      return;
    }
    if (this.reconnectState === 'scheduled') {
      this.logInfo('skip outbound reconnect — already scheduled');
      return;
    }
    if (this.reconnectState === 'in-progress') {
      this.logInfo('skip outbound reconnect — in progress');
      return;
    }
    this.reconnectState = 'in-progress';
    const addr = this.remoteAddress;
    this.logInfo(`child outbound connect to ${addr}:${ELGATO_CHILD_PORT}`);
    const sock = net.createConnection({ host: addr, port: ELGATO_CHILD_PORT }, () => {
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.logInfo(`child outbound connected to ${addr}`);
      this.reconnectState = 'idle';
      this.outboundSocket = null;
      this.acceptConnection(sock);
    });
    this.outboundSocket = sock;
    sock.on('error', (err) => {
      if (this.outboundSocket !== sock) {
        return;
      }
      this.logInfo(`child outbound connect failed: ${err.message}, retry ${RECONNECT_DELAY_MS}ms`);
      sock.destroy();
      this.outboundSocket = null;
      this.reconnectState = 'scheduled';
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.reconnectState = 'idle';
        this.tryConnectOutbound();
      }, RECONNECT_DELAY_MS);
    });
  }

  protected onClientConnected(socket: net.Socket): void {
    this.remoteAddress = socket.remoteAddress;
    this.reconnectState = 'idle';
    if (this.outboundSocket) {
      this.outboundSocket.destroy();
      this.outboundSocket = null;
      this.logInfo('destroyed pending outbound socket (inbound client connected)');
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.logInfo('cancelled pending outbound reconnect (inbound client connected)');
    }
    this.logInfo(
      `child TCP connection attempt from ${socket.remoteAddress} (session=${this.sessionId + 1})`,
    );

    this.sessionStartTs = Date.now();
    this.keyStates = new Uint8Array(this.childGeometry.keyCount);
    this.imagePages = new Map();
    this.gen1ImagePages = new Map();
    this.warnedOobKeys.clear();
    this.sendKeepalive();
  }

  protected override sendFrame(
    payload: Buffer,
    flags: number,
    hidOp: number,
    messageId: number,
    description?: string,
  ): void {
    const desc =
      description ??
      describeChildPayload(
        payload,
        flags,
        hidOp,
        messageId,
        this.deviceConfig.productId,
        this.port,
      );
    const frame = encodeCoraFrame(payload, flags, hidOp, messageId);
    const msSinceConnect = this.sessionStartTs ? `+${Date.now() - this.sessionStartTs}ms` : '';
    // Per-chunk image ACKs and keepalives fire constantly during image bursts;
    // demote them to debug so they don't each become an info-level WS broadcast.
    const isNoisy =
      description?.startsWith('CORA AckNak') || description?.startsWith('CORA keepalive');
    this.emitLog(
      isNoisy ? 'debug' : 'info',
      `child tx: ${desc} (${frame.length}B)${msSinceConnect}`,
    );
    this.client?.write(frame);
    this.emitComm('tx', desc, frame);
  }
}
