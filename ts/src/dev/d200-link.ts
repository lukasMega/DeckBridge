import { HidDeviceBase } from '../devices/hid-device-base.js';
import { HID_REPORT_ID_BYTE } from '../devices/mirabox/protocol.js';
import { ULANZI_D200_MODEL } from '../devices/ulanzi/ulanzi-d200.js';
import { CMD, buildPacket } from '../devices/ulanzi/ulanzi-protocol.js';

const model = ULANZI_D200_MODEL;

/** Bare HID link for the D200 probes: open, write, read loop. The real driver
 *  (UlanziDriver) owns the handshake and keepalive and cannot be told to send
 *  arbitrary manifests. */
export class D200Link extends HidDeviceBase {
  private readonly scratch = Buffer.alloc(model.wire.packetSize + 1);

  constructor(
    private readonly handler: (data: Uint8Array) => void,
    private readonly readPollMs = 5,
  ) {
    super();
  }

  open(hidPath: string): void {
    const hid = this._openPath(hidPath);
    // The read buffer is reused: the handler must finish with the bytes synchronously.
    this._startReadLoop(hid, model.wire.inSize, this.readPollMs, (buf, n) =>
      this.handler(buf.subarray(0, n)),
    );
  }

  write(pkt: Buffer): boolean {
    this.scratch[0] = HID_REPORT_ID_BYTE;
    this.scratch.set(pkt, 1);
    return this._writeRaw(this.scratch, 'd200', (r, err) => `hid_write returned ${r}: ${err}`) >= 0;
  }

  close(): void {
    this._cleanup();
  }

  // LOCK is what the driver sends on the way out: the panel dims instead of freezing.
  protected onBeforeClose(): void {
    this.write(buildPacket(CMD.LOCK, 0));
  }

  protected _cleanup(): void {
    this._stopReadTimer();
    this._closeDevice();
    this._teardownLib();
  }
}
