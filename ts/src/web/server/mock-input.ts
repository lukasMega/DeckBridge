// Guard for POST /api/mock/* — simulated side-key, knob and touch-strip input for the
// mock driver (browser e2e). Checked against the dock's reported capabilities, so a
// test cannot drive input the physical device could never produce.
import { PLUS_TOUCH_HEIGHT, PLUS_TOUCH_WIDTH } from '../../shared/types.js';
import type { DockStatus, MockInput } from '../../shared/types.js';
import { isNonNegInt, nonNegIntError } from './types.js';
import type { DriverMode, ReqError } from './types.js';

/** A request before validation: `kind` comes from the route, the rest from the client. */
export type RawMockInput =
  | { kind: 'extraKey'; wireId: unknown }
  | { kind: 'dial'; event: unknown }
  | { kind: 'touch'; event: unknown };

type Checked = { input: MockInput } | ReqError;

const bad = (error: string): ReqError => ({ error, status: 400 });
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

function checkExtraKey(wireId: unknown, dock: DockStatus): Checked {
  if (!isNonNegInt(wireId)) return nonNegIntError('wireId');
  // Display-only extra keys (293S 6th column) have no switch to press.
  if (!dock.pressableExtraKeys?.includes(wireId)) {
    return bad(`${dock.modelName} has no pressable extra key ${wireId}`);
  }
  return { input: { kind: 'extraKey', wireId } };
}

function checkDial(event: unknown, dock: DockStatus): Checked {
  const count = dock.encoderCount ?? 0;
  if (count === 0) return bad(`${dock.modelName} has no knobs`);
  const e = (event ?? {}) as Record<string, unknown>;
  if (!isNonNegInt(e.index) || e.index >= count) {
    return bad(`index must be an integer 0..${count - 1}`);
  }
  if (e.kind === 'press' && (e.state === 'down' || e.state === 'up')) {
    return { input: { kind: 'dial', event: { index: e.index, kind: 'press', state: e.state } } };
  }
  if (e.kind === 'rotate' && isInt(e.delta) && e.delta !== 0) {
    return { input: { kind: 'dial', event: { index: e.index, kind: 'rotate', delta: e.delta } } };
  }
  return bad("event must be {kind:'press', state:'down'|'up'} or {kind:'rotate', delta}");
}

function checkTouch(event: unknown, dock: DockStatus): Checked {
  // Strip coordinates are Plus-sized unless the advertised profile says otherwise
  // (zoneForTouch applies the same fallback).
  const size =
    dock.touchStripSize ??
    (dock.encoderCount ? { width: PLUS_TOUCH_WIDTH, height: PLUS_TOUCH_HEIGHT } : undefined);
  if (!size) return bad(`${dock.modelName} has no touch strip`);
  const e = (event ?? {}) as Record<string, unknown>;
  const inX = (v: unknown): v is number => isNonNegInt(v) && v < size.width;
  const inY = (v: unknown): v is number => isNonNegInt(v) && v < size.height;
  if (e.type !== 'tap' && e.type !== 'hold' && e.type !== 'swipe') {
    return bad('type must be one of: tap, hold, swipe');
  }
  if (!inX(e.x) || !inY(e.y)) {
    return bad(`x/y must be inside the ${size.width}×${size.height} strip`);
  }
  if (e.type !== 'swipe')
    return { input: { kind: 'touch', event: { type: e.type, x: e.x, y: e.y } } };
  if (!inX(e.endX) || !inY(e.endY)) {
    return bad(`a swipe needs endX/endY inside the ${size.width}×${size.height} strip`);
  }
  return {
    input: { kind: 'touch', event: { type: 'swipe', x: e.x, y: e.y, endX: e.endX, endY: e.endY } },
  };
}

/** 404 outside mock mode (the routes do not exist for a real device), 400 for a
 *  malformed body or input the selected dock cannot produce. */
export function checkMockInput(
  raw: RawMockInput,
  dock: DockStatus | undefined,
  driverMode: DriverMode,
): Checked {
  if (driverMode !== 'mock')
    return { error: 'input simulation only exists in mock mode', status: 404 };
  if (!dock) return { error: 'no mock device connected', status: 409 };
  if (raw.kind === 'extraKey') return checkExtraKey(raw.wireId, dock);
  if (raw.kind === 'dial') return checkDial(raw.event, dock);
  return checkTouch(raw.event, dock);
}
