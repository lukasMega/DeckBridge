import * as net from './platform/tcp.js';
import {
  DEFAULT_DOCK_FIRMWARE_VERSION,
  DEFAULT_CHILD_FIRMWARE_VERSION,
  DEFAULT_DOCK_SERIAL_NUMBER,
  DEFAULT_CHILD_SERIAL_NUMBER,
  ELGATO_VID,
  ELGATO_MK2_PID,
  ELGATO_TCP_PORT,
  ELGATO_CHILD_PORT,
  ELGATO_PKT_SIZE_TX,
  ELGATO_PKT_SIZE_RX,
  NETWORK_DOCK_PID,
  PAYLOAD_TYPE_FEATURE,
  FEATURE_KEEPALIVE_ACK,
  FEATURE_GET_CAPABILITIES,
  FEATURE_GET_DEVICE_INFO,
  DEFAULT_MAC_ADDRESS,
} from './types.js';
import { CORA_FLAG_RESULT } from './cora-frame.js';
import { CoraServerBase } from './cora-server-base.js';
import { describeCoraPayload } from './cora-describe.js';
import type { DeviceConfig } from './elgato-types.js';
import { buildFeatureResponse } from './feature-response.js';
import { buildCapabilitiesPacket, type ChildGeometry, MK2_CHILD_GEOMETRY } from './capabilities.js';
import { MdnsAdvertiser } from './mdns-advertiser.js';

export type { DeviceConfig };

export class ElgatoServer extends CoraServerBase {
  private mdnsAdvertiser: MdnsAdvertiser | null = null;
  private readonly skipMdns: boolean;
  private childGeometry: ChildGeometry = MK2_CHILD_GEOMETRY;
  private lastAdvertisedPid = -1;
  private lastAdvertisedSerial = '';

  readonly deviceConfig: DeviceConfig = {
    dockFirmwareVersion: DEFAULT_DOCK_FIRMWARE_VERSION,
    childFirmwareVersion: DEFAULT_CHILD_FIRMWARE_VERSION,
    serialNumber: DEFAULT_DOCK_SERIAL_NUMBER,
    childSerialNumber: DEFAULT_CHILD_SERIAL_NUMBER,
    productId: ELGATO_MK2_PID,
    macAddress: [...DEFAULT_MAC_ADDRESS],
  };

  protected componentName = 'elgato';

  setDeviceConfig(config: Partial<DeviceConfig>): void {
    Object.assign(this.deviceConfig, config);
  }

  setChildGeometry(geo: ChildGeometry): void {
    this.childGeometry = geo;
  }

  restartMdns(productId: number): void {
    if (!this.mdnsAdvertiser) return;
    if (
      this.lastAdvertisedPid === productId &&
      this.lastAdvertisedSerial === this.deviceConfig.serialNumber
    ) {
      return; // identity unchanged — avoid respawn churn
    }
    this.lastAdvertisedPid = productId;
    this.lastAdvertisedSerial = this.deviceConfig.serialNumber;
    this.mdnsAdvertiser.stop();
    this.mdnsAdvertiser.updateIdentity(productId, this.deviceConfig.serialNumber);
    void this.mdnsAdvertiser.start();
  }

  constructor(port = ELGATO_TCP_PORT, skipMdns = false) {
    super(port);
    this.skipMdns = skipMdns;
  }

  async start(): Promise<void> {
    await this.startServer();
    if (!this.skipMdns) {
      this.mdnsAdvertiser = new MdnsAdvertiser(this.port, (level, message) =>
        this.emitLog(level, message),
      );
      this.mdnsAdvertiser.updateIdentity(
        this.deviceConfig.productId,
        this.deviceConfig.serialNumber,
      );
      await this.mdnsAdvertiser.start();
    }
  }

  async stop(): Promise<void> {
    this.mdnsAdvertiser?.stop();
    this.mdnsAdvertiser = null;
    await this.stopServer();
  }

  protected onClientConnected(_socket: net.Socket): void {
    this.emitLog('info', 'primary (Network Dock) connected');
    this.sendKeepalive();
  }

  pushChildCapabilities(): void {
    if (!this.client) {
      this.emitLog('info', 'primary push caps: no client');
      return;
    }
    const r = this.buildChildDeviceInfo();
    this.sendFrame(
      r,
      0,
      0,
      0,
      `CORA push child-caps PID=0x${this.deviceConfig.productId.toString(16).padStart(4, '0')} port=${ELGATO_CHILD_PORT}`,
    );
  }

  private buildDeviceInfo(): Buffer {
    const pkt = Buffer.alloc(ELGATO_PKT_SIZE_TX);
    pkt[0] = PAYLOAD_TYPE_FEATURE;
    pkt[1] = FEATURE_GET_DEVICE_INFO;
    pkt.writeUInt16LE(ELGATO_VID, 12);
    pkt.writeUInt16LE(NETWORK_DOCK_PID, 14);
    return pkt;
  }

  private buildChildDeviceInfo(): Buffer {
    return buildCapabilitiesPacket(this.deviceConfig, ELGATO_CHILD_PORT, this.childGeometry);
  }

  protected handleCoraPacket(
    flags: number,
    hidOp: number,
    messageId: number,
    payload: Buffer,
  ): void {
    if (payload.length < 2) return;

    const byte0 = payload[0]!;
    const byte1 = payload[1]!;
    this.emitComm('rx', describeCoraPayload(payload, flags, hidOp, messageId), payload);

    if (byte0 === PAYLOAD_TYPE_FEATURE && byte1 === FEATURE_KEEPALIVE_ACK) {
      this.emitLog('info', `primary keepalive ACK seq=${payload.length > 2 ? payload[2] : '?'}`);
      return;
    }

    if (byte0 === PAYLOAD_TYPE_FEATURE && byte1 === FEATURE_GET_DEVICE_INFO) {
      this.sendFrame(
        this.buildDeviceInfo(),
        CORA_FLAG_RESULT,
        hidOp,
        messageId,
        `CORA device-info VID=0x${ELGATO_VID.toString(16)} PID=0x${NETWORK_DOCK_PID.toString(16)} [msgId=${messageId}]`,
      );
      return;
    }

    if (byte0 === PAYLOAD_TYPE_FEATURE && byte1 === FEATURE_GET_CAPABILITIES) {
      const pid = this.deviceConfig.productId.toString(16).padStart(4, '0');
      this.emitLog('info', `0x1c handler fired — PID=0x${pid} port=${ELGATO_CHILD_PORT}`);
      const r = this.buildChildDeviceInfo();
      this.sendFrame(
        r,
        CORA_FLAG_RESULT,
        hidOp,
        messageId,
        `CORA 0x1c child-device-info PID=0x${pid} port=${ELGATO_CHILD_PORT} [msgId=${messageId}]`,
      );
      return;
    }

    if (byte0 === PAYLOAD_TYPE_FEATURE) {
      let label: string;
      if (byte1 === 0x08) {
        label = '0x08 GetUnitInfo FALLTHROUGH';
      } else if (byte1 === 0x0b) {
        label = '0x0B devinfo FALLTHROUGH';
      } else {
        label = `non-VERB feature GET 0x${byte1.toString(16).padStart(2, '0')}`;
      }
      this.emitLog('info', `primary ${label} msgId=${messageId}`);
      const r = buildFeatureResponse(byte1, this.deviceConfig, ELGATO_PKT_SIZE_RX);
      this.sendFrame(
        r,
        CORA_FLAG_RESULT,
        hidOp,
        messageId,
        `CORA feature response 0x${byte1.toString(16).padStart(2, '0')} [msgId=${messageId}]`,
      );
    }
  }
}
