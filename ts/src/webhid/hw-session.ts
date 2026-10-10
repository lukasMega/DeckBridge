import type { DeviceModel } from '../devices/driver.js';
import type { DialEvent, KeyEvent, TouchInputEvent } from '../shared/types.js';
import { deviceInputToMk2Index, mk2IndexToDeviceImgId } from '../shared/key-map.js';
import { ElgatoCore } from '../devices/core/elgato-core.js';
import { MiraboxCore } from '../devices/core/mirabox-core.js';
import { Akp05Core, AKP05_KEEP_ALIVE_MS } from '../devices/core/akp05-core.js';
import { encodeKeyImage } from './encode.js';
import { HidTransport, reportLength } from './transport.js';

export class HwSession {
  private readonly core: ElgatoCore | MiraboxCore | Akp05Core;
  private timer: ReturnType<typeof setInterval> | undefined;
  private key: ((index: number, state: 'down' | 'up') => void) | undefined;
  private dial: ((event: DialEvent) => void) | undefined;
  private touch: ((event: TouchInputEvent) => void) | undefined;
  private paints: Promise<void> = Promise.resolve();
  private closing = false;
  private readonly icons = new Map<number, OffscreenCanvas>();

  constructor(
    private readonly device: HIDDevice,
    readonly model: DeviceModel,
    private readonly transport: HidTransport,
  ) {
    if (model.protocol === 'elgato-gen1' || model.protocol === 'elgato-gen2') {
      this.core = new ElgatoCore(model, transport);
    } else if (model.protocol === 'ajazz-akp05') this.core = new Akp05Core(model, transport.write);
    else this.core = new MiraboxCore(model, (report) => this.write(report));
    transport.onInput((data) => this.parseInput(data));
  }

  private write(report: Uint8Array): void {
    // K1's 1023-byte WebHID report omits the core's sacrificial zero.
    const length = reportLength(this.device, 'output', report[0]!);
    if (
      this.model.id === 'mirabox-k1pro' &&
      length === 1023 &&
      report.length === 1025 &&
      report[1024] === 0
    )
      this.transport.write(report.subarray(0, 1024));
    else this.transport.write(report);
  }

  async open(): Promise<void> {
    await this.device.open();
    const core = this.core;
    if (core instanceof MiraboxCore) {
      core.reset();
      const length = reportLength(this.device, 'output', core.reportId);
      if (length !== null && this.model.wire.packetSizeCandidates?.includes(length))
        core.setPacketSize(length);
      core.init();
      core.startClock(Date.now());
      const ms = this.model.wire.heartbeatMs;
      if (ms)
        this.timer = setInterval(() => {
          if (core.heartbeat(Date.now())) {
            for (const [index, icon] of this.icons) void this.paint(index, icon);
          }
        }, ms);
    } else {
      core.init();
      if (core instanceof Akp05Core)
        this.timer = setInterval(() => core.keepAlive(), AKP05_KEEP_ALIVE_MS);
    }
    await this.transport.flush();
  }

  private parseInput(data: Uint8Array): void {
    let events: KeyEvent[];
    if (this.core instanceof Akp05Core) {
      events = [];
      for (const item of this.core.parseInput(data)) {
        if (item.kind === 'key') events.push(item.event);
        else if (item.kind === 'dial') this.dial?.(item.event);
        else if (item.kind === 'touch') this.touch?.(item.event);
      }
    } else events = this.core.parseInput(data) ?? [];
    for (const event of events) {
      const index = deviceInputToMk2Index(event.keyIndex, this.model);
      if (index >= 0 && index < this.model.keyCount) this.key?.(index, event.state);
    }
  }

  paint(index: number, icon: OffscreenCanvas): Promise<void> {
    const wireId = mk2IndexToDeviceImgId(index, this.model);
    if (wireId < 0 || this.closing) return Promise.resolve();
    this.icons.set(index, icon);
    this.paints = this.paints.then(async () => {
      if (this.closing) return;
      // Demo icons, like splashes, arrive upright rather than CORA-oriented.
      const spec = { ...this.model.image, ...this.model.splash?.transformOverride };
      const bytes = await encodeKeyImage(icon, spec);
      if (!this.closing) this.core.sendImage(wireId, bytes);
      await this.transport.flush();
    });
    return this.paints;
  }

  paintStrip(zone: number, icon: OffscreenCanvas): Promise<void> {
    const display = this.model.widgetDisplays?.[zone];
    if (!display || this.closing || !(this.core instanceof Akp05Core)) return Promise.resolve();
    this.paints = this.paints.then(async () => {
      if (this.closing) return;
      const bytes = await encodeKeyImage(icon, display.image);
      if (!this.closing) this.core.sendImage(display.wireId, bytes);
      await this.transport.flush();
    });
    return this.paints;
  }

  onDial(fn: (event: DialEvent) => void): void {
    this.dial = fn;
  }
  onTouch(fn: (event: TouchInputEvent) => void): void {
    this.touch = fn;
  }

  setBrightness(level: number): void {
    if (!this.closing) this.core.setBrightness(level);
  }

  onKey(fn: (index: number, state: 'down' | 'up') => void): void {
    this.key = fn;
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    clearInterval(this.timer);
    try {
      await this.paints.catch(() => undefined);
      if (this.device.opened && this.core instanceof ElgatoCore) this.core.close();
      else if (this.device.opened && this.core instanceof MiraboxCore) {
        for (const report of this.core.closeReports()) this.write(report);
      }
      await this.transport.flush();
    } finally {
      this.transport.dispose();
      if (this.device.opened) await this.device.close();
    }
  }
}
