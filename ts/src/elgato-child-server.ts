import * as net from './platform/tcp.js';
import {
  ELGATO_VID,
  ELGATO_CHILD_PORT,
  ELGATO_PKT_SIZE_TX,
  HID_OP_SEND_REPORT,
  HID_OP_GET_REPORT,
  PAYLOAD_TYPE_OUTPUT_REPORT,
  PAYLOAD_TYPE_FEATURE,
  IMG_CMD_WRITE,
  GEN1_IMG_CMD,
  IMAGE_CHUNK_KEY_OFFSET,
  GEN1_IMAGE_KEY_OFFSET,
  GEN1_IMAGE_LAST_OFFSET,
  FEATURE_KEEPALIVE_ACK,
  FEATURE_GET_CAPABILITIES,
  FEATURE_GET_DEVICE_INFO,
  REPORT_SECONDARY_DETECT,
  REPORT_FIRMWARE_VERSION,
  REPORT_SERIAL_NUMBER,
  REPORT_DEVICE_INFO,
  REPORT_BUTTON_STATE_INPUT,
  KEY_EVENT_RESERVED_BYTE,
  KEY_EVENT_STATE_OFFSET,
  SECONDARY_DETECT_RESPONSE_SIZE,
  FIRMWARE_REPORT_SIZE,
  SERIAL_REPORT_SIZE,
  DEVICE_INFO_REPORT_SIZE,
  DEVICE_INFO_VID_OFFSET,
  DEVICE_INFO_PID_OFFSET,
  FW_VERSION_FIELD_LEN,
  RECONNECT_DELAY_MS,
} from './types.js';
import type { KeyState } from './types.js';
import {
  CORA_FLAG_VERBATIM,
  CORA_FLAG_REQACK,
  CORA_FLAG_RESULT,
  encodeCoraFrame,
} from './cora-frame.js';
import { CoraServerBase } from './cora-server-base.js';
import { assembleImageChunk, assembleGen1ImageChunk } from './image-assembler.js';
import { describeChildPayload } from './cora-describe.js';
import type { DeviceConfig } from './elgato-types.js';
import { buildFwReport, buildVidPidReport, buildSerialReport } from './feature-response.js';
import { buildCapabilitiesPacket, type ChildGeometry, MK2_CHILD_GEOMETRY } from './capabilities.js';

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

  protected componentName = 'elgato-child';

  constructor(port: number, deviceConfig: DeviceConfig, enableOutboundReconnect = true) {
    super(port);
    this.deviceConfig = deviceConfig;
    this.enableOutboundReconnect = enableOutboundReconnect;
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

      if (isVerbatim && this.handleVerbatimProbe(byte0, hidOp, messageId)) return;
      if (byte0 === PAYLOAD_TYPE_FEATURE && this.handleFeatureRequest(byte1, hidOp, messageId))
        return;
      if (hidOp === HID_OP_GET_REPORT) {
        this.handleGetReport(byte0, flags, hidOp, messageId, payload);
        return;
      }
      if (hidOp === HID_OP_SEND_REPORT || byte0 === PAYLOAD_TYPE_FEATURE) {
        this.handleSendReport(payload, flags, hidOp, messageId);
        return;
      }
      this.handleOutputReportPacket(byte0, byte1, flags, hidOp, messageId, payload);
    } catch (err) {
      this.emitLog('error', `child handleCoraPacket error: ${(err as Error).message}`);
      this.emitLog('debug', `child handleCoraPacket stack: ${(err as Error).stack}`);
    }
  }

  // gen1 (Mini) probes — sent by desktop when PID identifies a gen1 device.
  // 0xa1 = device-info probe; 0xa4 = firmware-version probe (0xa0 + USB HID report id).
  private handleVerbatimProbe(byte0: number, hidOp: number, messageId: number): boolean {
    switch (byte0) {
      case REPORT_SECONDARY_DETECT: {
        const r = Buffer.alloc(SECONDARY_DETECT_RESPONSE_SIZE);
        r[0] = REPORT_SECONDARY_DETECT;
        this.sendFrame(r, CORA_FLAG_RESULT | CORA_FLAG_VERBATIM, hidOp, messageId);
        return true;
      }
      case 0xa1: {
        const r = buildVidPidReport(0xa1, 32, ELGATO_VID, this.deviceConfig.productId, 2, 4);
        this.sendFrame(r, CORA_FLAG_RESULT | CORA_FLAG_VERBATIM, hidOp, messageId);
        return true;
      }
      case 0xa4: {
        const r = buildFwReport(0xa4, 32, 5, this.deviceConfig.childFirmwareVersion);
        this.sendFrame(r, CORA_FLAG_RESULT | CORA_FLAG_VERBATIM, hidOp, messageId);
        return true;
      }
      default:
        return false;
    }
  }

  private handleFeatureRequest(byte1: number, hidOp: number, messageId: number): boolean {
    switch (byte1) {
      case FEATURE_KEEPALIVE_ACK:
      case FEATURE_GET_DEVICE_INFO:
        return true;
      case FEATURE_GET_CAPABILITIES: {
        const r = this.buildSelfDeviceInfo();
        this.sendFrame(r, CORA_FLAG_RESULT, hidOp, messageId);
        return true;
      }
      default:
        return false;
    }
  }

  private handleOutputReportPacket(
    byte0: number,
    byte1: number,
    flags: number,
    hidOp: number,
    messageId: number,
    payload: Buffer,
  ): void {
    if (byte0 !== PAYLOAD_TYPE_OUTPUT_REPORT) return;
    const msSinceConnect = this.sessionStartTs ? Date.now() - this.sessionStartTs : 0;
    if (byte1 === IMG_CMD_WRITE) {
      this.emitLog(
        'debug',
        `child rx: image-data chunk key=${payload[2]}${payload[3] === 1 ? ' LAST' : ''} ${payload.readUInt16LE(4)}B msgId=${messageId} (+${msSinceConnect}ms)`,
      );
      if (flags & CORA_FLAG_REQACK) this.sendAckNak(messageId, hidOp);
      this.handleImageChunk(payload, messageId);
    } else if (byte1 === GEN1_IMG_CMD) {
      this.emitLog(
        'debug',
        `child rx: gen1 image chunk key=${payload[GEN1_IMAGE_KEY_OFFSET]! - 1}` +
          `${payload[GEN1_IMAGE_LAST_OFFSET] === 1 ? ' LAST' : ''} msgId=${messageId} (+${msSinceConnect}ms)`,
      );
      if (flags & CORA_FLAG_REQACK) this.sendAckNak(messageId, hidOp);
      this.handleGen1ImageChunk(payload, messageId);
    }
  }

  private readonly getReportHandlers: Map<number, (messageId: number, payload: Buffer) => void> =
    new Map([
      // gen1 serial number: ASCII at offset 5, null-terminated
      [
        0x03,
        (messageId: number) => {
          const r = buildSerialReport(
            0x03,
            SERIAL_REPORT_SIZE,
            5,
            this.deviceConfig.childSerialNumber,
          );
          this.sendFrame(r, CORA_FLAG_RESULT | CORA_FLAG_VERBATIM, 0, messageId);
        },
      ],
      // gen1 firmware version: ASCII at offset 5, null-terminated
      [
        0x04,
        (messageId: number) => {
          const r = buildFwReport(
            0x04,
            FIRMWARE_REPORT_SIZE,
            5,
            this.deviceConfig.childFirmwareVersion,
          );
          this.sendFrame(r, CORA_FLAG_RESULT | CORA_FLAG_VERBATIM, 0, messageId);
        },
      ],
      [
        REPORT_FIRMWARE_VERSION,
        (messageId: number, payload: Buffer) => {
          const r = buildFwReport(
            REPORT_FIRMWARE_VERSION,
            FIRMWARE_REPORT_SIZE,
            6,
            this.deviceConfig.childFirmwareVersion,
            [0x0c, 0xf4, 0x5f, 0xed, 0xa6],
          );
          this.emitLog(
            'debug',
            `child rx: 0x05 raw payload (${(payload.subarray(0, 20) as Buffer).toString('hex')}) msgId=${messageId}`,
          );
          this.emitLog(
            'debug',
            `child tx: 0x05 raw response (${(r.subarray(0, 14) as Buffer).toString('hex')}) msgId=${messageId}`,
          );
          this.sendFrame(r, CORA_FLAG_RESULT | CORA_FLAG_VERBATIM, 0, messageId);
        },
      ],
      [
        REPORT_SERIAL_NUMBER,
        (messageId: number, payload: Buffer) => {
          const id = this.deviceConfig.childSerialNumber.slice(0, 12);
          const r = buildSerialReport(REPORT_SERIAL_NUMBER, SERIAL_REPORT_SIZE, 2, id, [0x0c]);
          if (payload.length > 1 && payload[1] !== 0) {
            const written = (payload.subarray(2, 2 + payload[1]!) as Buffer).toString('hex');
            this.emitLog(
              'debug',
              `child rx: 0x06 write ignored (len=${payload[1]} data=${written}), returning device id`,
            );
          }
          this.sendFrame(
            r,
            CORA_FLAG_RESULT | CORA_FLAG_VERBATIM,
            0,
            messageId,
            `CORA GET_REPORT 0x06 id=${id} msgId=${messageId}`,
          );
        },
      ],
      [
        REPORT_DEVICE_INFO,
        (messageId: number) => {
          const r = buildVidPidReport(
            REPORT_DEVICE_INFO,
            DEVICE_INFO_REPORT_SIZE,
            ELGATO_VID,
            this.deviceConfig.productId,
            DEVICE_INFO_VID_OFFSET,
            DEVICE_INFO_PID_OFFSET,
          );
          this.sendFrame(r, CORA_FLAG_RESULT | CORA_FLAG_VERBATIM, 0, messageId);
        },
      ],
      [0x11, (messageId: number) => this.sendFwFieldReport(0x11, messageId)],
      [0x13, (messageId: number) => this.sendFwFieldReport(0x13, messageId)],
    ]);

  private sendFwFieldReport(reportId: number, messageId: number): void {
    const r = buildFwReport(reportId, 32, 6, this.deviceConfig.childFirmwareVersion, [
      FW_VERSION_FIELD_LEN,
    ]);
    this.sendFrame(r, CORA_FLAG_RESULT | CORA_FLAG_VERBATIM, 0, messageId);
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
    this.tryExtractBrightness(payload, flags, messageId);
  }

  // Returns true when payload carried a brightness command (emitted + ACKed).
  private tryExtractBrightness(payload: Buffer, flags: number, messageId: number): boolean {
    let level: number | undefined;
    if (payload[0] === PAYLOAD_TYPE_FEATURE && [0x02, 0x05, 0x08, 0x0d].includes(payload[1]!)) {
      level = payload[2];
    } else if (
      // gen1 brightness: [0x05, 0x55, 0xaa, 0xd1, 0x01, percentage]
      payload.length >= 6 &&
      payload[0] === 0x05 &&
      payload[1] === 0x55 &&
      payload[2] === 0xaa &&
      payload[3] === 0xd1
    ) {
      level = payload[5];
    }
    if (level === undefined) return false;
    this.emit('brightness', level);
    if (flags & CORA_FLAG_REQACK) {
      this.sendAckNak(messageId);
    }
    return true;
  }

  private isValidImageKey(keyIndex: number): boolean {
    if (keyIndex >= 0 && keyIndex < this.childGeometry.keyCount) return true;
    if (!this.warnedOobKeys.has(keyIndex)) {
      this.warnedOobKeys.add(keyIndex);
      this.emitLog(
        'warn',
        `dropping image chunk for out-of-range key ${keyIndex} (keyCount=${this.childGeometry.keyCount})`,
      );
    }
    return false;
  }

  private handleImageChunk(pkt: Buffer, _messageId: number): void {
    if (!this.isValidImageKey(pkt[IMAGE_CHUNK_KEY_OFFSET]!)) return;
    const event = assembleImageChunk(this.imagePages, pkt);
    if (event) {
      this.emit('image', event);
    }
  }

  private handleGen1ImageChunk(pkt: Buffer, _messageId: number): void {
    if (!this.isValidImageKey(pkt[GEN1_IMAGE_KEY_OFFSET]! - 1)) return;
    const event = assembleGen1ImageChunk(this.gen1ImagePages, pkt);
    if (event) this.emit('image', event);
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
