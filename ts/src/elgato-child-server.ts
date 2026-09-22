import type { ImageAssembly } from './image-assembler.js';
import * as net from './platform/tcp.js';
import {
  ELGATO_CHILD_PORT,
  ELGATO_PKT_SIZE_TX,
  HID_OP_SEND_REPORT,
  HID_OP_GET_REPORT,
  PAYLOAD_TYPE_FEATURE,
  REPORT_BUTTON_STATE_INPUT,
  REPORT_SECONDARY_DETECT,
  KEY_EVENT_STATE_OFFSET,
  RECONNECT_DELAY_MS,
  IMG_CMD_WINDOW,
  IMG_CMD_LCD,
  IMG_CMD_WINDOW_PARTIAL,
  INPUT_SUBTYPE_BUTTONS,
  INPUT_SUBTYPE_TOUCH,
  INPUT_SUBTYPE_ENCODER,
  clearTimer,
} from './types.js';
import type { KeyState, TouchInputEvent } from './types.js';
import { CORA_FLAG_VERBATIM, encodeCoraFrame } from './cora-frame.js';
import { CoraServerBase } from './cora-server-base.js';
import { describeChildPayload } from './cora-describe.js';
import type { DeviceConfig } from './elgato-types.js';
import { buildCapabilitiesPacket, type ChildGeometry } from './capabilities.js';
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
import { assembleImageChunk } from './image-assembler.js';
import { createGetReportHandlers, type GetReportHandler } from './elgato-child-report-handlers.js';

type ReconnectState = 'idle' | 'in-progress' | 'scheduled';

export class ElgatoChildServer extends CoraServerBase {
  private imagePages: Map<number, ImageAssembly> = new Map();
  private gen1ImagePages: Map<number, ImageAssembly> = new Map();
  private touchPages: Map<number, ImageAssembly> = new Map();
  private warnedOobKeys = new Set<number>();
  private childGeometry: ChildGeometry;
  private keyStates: Uint8Array;
  /** Bitmap of currently-pressed encoders (bit i = encoder i), emitted as the
   *  Plus encoder press report. */
  private encoderPressMask = 0;
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
  private readonly handleTouchOutputFn = this.handleTouchOutput.bind(this);
  private readonly buildSelfDeviceInfoFn = (): Buffer => this.buildSelfDeviceInfo();
  private readonly getReportHandlers: Map<number, GetReportHandler>;

  protected componentName = 'elgato-child';

  constructor(
    childGeometry: ChildGeometry,
    port: number,
    deviceConfig: DeviceConfig,
    enableOutboundReconnect = true,
  ) {
    super(port);
    this.childGeometry = childGeometry;
    this.keyStates = new Uint8Array(childGeometry.keyCount);
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
    this.reconnectTimer = clearTimer(this.reconnectTimer);
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
    pkt[1] = INPUT_SUBTYPE_BUTTONS;
    pkt[2] = kc;
    for (let i = 0; i < kc; i++) {
      pkt[KEY_EVENT_STATE_OFFSET + i] = this.keyStates[i] ?? 0;
    }
    this.sendFrame(pkt, 0, 0, 0, `CORA button-state keys=${kc}`);
  }

  /** Stream Deck + encoder press. Bitmap report: `01 03 <len> 00 00 <mask>`. */
  sendDialPress(index: number, down: boolean): void {
    const count = this.childGeometry.encoderCount ?? 0;
    if (index < 0 || index >= count) return;
    if (down) this.encoderPressMask |= 1 << index;
    else this.encoderPressMask &= ~(1 << index);
    const pkt = Buffer.alloc(ELGATO_PKT_SIZE_TX);
    pkt[0] = REPORT_BUTTON_STATE_INPUT;
    pkt[1] = INPUT_SUBTYPE_ENCODER;
    pkt[2] = 2; // subtype byte + mask byte
    pkt[4] = 0x00; // press bitmap
    pkt[5] = this.encoderPressMask;
    this.sendFrame(pkt, 0, 0, 0, `CORA encoder-press mask=${this.encoderPressMask}`);
  }

  /** Stream Deck + encoder rotation. `01 03 <len> 00 01 <d0..d3>` (INT8 per encoder). */
  sendDialRotate(index: number, delta: number): void {
    const count = this.childGeometry.encoderCount ?? 0;
    if (index < 0 || index >= count) return;
    const pkt = Buffer.alloc(ELGATO_PKT_SIZE_TX);
    pkt[0] = REPORT_BUTTON_STATE_INPUT;
    pkt[1] = INPUT_SUBTYPE_ENCODER;
    pkt[2] = 1 + count;
    pkt[4] = 0x01; // rotate
    pkt[5 + index] = Math.max(-128, Math.min(127, delta));
    this.sendFrame(pkt, 0, 0, 0, `CORA encoder-rotate index=${index} delta=${delta}`);
  }

  /** Stream Deck + touch strip. `01 02 <len> 00 <type> <contacts> x y [ex ey]`. */
  sendTouch(event: TouchInputEvent): void {
    const pkt = Buffer.alloc(ELGATO_PKT_SIZE_TX);
    const typeByte = event.type === 'tap' ? 0x01 : event.type === 'hold' ? 0x02 : 0x03;
    const hasEnd = event.type === 'swipe';
    pkt[0] = REPORT_BUTTON_STATE_INPUT;
    pkt[1] = INPUT_SUBTYPE_TOUCH;
    pkt[2] = hasEnd ? 10 : 6; // type + contacts + x/y (+ endX/endY)
    pkt[4] = typeByte;
    pkt[5] = 1; // contacts
    pkt.writeUInt16LE(event.x, 6);
    pkt.writeUInt16LE(event.y, 8);
    if (hasEnd) {
      pkt.writeUInt16LE(event.endX ?? event.x, 10);
      pkt.writeUInt16LE(event.endY ?? event.y, 12);
    }
    this.sendFrame(pkt, 0, 0, 0, `CORA touch ${event.type} x=${event.x} y=${event.y}`);
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
      this.routeChildPacket(flags, hidOp, messageId, payload);
    } catch (err) {
      this.emitLog('error', `child handleCoraPacket error: ${(err as Error).message}`);
      this.emitLog('debug', `child handleCoraPacket stack: ${(err as Error).stack}`);
    }
  }

  private routeChildPacket(flags: number, hidOp: number, messageId: number, payload: Buffer): void {
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
      this.handleTouchOutputFn,
    );
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

  /** Stream Deck + touch/LCD output commands (0x08 LCD, 0x0B window strip,
   *  0x0C partial window). Only the window strip (0x0B) is assembled and acted
   *  on today; LCD and partial-window chunk layouts are UNVERIFIED, so those are
   *  ACKed (already done by the caller) and dropped with a debug trace. The
   *  window strip is assumed to use the gen2 8-byte chunk header. */
  private handleTouchOutput(cmd: number, pkt: Buffer, _messageId: number): void {
    if (cmd === IMG_CMD_LCD || cmd === IMG_CMD_WINDOW_PARTIAL) {
      this.emitLog(
        'debug',
        `child rx: ${cmd === IMG_CMD_LCD ? 'LCD' : 'partial-window'} output dropped (layout unverified)`,
      );
      return;
    }
    // 0x0B window strip — assemble as a gen2 image chunk (assumed layout).
    const assembled = assembleImageChunk(this.touchPages, pkt);
    if (assembled) this.emit('touchImage', { data: assembled.data });
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
      this.reconnectTimer = clearTimer(this.reconnectTimer);
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
      this.reconnectTimer = clearTimer(this.reconnectTimer);
      this.logInfo('cancelled pending outbound reconnect (inbound client connected)');
    }
    this.logInfo(
      `child TCP connection attempt from ${socket.remoteAddress} (session=${this.sessionId + 1})`,
    );

    this.sessionStartTs = Date.now();
    this.keyStates = new Uint8Array(this.childGeometry.keyCount);
    this.imagePages = new Map();
    this.gen1ImagePages = new Map();
    this.touchPages = new Map();
    this.encoderPressMask = 0;
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
    const frame = encodeCoraFrame(payload, flags, hidOp, messageId);
    // Write FIRST, then trace — matching the base class. Elgato ACK-paces image
    // chunks, so anything ahead of the write throttles image delivery.
    this.client?.write(frame);
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
    const msSinceConnect = this.sessionStartTs ? `+${Date.now() - this.sessionStartTs}ms` : '';
    // Per-chunk image ACKs and keepalives fire constantly during image bursts;
    // demote them to debug so they don't each become an info-level WS broadcast.
    const isNoisy =
      description?.startsWith('CORA AckNak') || description?.startsWith('CORA keepalive');
    this.emitLog(
      isNoisy ? 'debug' : 'info',
      `child tx: ${desc} (${frame.length}B)${msSinceConnect}`,
    );
    this.emitComm('tx', desc, frame);
  }
}
