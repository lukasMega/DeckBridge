// Packet-fixture replay (not a *.test.ts, so run-tests.mjs never runs it standalone).
// Drives the real drivers through the same seam hid-worker-batching.test.ts uses: the
// hidapi symbol table is faked, so every byte the driver would hand to the OS is captured
// and compared with the fixture. Never opens hardware.
import { ElgatoHidDriver } from '../../src/devices/elgato/driver.js';
import { findModelById } from '../../src/devices/registry.js';
import { USB_DRIVERS, type UsbDriver } from '../../src/devices/usb-drivers.js';
import {
  bytesOfHex,
  validateFixtureShape,
  type FixtureEvent,
  type FixtureStep,
  type PacketFixture,
} from '../../src/dev/packet-fixture.js';

export interface LoadedFixture {
  /** Path shown in failure messages. */
  file: string;
  fixture: PacketFixture;
  size: number;
}

type WireEntry =
  | { op: 'write'; bytes: Uint8Array }
  | { op: 'feature'; bytes: Uint8Array }
  | { op: 'close' };

type Loose = Record<string, (...args: unknown[]) => unknown>;

const FIXTURE_ROOT = 'test/fixtures/packets';

const byName = (a: string, b: string): number => a.localeCompare(b);

export async function loadFixtures(root = FIXTURE_ROOT): Promise<LoadedFixture[]> {
  const out: LoadedFixture[] = [];
  const dirs: string[] = [];
  for await (const ent of await tjs.readDir(root)) dirs.push(ent.name);
  dirs.sort(byName);
  for (const dir of dirs) {
    const names: string[] = [];
    for await (const ent of await tjs.readDir(`${root}/${dir}`)) names.push(ent.name);
    names.sort(byName);
    for (const name of names.filter((n) => n.endsWith('.json'))) {
      const file = `${root}/${dir}/${name}`;
      const raw = await tjs.readFile(file);
      const fixture = JSON.parse(new TextDecoder().decode(raw)) as PacketFixture;
      out.push({ file, fixture, size: raw.length });
    }
  }
  return out;
}

/** Index of the first byte where the buffers differ (length difference counts), or -1. */
export function firstDiff(expected: Uint8Array, actual: Uint8Array): number {
  const n = Math.min(expected.length, actual.length);
  for (let i = 0; i < n; i++) if (expected[i] !== actual[i]) return i;
  return expected.length === actual.length ? -1 : n;
}

function byteLabel(bytes: Uint8Array, at: number): string {
  return at < bytes.length ? `0x${bytes[at]!.toString(16).padStart(2, '0')}` : 'end of data';
}

// The worker's own factory table, so a fixture replays against the driver it would get.
function makeDriver(modelId: string): UsbDriver {
  const model = findModelById(modelId)!;
  return USB_DRIVERS[model.protocol](model);
}

class FakeWire {
  readonly log: WireEntry[] = [];
  readonly featureIn: Uint8Array[] = [];

  readonly symbols = {
    hid_write: (_dev: unknown, buf: Uint8Array, len: number): number => {
      this.log.push({ op: 'write', bytes: Uint8Array.from(buf.subarray(0, len)) });
      return len;
    },
    hid_send_feature_report: (_dev: unknown, buf: Uint8Array, len: number): number => {
      this.log.push({ op: 'feature', bytes: Uint8Array.from(buf.subarray(0, len)) });
      return len;
    },
    hid_get_feature_report: (_dev: unknown, buf: Uint8Array, len: number): number => {
      const reply = this.featureIn.shift();
      if (!reply) return 0;
      const n = Math.min(len, reply.length);
      buf.set(reply.subarray(0, n));
      return n;
    },
    // The poll loop must see an idle device; input is injected through parseInput.
    hid_read_timeout: (): number => 0,
    hid_close: (): void => {
      this.log.push({ op: 'close' });
    },
    hid_exit: (): number => 0,
  };

  attach(driver: UsbDriver): void {
    const hidLib = { symbols: this.symbols, close: (): void => undefined };
    (driver as unknown as Loose)._openPath = (path: unknown): unknown => {
      Object.assign(driver, { device: {}, hidLib, hidPath: path });
      return this.symbols;
    };
  }
}

function normalize(kind: string, e: Record<string, unknown>): FixtureEvent | { type: string } {
  if (kind === 'key') {
    return { type: e.state === 'down' ? 'press' : 'release', key: e.keyIndex as number };
  }
  if (kind === 'dial') return { type: 'dial', ...e };
  if (kind === 'touch') {
    const { type, ...rest } = e;
    return { type: 'touch', kind: type, ...rest } as FixtureEvent;
  }
  return { type: kind };
}

function canon(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const fields = Object.keys(obj)
      .toSorted(byName)
      .map((k) => k + ':' + canon(obj[k]));
    return '{' + fields.join(',') + '}';
  }
  return JSON.stringify(value);
}

function collectEvents(driver: UsbDriver): FixtureEvent[] {
  const events: FixtureEvent[] = [];
  for (const kind of ['key', 'dial', 'touch', 'inputAction', 'error']) {
    driver.on(kind, (e: unknown) => {
      const body = typeof e === 'object' && e !== null ? (e as Record<string, unknown>) : {};
      events.push(normalize(kind, body) as FixtureEvent);
    });
  }
  return events;
}

async function perform(
  driver: UsbDriver,
  step: Extract<FixtureStep, { op: 'call' }>,
): Promise<void> {
  const a = step.args ?? {};
  const d = driver as unknown as Loose;
  switch (step.call) {
    case 'open':
      return driver.open('fixture');
    case 'close':
      return driver.close();
    case 'sendImage':
      d.sendImage!(a.key, bytesOfHex(a.payloadHex as string));
      return;
    case 'setBrightness':
      d.setBrightness!(a.level);
      return;
    case 'clearKey':
      d.clearKey!(a.key);
      return;
    case 'setSleep':
      d.setSleep!(a.asleep);
      return;
    case 'keepAlive':
      // The timer is 10 s; replay calls its body instead of waiting.
      d.writeKeepAlive!();
      return;
    default:
      throw new Error(`unknown call '${step.call}'`);
  }
}

function parseInput(driver: UsbDriver, bytes: Uint8Array): void {
  const d = driver as unknown as Loose;
  if (driver instanceof ElgatoHidDriver) d._parseInput!(bytes);
  else d.parseInput!(Buffer.from(bytes));
}

class Replay {
  private cursor = 0;
  private readonly wire = new FakeWire();
  private readonly driver: UsbDriver;
  private readonly events: FixtureEvent[];

  constructor(private readonly loaded: LoadedFixture) {
    this.driver = makeDriver(loaded.fixture.model);
    this.wire.attach(this.driver);
    this.events = collectEvents(this.driver);
  }

  private fail(i: number, msg: string): never {
    throw new Error(`${this.loaded.file} step ${i}: ${msg}`);
  }

  private drained(i: number): void {
    const extra = this.wire.log[this.cursor];
    if (extra) {
      this.fail(i, `driver produced an unexpected extra ${extra.op} (log entry ${this.cursor})`);
    }
  }

  private async call(i: number, step: Extract<FixtureStep, { op: 'call' }>): Promise<void> {
    this.drained(i);
    await perform(this.driver, step);
    for (const [prop, want] of Object.entries(step.expectProps ?? {})) {
      const got = String((this.driver as unknown as Record<string, unknown>)[prop]);
      if (got !== want) this.fail(i, `${prop} is '${got}', expected '${want}'`);
    }
  }

  private read(i: number, step: Extract<FixtureStep, { op: 'read' }>): void {
    this.events.length = 0;
    parseInput(this.driver, bytesOfHex(step.hex));
    const got = canon(this.events);
    if (got !== canon(step.expect)) {
      this.fail(i, `events differ: expected ${canon(step.expect)}, got ${got}`);
    }
  }

  private wireStep(i: number, step: Extract<FixtureStep, { op: 'write' | 'feature' | 'close' }>) {
    const entry = this.wire.log[this.cursor++];
    if (!entry) this.fail(i, `expected a ${step.op}, but the driver produced nothing`);
    if (entry.op !== step.op) this.fail(i, `expected ${step.op}, driver did ${entry.op}`);
    if (step.op === 'close') return;
    const want = bytesOfHex(step.hex);
    const got = (entry as { bytes: Uint8Array }).bytes;
    const at = firstDiff(want, got);
    if (at < 0) return;
    const detail = `expected ${byteLabel(want, at)}, got ${byteLabel(got, at)}`;
    this.fail(
      i,
      `${step.op} mismatch at byte offset ${at} (${detail}; ` +
        `expected ${want.length} bytes, got ${got.length})`,
    );
  }

  private async step(i: number, step: FixtureStep): Promise<void> {
    if (step.op === 'call') await this.call(i, step);
    else if (step.op === 'read') this.read(i, step);
    else if (step.op === 'feature' && step.dir === 'in') {
      this.wire.featureIn.push(bytesOfHex(step.hex));
    } else this.wireStep(i, step);
  }

  async run(): Promise<void> {
    const { fixture, file } = this.loaded;
    try {
      if (fixture.assumeOpen) {
        await this.driver.open('fixture');
        this.wire.log.length = 0;
      }
      for (const [i, step] of fixture.steps.entries()) await this.step(i, step);
      this.drained(fixture.steps.length);
      if (this.wire.featureIn.length > 0) {
        throw new Error(`${file}: ${this.wire.featureIn.length} queued feature reply never read`);
      }
    } finally {
      // Stops the poll/keepalive timers; wire traffic after the last step is irrelevant.
      await this.driver.close();
    }
  }
}

/** Replay one fixture; throws an Error naming the file, step index and (for bytes) the
 *  first differing offset. */
export async function replayFixture(loaded: LoadedFixture): Promise<void> {
  if (!findModelById(loaded.fixture.model)) {
    throw new Error(`${loaded.file}: unknown model '${loaded.fixture.model}'`);
  }
  await new Replay(loaded).run();
}

/** Shape problems for every fixture plus model/pid/interface agreement with the registry. */
export function checkFixtureIdentity({ file, fixture, size }: LoadedFixture): string[] {
  const errors = validateFixtureShape(fixture, size).map((e) => `${file}: ${e}`);
  const model = findModelById(fixture.model);
  if (!model) return [...errors, `${file}: unknown model '${fixture.model}'`];
  const pids = model.usbProductIds.map((p) => `0x${p.toString(16).padStart(4, '0')}`);
  if (!pids.includes(fixture.pid)) errors.push(`${file}: pid ${fixture.pid} not in ${pids.join()}`);
  const want =
    model.usagePage === undefined ? null : { usagePage: model.usagePage, usage: model.usage };
  if (canon(fixture.interface) !== canon(want)) {
    errors.push(`${file}: interface ${canon(fixture.interface)} != model ${canon(want)}`);
  }
  if (!file.includes(`/${fixture.model}/`)) errors.push(`${file}: not under its model directory`);
  return errors;
}
