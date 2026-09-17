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
  FEATURE_GET_CHILD_FW,
  FEATURE_GET_QUICK_PROBE,
  DEFAULT_MAC_ADDRESS,
  MDNS_SERVICE_NAME,
} from './types.js';
import { CORA_FLAG_RESULT } from './cora-frame.js';
import { CoraServerBase } from './cora-server-base.js';
import { describeCoraPayload } from './cora-describe.js';
import type { DeviceConfig } from './elgato-types.js';
import { buildFeatureResponse } from './feature-response.js';
import { buildCapabilitiesPacket, type ChildGeometry } from './capabilities.js';
import { MdnsAdvertiser } from './mdns-advertiser.js';

export type { DeviceConfig };

function nonVerbFeatureLabel(byte1: number): string {
  if (byte1 === 0x08) return '0x08 GetUnitInfo FALLTHROUGH';
  if (byte1 === 0x0b) return '0x0B devinfo FALLTHROUGH';
  return `non-VERB feature GET 0x${byte1.toString(16).padStart(2, '0')}`;
}

export interface ElgatoServerOptions {
  childPort?: number; // default ELGATO_CHILD_PORT
  mdnsServiceName?: string; // default MDNS_SERVICE_NAME
  dockSerial?: string; // default DEFAULT_DOCK_SERIAL_NUMBER
  childSerial?: string; // default DEFAULT_CHILD_SERIAL_NUMBER
}

export class ElgatoServer extends CoraServerBase {
  private mdnsAdvertiser: MdnsAdvertiser | null = null;
  private readonly skipMdns: boolean;
  readonly childPort: number;
  private mdnsServiceName: string;
  private childGeometry: ChildGeometry;
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

  /** What restartMdns()'s unchanged-identity early return compares against. Must be
   *  written by every path that (re)advertises, or the next restart respawns for nothing. */
  private rememberAdvertised(productId: number, serial: string): void {
    this.lastAdvertisedPid = productId;
    this.lastAdvertisedSerial = serial;
  }

  /** A fresh advertiser carrying the current name + identity, not yet started. */
  private spawnAdvertiser(): MdnsAdvertiser {
    const advertiser = new MdnsAdvertiser(
      this.port,
      (level, message) => this.emitLog(level, message),
      this.mdnsServiceName,
    );
    this.rememberAdvertised(this.deviceConfig.productId, this.deviceConfig.serialNumber);
    advertiser.updateIdentity(this.lastAdvertisedPid, this.lastAdvertisedSerial);
    return advertiser;
  }

  restartMdns(productId: number): void {
    const advertiser = this.mdnsAdvertiser;
    if (!advertiser) return;
    if (
      this.lastAdvertisedPid === productId &&
      this.lastAdvertisedSerial === this.deviceConfig.serialNumber
    ) {
      return; // identity unchanged — avoid respawn churn
    }
    this.rememberAdvertised(productId, this.deviceConfig.serialNumber);
    advertiser.stop();
    advertiser.updateIdentity(productId, this.deviceConfig.serialNumber);
    void advertiser.start();
  }

  /** Live-rename the mDNS service name (WebUI "Device Identity" edit). dns-sd and
   *  avahi-publish-service take the name as an argv, so it can't be updated in place:
   *  stop the old advertiser and spawn a fresh one. No-op before start(). */
  setMdnsServiceName(name: string): void {
    if (name === this.mdnsServiceName) return;
    this.mdnsServiceName = name;
    if (!this.mdnsAdvertiser) return;
    this.mdnsAdvertiser.stop();
    this.mdnsAdvertiser = this.spawnAdvertiser();
    void this.mdnsAdvertiser.start();
  }

  constructor(
    childGeometry: ChildGeometry,
    port = ELGATO_TCP_PORT,
    skipMdns = false,
    opts: ElgatoServerOptions = {},
  ) {
    super(port);
    this.childGeometry = childGeometry;
    this.skipMdns = skipMdns;
    this.childPort = opts.childPort ?? ELGATO_CHILD_PORT;
    this.mdnsServiceName = opts.mdnsServiceName ?? MDNS_SERVICE_NAME;
    if (opts.dockSerial !== undefined) this.deviceConfig.serialNumber = opts.dockSerial;
    if (opts.childSerial !== undefined) this.deviceConfig.childSerialNumber = opts.childSerial;
  }

  async start(): Promise<void> {
    await this.startServer();
    if (this.skipMdns) return;
    this.mdnsAdvertiser = this.spawnAdvertiser();
    await this.mdnsAdvertiser.start();
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
      `CORA push child-caps PID=0x${this.deviceConfig.productId.toString(16).padStart(4, '0')} port=${this.childPort}`,
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
    return buildCapabilitiesPacket(this.deviceConfig, this.childPort, this.childGeometry);
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

    if (byte0 !== PAYLOAD_TYPE_FEATURE) return;

    switch (byte1) {
      case FEATURE_KEEPALIVE_ACK:
        this.emitLog('info', `primary keepalive ACK seq=${payload.length > 2 ? payload[2] : '?'}`);
        return;

      case FEATURE_GET_DEVICE_INFO:
        this.sendFrame(
          this.buildDeviceInfo(),
          CORA_FLAG_RESULT,
          hidOp,
          messageId,
          `CORA device-info VID=0x${ELGATO_VID.toString(16)} PID=0x${NETWORK_DOCK_PID.toString(16)} [msgId=${messageId}]`,
        );
        return;

      case FEATURE_GET_CAPABILITIES: {
        const pid = this.deviceConfig.productId.toString(16).padStart(4, '0');
        this.emitLog('info', `0x1c handler fired — PID=0x${pid} port=${this.childPort}`);
        this.sendFrame(
          this.buildChildDeviceInfo(),
          CORA_FLAG_RESULT,
          hidOp,
          messageId,
          `CORA 0x1c child-device-info PID=0x${pid} port=${this.childPort} [msgId=${messageId}]`,
        );
        return;
      }

      default:
        // 0x87/0x8f are only ever queried by the genuine Elgato desktop app —
        // Bitfocus Companion's CORA client never asks for them (see
        // .claude/plans/2026-07-14_try-distinguish-bitfocus-companion-connection.md).
        if (byte1 === FEATURE_GET_CHILD_FW || byte1 === FEATURE_GET_QUICK_PROBE) {
          this.emit('clientAppDetected', 'elgato');
        }
        this.emitLog('info', `primary ${nonVerbFeatureLabel(byte1)} msgId=${messageId}`);
        this.sendFrame(
          buildFeatureResponse(byte1, this.deviceConfig, ELGATO_PKT_SIZE_RX),
          CORA_FLAG_RESULT,
          hidOp,
          messageId,
          `CORA feature response 0x${byte1.toString(16).padStart(2, '0')} [msgId=${messageId}]`,
        );
    }
  }
}
