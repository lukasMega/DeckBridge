import type { ImageAssembly } from './image-assembler.js';
import type * as net from '../platform/tcp.js';
import {
  ELGATO_PKT_SIZE_TX,
  HID_OP_SEND_REPORT,
  HID_OP_GET_REPORT,
  PAYLOAD_TYPE_FEATURE,
  PAYLOAD_TYPE_OUTPUT_REPORT,
  REPORT_BUTTON_STATE_INPUT,
  REPORT_SECONDARY_DETECT,
  KEY_EVENT_STATE_OFFSET,
  INPUT_SUBTYPE_BUTTONS,
  IMG_CMD_WRITE,
  IMG_CMD_LCD,
  IMG_CMD_WINDOW,
  IMG_CMD_WINDOW_PARTIAL,
  GEN1_IMG_CMD,
  IMAGE_CHUNK_KEY_OFFSET,
  GEN1_IMAGE_KEY_OFFSET,
  FEATURE_KEEPALIVE_ACK,
  FEATURE_GET_CAPABILITIES,
  FEATURE_GET_DEVICE_INFO,
} from './protocol.js';
import type { DialEvent, KeyState, TouchInputEvent } from '../shared/types.js';
import { isLevelEnabled } from '../shared/logger.js';
import {
  CORA_FLAG_RESULT,
  CORA_FLAG_REQACK,
  CORA_FLAG_VERBATIM,
  CORA_VERBATIM_RESULT,
  encodeCoraFrame,
} from './frame.js';
import { CoraServerBase, ackDescription } from './server-base.js';
import { describeChildPayload } from './describe.js';
import type { DeviceConfig, LogFn } from './types.js';
import type { ChildGeometry } from '../devices/driver.js';
import {
  CHILD_REPORT_SPECS,
  buildCapabilitiesPacket,
  buildVerbatimProbeReport,
} from './responses.js';
import {
  isValidChildImageKey,
  parseChildBrightness,
  traceGen1ImageChunk,
  traceImageChunk,
} from './child-payload.js';
import { AssemblyBudget, assembleGen1ImageChunk, assembleImageChunk } from './image-assembler.js';
import { ChildReconnector } from './child-reconnector.js';
import { TouchStripAssembler } from './touch-strip-assembler.js';
import {
  buildEncoderPressReport,
  buildEncoderRotateReport,
  buildTouchReport,
} from './plus-reports.js';

/** Output-report payloads carrying image data (key, gen1, touch-strip chunks). */
function isBulkChunk(payload: Buffer): boolean {
  if (payload[0] !== PAYLOAD_TYPE_OUTPUT_REPORT) return false;
  const cmd = payload[1];
  return (
    cmd === IMG_CMD_WRITE ||
    cmd === GEN1_IMG_CMD ||
    cmd === IMG_CMD_LCD ||
    cmd === IMG_CMD_WINDOW ||
    cmd === IMG_CMD_WINDOW_PARTIAL
  );
}

export class ElgatoChildServer extends CoraServerBase {
  private imagePages: Map<number, ImageAssembly> = new Map();
  private gen1ImagePages: Map<number, ImageAssembly> = new Map();
  private readonly assemblyBudget = new AssemblyBudget();
  private readonly touchStrip = new TouchStripAssembler(this.assemblyBudget);
  private warnedOobKeys = new Set<number>();
  private childGeometry: ChildGeometry;
  private keyStates: Uint8Array;
  /** Bitmap of currently-pressed encoders (bit i = encoder i), emitted as the
   *  Plus encoder press report. */
  private encoderPressMask = 0;
  private readonly deviceConfig: DeviceConfig;
  private readonly reconnector: ChildReconnector;
  private sessionStartTs = 0;
  private sessionId = 0;

  /** Simple-only builds tally image-chunk rx / ACK tx comm traffic instead of storing
   *  entries, so the 500-entry ring keeps the pairing handshake. */
  countBulkComm = __SIMPLE_ONLY__;
  /** True while an image chunk's rx comm entry waits for its ACK to be written first. */
  private rxDeferred = false;

  // Bound once so the per-chunk hot path doesn't allocate a closure.
  private readonly emitLogFn: LogFn = this.emitLog.bind(this);

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
    this.reconnector = new ChildReconnector(
      {
        hasClient: () => !!this.client,
        accept: (socket) => this.acceptConnection(socket),
        logInfo: (message) => this.logInfo(message),
      },
      enableOutboundReconnect,
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
    this.resetAssemblies();
    this.sessionId++;
    this.reconnector.onDisconnected(this.sessionId);
  };

  async start(): Promise<void> {
    await this.startServer();
    this.reconnector.start();
  }

  async stop(): Promise<void> {
    this.reconnector.stop();
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

  /** Forward a device dial event as the matching Stream Deck + encoder report.
   *  Dropped when the advertised geometry has no such encoder (e.g. an MK.2 pairing). */
  sendDial(event: DialEvent): void {
    const count = this.childGeometry.encoderCount ?? 0;
    const { index } = event;
    if (index < 0 || index >= count) return;
    if (event.kind === 'rotate') {
      const pkt = buildEncoderRotateReport(count, index, event.delta);
      this.sendFrame(pkt, 0, 0, 0, `CORA encoder-rotate index=${index} delta=${event.delta}`);
      return;
    }
    if (event.state === 'down') this.encoderPressMask |= 1 << index;
    else this.encoderPressMask &= ~(1 << index);
    const pkt = buildEncoderPressReport(count, this.encoderPressMask);
    this.sendFrame(pkt, 0, 0, 0, `CORA encoder-press mask=${this.encoderPressMask}`);
  }

  /** Forward a touch-strip gesture. Only a Plus-advertised geometry has a strip; an
   *  MK.2 session must not see touch reports. */
  sendTouch(event: TouchInputEvent): void {
    const { touchWidth = 0, touchHeight = 0 } = this.childGeometry;
    if (touchWidth === 0 || touchHeight === 0) return;
    const pkt = buildTouchReport(event, touchWidth, touchHeight);
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
      // Image chunks record their rx entry after the ACK is written (see ackImage).
      this.rxDeferred = isBulkChunk(payload);
      if (!this.rxDeferred) this.traceRx(flags, hidOp, messageId, payload);
      this.routeChildPacket(flags, hidOp, messageId, payload);
      if (this.rxDeferred) this.traceRx(flags, hidOp, messageId, payload);
    } catch (err) {
      this.emitLog('error', `child handleCoraPacket error: ${(err as Error).message}`);
      this.emitLog('debug', `child handleCoraPacket stack: ${(err as Error).stack}`);
    }
  }

  private traceRx(flags: number, hidOp: number, messageId: number, payload: Buffer): void {
    this.rxDeferred = false;
    if (!this.commTracing) return;
    if (this.countBulkComm && isBulkChunk(payload)) {
      this.countComm('image-chunk-rx');
      return;
    }
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
  }

  /** Elgato waits for the ACK of a key image's last chunk (only that chunk sets
   *  REQACK), so it goes out before any tracing or assembly. */
  private ackImage(flags: number, hidOp: number, messageId: number, payload: Buffer): void {
    const ack = (flags & CORA_FLAG_REQACK) !== 0 ? this.writeAckNak(messageId, hidOp) : null;
    this.traceRx(flags, hidOp, messageId, payload);
    if (ack) this.traceAckNak(ack, messageId, hidOp, true);
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

    if (isVerbatim) {
      const probe = buildVerbatimProbeReport(byte0, this.deviceConfig);
      if (probe) {
        this.sendFrame(probe, CORA_VERBATIM_RESULT, hidOp, messageId);
        return;
      }
    }
    if (byte0 === PAYLOAD_TYPE_FEATURE && this.handleFeatureRequest(byte1, hidOp, messageId))
      return;
    if (hidOp === HID_OP_GET_REPORT) {
      this.handleGetReport(byte0, messageId, payload);
      return;
    }
    if (hidOp === HID_OP_SEND_REPORT || byte0 === PAYLOAD_TYPE_FEATURE) {
      this.handleSendReport(payload, flags, messageId);
      return;
    }
    if (byte0 === PAYLOAD_TYPE_OUTPUT_REPORT)
      this.handleOutputReport(byte1, flags, hidOp, messageId, payload);
  }

  private handleFeatureRequest(byte1: number, hidOp: number, messageId: number): boolean {
    switch (byte1) {
      case FEATURE_KEEPALIVE_ACK:
      case FEATURE_GET_DEVICE_INFO:
        return true;
      case FEATURE_GET_CAPABILITIES:
        this.sendFrame(this.buildSelfDeviceInfo(), CORA_FLAG_RESULT, hidOp, messageId);
        return true;
      default:
        return false;
    }
  }

  private handleGetReport(reportId: number, messageId: number, payload: Buffer): void {
    const spec = CHILD_REPORT_SPECS.get(reportId);
    if (!spec) return;
    const r = spec.build(this.deviceConfig, reportId);
    spec.trace?.(this.emitLogFn, messageId, payload, r);
    this.sendFrame(
      r,
      CORA_VERBATIM_RESULT,
      0,
      messageId,
      spec.desc?.(this.deviceConfig, messageId),
    );
  }

  private handleSendReport(payload: Buffer, flags: number, messageId: number): void {
    if (payload.length < 3) return;
    const level = parseChildBrightness(payload);
    if (level === undefined) return;
    this.emit('brightness', level);
    if (flags & CORA_FLAG_REQACK) this.sendAckNak(messageId);
  }

  /** Image and Stream Deck + surface chunks. ACK before assembly: Elgato waits for
   *  the ACK of a key image's last chunk before sending the next image, so assembly
   *  must not delay it. */
  private handleOutputReport(
    cmd: number,
    flags: number,
    hidOp: number,
    messageId: number,
    payload: Buffer,
  ): void {
    switch (cmd) {
      case IMG_CMD_WRITE:
        if (isLevelEnabled('debug')) {
          traceImageChunk(this.emitLogFn, payload, messageId, this.msSinceConnect());
        }
        this.ackImage(flags, hidOp, messageId, payload);
        this.handleImageChunk(payload);
        return;
      case GEN1_IMG_CMD:
        if (isLevelEnabled('debug')) {
          traceGen1ImageChunk(this.emitLogFn, payload, messageId, this.msSinceConnect());
        }
        this.ackImage(flags, hidOp, messageId, payload);
        this.handleGen1ImageChunk(payload);
        return;
      case IMG_CMD_LCD:
      case IMG_CMD_WINDOW:
      case IMG_CMD_WINDOW_PARTIAL: {
        this.ackImage(flags, hidOp, messageId, payload);
        const touch = this.touchStrip.accept(cmd, payload, this.emitLogFn);
        if (touch) this.emit('touchImage', touch);
      }
    }
  }

  private resetAssemblies(): void {
    this.imagePages = new Map();
    this.gen1ImagePages = new Map();
    this.touchStrip.reset();
    this.assemblyBudget.clear();
  }

  private msSinceConnect(): number {
    return this.sessionStartTs ? Date.now() - this.sessionStartTs : 0;
  }

  private handleImageChunk(pkt: Buffer): void {
    const keyCount = this.childGeometry.keyCount;
    const key = pkt[IMAGE_CHUNK_KEY_OFFSET]!;
    if (!isValidChildImageKey(key, keyCount, this.warnedOobKeys, this.emitLogFn)) return;
    const event = assembleImageChunk(this.imagePages, pkt, this.assemblyBudget);
    if (event) this.emit('image', event);
  }

  private handleGen1ImageChunk(pkt: Buffer): void {
    const keyCount = this.childGeometry.keyCount;
    const key = pkt[GEN1_IMAGE_KEY_OFFSET]! - 1;
    if (!isValidChildImageKey(key, keyCount, this.warnedOobKeys, this.emitLogFn)) return;
    const event = assembleGen1ImageChunk(this.gen1ImagePages, pkt, this.assemblyBudget);
    if (event) this.emit('image', event);
  }

  protected onClientConnected(socket: net.Socket): void {
    this.reconnector.onInbound(socket.remoteAddress);
    this.logInfo(
      `child TCP connection attempt from ${socket.remoteAddress} (session=${this.sessionId + 1})`,
    );

    this.sessionStartTs = Date.now();
    this.keyStates = new Uint8Array(this.childGeometry.keyCount);
    this.resetAssemblies();
    this.encoderPressMask = 0;
    this.warnedOobKeys.clear();
  }

  protected override traceAckNak(
    frame: Buffer,
    messageId: number,
    hidOp: number,
    bulk = false,
  ): void {
    const wantsLog = isLevelEnabled('debug');
    const wantsComm = this.commTracing;
    const counted = wantsComm && bulk && this.countBulkComm;
    if (counted) this.countComm('ack-tx');
    const storeComm = wantsComm && !counted;
    if (!wantsLog && !storeComm) return;
    const desc = ackDescription(messageId, hidOp);
    if (wantsLog) {
      const since = this.sessionStartTs ? `+${Date.now() - this.sessionStartTs}ms` : '';
      this.emitLog('debug', `child tx: ${desc} (${frame.length}B)${since}`);
    }
    if (storeComm) this.emitComm('tx', desc, frame);
  }

  protected override sendFrame(
    payload: Buffer,
    flags: number,
    hidOp: number,
    messageId: number,
    description?: string,
    // Keepalives fire constantly; callers mark them noisy so they log at debug
    // instead of becoming an info-level WS broadcast each.
    noisy = false,
  ): void {
    const frame = encodeCoraFrame(payload, flags, hidOp, messageId);
    // Write FIRST, then trace — matching the base class. Elgato ACK-paces key
    // images, so anything ahead of the write throttles image delivery.
    this.client?.write(frame);

    const wantsLog = isLevelEnabled(noisy ? 'debug' : 'info');
    const wantsComm = this.commTracing;
    if (!wantsLog && !wantsComm) return;

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
    if (wantsLog) {
      const msSinceConnect = this.sessionStartTs ? `+${Date.now() - this.sessionStartTs}ms` : '';
      this.emitLog(
        noisy ? 'debug' : 'info',
        `child tx: ${desc} (${frame.length}B)${msSinceConnect}`,
      );
    }
    if (wantsComm) this.emitComm('tx', desc, frame);
  }
}
