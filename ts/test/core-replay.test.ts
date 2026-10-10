import { bytesOfHex, type FixtureEvent, type FixtureStep } from '../src/dev/packet-fixture.js';
import { Akp05Core, type Akp05Input } from '../src/devices/core/akp05-core.js';
import { ElgatoCore } from '../src/devices/core/elgato-core.js';
import { MiraboxCore } from '../src/devices/core/mirabox-core.js';
import type { DeviceModel } from '../src/devices/driver.js';
import { findModelById } from '../src/devices/registry.js';
import type { KeyEvent } from '../src/shared/types.js';
import { test, summaryExit } from './helpers/harness.js';
import { firstDiff, loadFixtures, type LoadedFixture } from './helpers/packet-replay.js';

// The browser cores copy the desktop drivers' packet sequencing. Replaying the drivers'
// own packet fixtures against the cores keeps the two byte-identical.

type Wire = { op: 'write' | 'feature'; bytes: Uint8Array } | { op: 'close' };
type Sink = (report: Uint8Array) => void;
type Args = Record<string, unknown>;

interface CoreDevice {
  open(): void;
  /** Writes before hid_close; the harness logs the close itself. */
  close(): void;
  calls: Record<string, (a: Args) => void>;
  read(data: Uint8Array): FixtureEvent[];
}

const keys = (events: KeyEvent[]): FixtureEvent[] =>
  events.map((e) => ({ type: e.state === 'down' ? 'press' : 'release', key: e.keyIndex }));
const image = (a: Args): [number, Uint8Array] => [
  a.key as number,
  bytesOfHex(a.payloadHex as string),
];

// Same normalization as helpers/packet-replay.ts applies to the drivers' emits.
function akp05Events(input: Akp05Input): FixtureEvent[] {
  if (input.kind === 'key') return keys([input.event]);
  if (input.kind === 'dial') return [{ type: 'dial', ...input.event }];
  if (input.kind === 'touch') {
    const { type, ...rest } = input.event;
    return [{ type: 'touch', kind: type, ...rest } as FixtureEvent];
  }
  return input.kind === 'unmapped' ? [{ type: 'inputAction' } as unknown as FixtureEvent] : [];
}

function elgato(model: DeviceModel, write: Sink, sendFeature: Sink): CoreDevice {
  const core = new ElgatoCore(model, { write, sendFeature });
  return {
    open: () => core.init(),
    close: () => core.close(),
    calls: {
      sendImage: (a) => core.sendImage(...image(a)),
      clearKey: (a) => core.clearKey(a.key as number),
      setBrightness: (a) => core.setBrightness(a.level as number),
    },
    read: (data) => keys(core.parseInput(data)),
  };
}

function akp05(model: DeviceModel, write: Sink): CoreDevice {
  const core = new Akp05Core(model, write);
  return {
    open: () => core.init(),
    close: () => undefined,
    calls: {
      sendImage: (a) => core.sendImage(...image(a)),
      clearKey: (a) => core.clearKey(a.key as number),
      setBrightness: (a) => core.setBrightness(a.level as number),
      keepAlive: () => core.keepAlive(),
    },
    read: (data) => core.parseInput(data).flatMap(akp05Events),
  };
}

function mirabox(model: DeviceModel, write: Sink): CoreDevice {
  const core = new MiraboxCore(model, write);
  return {
    open: () => {
      core.reset();
      core.init();
    },
    close: () => core.closeReports().forEach(write),
    calls: {
      sendImage: (a) => core.sendImage(...image(a), () => undefined),
      clearKey: (a) => core.clearKey(a.key as number),
      setBrightness: (a) => core.setBrightness(a.level as number),
      setSleep: (a) => core.setSleep(a.asleep as boolean),
    },
    read: (data) => keys(core.parseInput(data) ?? []),
  };
}

function canon(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .toSorted((a, b) => a.localeCompare(b))
      .map((k) => `${k}:${canon(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

class CoreReplay {
  private readonly log: Wire[] = [];
  private cursor = 0;
  private opened = false;
  private readonly device: CoreDevice;

  constructor(private readonly loaded: LoadedFixture) {
    const model = findModelById(loaded.fixture.model)!;
    const write = this.sink('write');
    if (model.protocol.startsWith('elgato-'))
      this.device = elgato(model, write, this.sink('feature'));
    else if (model.protocol === 'ajazz-akp05') this.device = akp05(model, write);
    else this.device = mirabox(model, write);
  }

  // The drivers drop every write while no device is open; so does this sink.
  private sink(op: 'write' | 'feature'): Sink {
    return (r) => {
      if (this.opened) this.log.push({ op, bytes: Uint8Array.from(r) });
    };
  }

  private fail(i: number, msg: string): never {
    throw new Error(`${this.loaded.file} step ${i}: ${msg}`);
  }

  private drained(i: number): void {
    const extra = this.log[this.cursor];
    if (extra) this.fail(i, `core produced an unexpected extra ${extra.op}`);
  }

  private open(): void {
    this.opened = true;
    this.device.open();
  }

  private call(i: number, step: Extract<FixtureStep, { op: 'call' }>): void {
    this.drained(i);
    if (step.call === 'open') this.open();
    else if (step.call !== 'close') this.device.calls[step.call]?.(step.args ?? {});
    else if (this.opened) {
      this.device.close();
      this.log.push({ op: 'close' });
      this.opened = false;
    }
  }

  private wire(i: number, step: Extract<FixtureStep, { op: 'write' | 'feature' | 'close' }>) {
    const entry = this.log[this.cursor++];
    if (!entry) this.fail(i, `expected a ${step.op}, core produced nothing`);
    if (entry.op !== step.op) this.fail(i, `expected ${step.op}, core did ${entry.op}`);
    if (step.op === 'close' || entry.op === 'close') return;
    const at = firstDiff(bytesOfHex(step.hex), entry.bytes);
    if (at >= 0) this.fail(i, `${step.op} differs at byte ${at}`);
  }

  run(): void {
    if (this.loaded.fixture.assumeOpen) {
      this.open();
      this.log.length = 0;
    }
    for (const [i, step] of this.loaded.fixture.steps.entries()) {
      if (step.op === 'call') this.call(i, step);
      else if (step.op === 'read') {
        const got = canon(this.device.read(bytesOfHex(step.hex)));
        if (got !== canon(step.expect))
          this.fail(i, `events ${got}, expected ${canon(step.expect)}`);
      } else if (step.op !== 'feature' || step.dir === 'out') this.wire(i, step);
      // Feature replies (dir 'in') answer serial/firmware reads, which the cores never make.
    }
    this.drained(this.loaded.fixture.steps.length);
  }
}

for (const loaded of await loadFixtures()) {
  test(`core matches ${loaded.file}`, () => new CoreReplay(loaded).run());
}

summaryExit();
