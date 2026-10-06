/** Versioned packet-fixture format shared by the capture probe (writer) and the replay
 *  test (reader), so the two cannot drift. Pure: no FFI, no I/O.
 *  Layout: ts/test/fixtures/packets/<model-id>/<case>.json, at most 64 KB each. */
import type { DeviceModel } from '../devices/driver.js';

export const FIXTURE_VERSION = 1;
export const FIXTURE_MAX_BYTES = 64 * 1024;

export interface FixtureInterface {
  usagePage: number;
  usage: number;
}

/** What a parsed input report must emit. Raw wire codes stay raw: key mapping is
 *  translator.ts's job, not the driver's. */
export type FixtureEvent =
  | { type: 'press' | 'release'; key: number }
  | { type: 'dial'; index: number; kind: 'rotate'; delta: number }
  | { type: 'dial'; index: number; kind: 'press'; state: 'down' | 'up' }
  | { type: 'touch'; kind: 'tap' | 'swipe'; x: number; y: number; endX?: number; endY?: number };

/** `call` drives the driver (name + args); `write`/`feature`/`close` are the wire
 *  traffic the previous call must have produced, in order; `read` feeds one input report
 *  and asserts the events it emits (`expect: []` = none); `feature` with dir `in` is a
 *  device reply queued for the next call that reads one. */
export type FixtureStep =
  | {
      op: 'call';
      call: string;
      args?: Record<string, unknown>;
      expectProps?: Record<string, string>;
    }
  | { op: 'write'; dir: 'out'; hex: string }
  | { op: 'feature'; dir: 'in' | 'out'; hex: string }
  | { op: 'read'; dir: 'in'; hex: string; expect: FixtureEvent[] }
  | { op: 'close' };

export interface PacketFixture {
  version: number;
  model: string;
  pid: string;
  firmware: string | null;
  interface: FixtureInterface | null;
  /** 'synthetic' (derived from documented protocol facts) or 'capture:<path>'. */
  source: string;
  /** Skip asserting the open() traffic: it is replayed first and discarded. */
  assumeOpen?: boolean;
  note?: string;
  /** Informational only; never asserted. */
  timing?: Record<string, number>;
  steps: FixtureStep[];
}

const HEX = /^(?:[0-9a-f]{2})*$/;
const PID = /^0x[0-9a-f]{4}$/;

export function hexOf(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function bytesOfHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function pidLabel(pid: number): string {
  return `0x${pid.toString(16).padStart(4, '0')}`;
}

/** An empty fixture for a capture: identity from the enumerated interface, no steps. The
 *  user (or a model-specific probe) appends the observed traffic. */
export function buildFixtureSkeleton(
  model: DeviceModel,
  pid: number,
  iface: FixtureInterface | null,
  source: string,
): PacketFixture {
  return {
    version: FIXTURE_VERSION,
    model: model.id,
    pid: pidLabel(pid),
    firmware: null,
    interface: iface,
    source,
    steps: [],
  };
}

export function serializeFixture(fixture: PacketFixture): string {
  return `${JSON.stringify(fixture, null, 2)}\n`;
}

function stepProblem(step: FixtureStep): string | null {
  if (step.op === 'call') return step.call ? null : 'call step without a call name';
  if (step.op === 'close') return null;
  if (!HEX.test(step.hex)) return `${step.op} hex is not lowercase even-length hex`;
  if (step.op === 'read' && !Array.isArray(step.expect)) return 'read step without expect[]';
  return null;
}

/** Structural problems of a parsed fixture (empty = fine). Byte semantics are the replay's. */
export function validateFixtureShape(fixture: PacketFixture, size: number): string[] {
  const errors: string[] = [];
  if (fixture.version !== FIXTURE_VERSION) errors.push(`version ${fixture.version} != 1`);
  if (!fixture.model) errors.push('missing model');
  if (!PID.test(fixture.pid)) errors.push(`pid '${fixture.pid}' is not lowercase 0x + 4 hex`);
  if (fixture.source !== 'synthetic' && !fixture.source.startsWith('capture:')) {
    errors.push(`source '${fixture.source}' is neither 'synthetic' nor 'capture:<path>'`);
  }
  if (size > FIXTURE_MAX_BYTES) errors.push(`${size} bytes exceeds ${FIXTURE_MAX_BYTES}`);
  fixture.steps.forEach((step, i) => {
    const problem = stepProblem(step);
    if (problem) errors.push(`step ${i}: ${problem}`);
  });
  return errors;
}
