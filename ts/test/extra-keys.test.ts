import assert from 'tjs:assert';
import { EventEmitter } from 'node:events';
import {
  ExtraKeyWidgets,
  composeWidgetBmp,
  parseLatLon,
  renderWidgetLines,
} from '../src/extra-keys.js';
import { isExtraKeyConfig } from '../src/types.js';
import { MIRABOX_293S_MODEL } from '../src/devices/mirabox/mirabox-293s.js';
import type { DeviceImageSpec } from '../src/devices/driver.js';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${(e as Error).message}`);
    failed++;
  }
}

// ── renderWidgetLines ─────────────────────────────────────────────────────────

console.log('\nrenderWidgetLines');

// 2026-07-15 09:05 was a Wednesday.
const NOW = new Date(2026, 6, 15, 9, 5);

await test('clock → zero-padded 24h HH:MM, big font', () => {
  assert.deepEqual(renderWidgetLines({ widget: 'clock' }, { now: NOW }), [
    { text: '09:05', big: true },
  ]);
});

await test('date → weekday / day / month lines', () => {
  assert.deepEqual(renderWidgetLines({ widget: 'date' }, { now: NOW }), [
    { text: 'Wed', big: false },
    { text: '15', big: true },
    { text: 'Jul', big: false },
  ]);
});

await test('text: single short line → big font', () => {
  assert.deepEqual(renderWidgetLines({ widget: 'text', param: 'CO2' }, { now: NOW }), [
    { text: 'CO2', big: true },
  ]);
});

await test('text: multi-line → small font, capped at 4 lines', () => {
  const lines = renderWidgetLines({ widget: 'text', param: 'a\nb\nc\nd\ne' }, { now: NOW });
  assert.deepEqual(
    lines,
    ['a', 'b', 'c', 'd'].map((text) => ({ text, big: false })),
  );
});

await test('text: empty/missing param → null (clear)', () => {
  assert.equal(renderWidgetLines({ widget: 'text' }, { now: NOW }), null);
  assert.equal(renderWidgetLines({ widget: 'text', param: '\n' }, { now: NOW }), null);
});

await test('weather: no value yet → "--", value → rounded with °', () => {
  assert.deepEqual(renderWidgetLines({ widget: 'weather' }, { now: NOW }), [
    { text: '--', big: true },
  ]);
  assert.deepEqual(renderWidgetLines({ widget: 'weather' }, { now: NOW, weatherTemp: 21.6 }), [
    { text: '22\xb0', big: true },
  ]);
});

await test('command: not run yet → placeholder, stdout → lines, empty → null', () => {
  assert.deepEqual(renderWidgetLines({ widget: 'command', param: 'x' }, { now: NOW }), [
    { text: '…', big: true },
  ]);
  assert.deepEqual(
    renderWidgetLines({ widget: 'command', param: 'x' }, { now: NOW, commandOut: 'OK\n' }),
    [{ text: 'OK', big: true }],
  );
  assert.deepEqual(
    renderWidgetLines(
      { widget: 'command', param: 'x' },
      { now: NOW, commandOut: 'a\nbb\ncc\ndd\nee' },
    ),
    ['a', 'bb', 'cc', 'dd'].map((text) => ({ text, big: false })),
  );
  assert.equal(
    renderWidgetLines({ widget: 'command', param: 'x' }, { now: NOW, commandOut: '  \n' }),
    null,
  );
});

await test("'none' → null (clear)", () => {
  assert.equal(renderWidgetLines({ widget: 'none' }, { now: NOW }), null);
});

await test('plugin: no value yet → placeholder; value → lines; null → clear; err/disabled → ERR', () => {
  // Not fetched yet (status pending, value undefined) → '…' placeholder.
  assert.deepEqual(
    renderWidgetLines({ widget: 'plugin', param: 'p.js' }, { now: NOW, pluginStatus: 'pending' }),
    [{ text: '…', big: true }],
  );
  // A string value → textLines() (single short line → big font).
  assert.deepEqual(
    renderWidgetLines(
      { widget: 'plugin', param: 'p.js' },
      { now: NOW, pluginStatus: 'ok', pluginValue: 'OK' },
    ),
    [{ text: 'OK', big: true }],
  );
  // null value → clear the key.
  assert.equal(
    renderWidgetLines(
      { widget: 'plugin', param: 'p.js' },
      { now: NOW, pluginStatus: 'ok', pluginValue: null },
    ),
    null,
  );
  // err / disabled → 'ERR'.
  assert.deepEqual(
    renderWidgetLines({ widget: 'plugin', param: 'p.js' }, { now: NOW, pluginStatus: 'err' }),
    [{ text: 'ERR', big: true }],
  );
  assert.deepEqual(
    renderWidgetLines({ widget: 'plugin', param: 'p.js' }, { now: NOW, pluginStatus: 'disabled' }),
    [{ text: 'ERR', big: true }],
  );
});

// ── parseLatLon ───────────────────────────────────────────────────────────────

console.log('\nparseLatLon');

await test('valid "lat,lon" (with spaces) parses', () => {
  assert.deepEqual(parseLatLon('50.08, 14.43'), [50.08, 14.43]);
});

await test('garbage / out-of-range / missing → null', () => {
  assert.equal(parseLatLon(undefined), null);
  assert.equal(parseLatLon('Prague'), null);
  assert.equal(parseLatLon('50.08'), null);
  assert.equal(parseLatLon('91,0'), null);
  assert.equal(parseLatLon('0,181'), null);
});

// ── composeWidgetBmp ──────────────────────────────────────────────────────────

console.log('\ncomposeWidgetBmp');

const SIZE = 85;

await test('produces a well-formed 24-bit BMP of the key size', () => {
  const bmp = composeWidgetBmp([{ text: '8', big: true }], SIZE);
  const buf = Buffer.from(bmp);
  assert.equal(buf.toString('ascii', 0, 2), 'BM');
  assert.equal(buf.readUInt32LE(2), buf.length, 'declared file size matches');
  assert.equal(buf.readUInt32LE(18), SIZE, 'width');
  assert.equal(buf.readUInt32LE(22), SIZE, 'height');
  assert.equal(buf.readUInt16LE(28), 24, 'bpp');
});

/** Count foreground pixels, honouring the 4-byte BMP row padding. */
function countFg(buf: ReturnType<typeof Buffer.from>): number {
  const rowSize = Math.ceil((SIZE * 3) / 4) * 4;
  let fg = 0;
  for (let row = 0; row < SIZE; row++) {
    for (let x = 0; x < SIZE; x++) {
      const o = 54 + row * rowSize + x * 3;
      if (buf[o] === 0xec && buf[o + 1] === 0xe8 && buf[o + 2] === 0xe8) fg++;
    }
  }
  return fg;
}

await test('background + glyph foreground pixels present', () => {
  const bmp = composeWidgetBmp([{ text: '8', big: true }], SIZE);
  const buf = Buffer.from(bmp);
  const rowSize = Math.ceil((SIZE * 3) / 4) * 4;
  // (0,0) top-left = last stored row (bottom-up) → background #101014 (BGR).
  const corner = 54 + (SIZE - 1) * rowSize;
  assert.deepEqual([...buf.subarray(corner, corner + 3)], [0x14, 0x10, 0x10]);
  const fg = countFg(buf);
  assert.ok(fg > 50, `glyph pixels rendered (got ${fg})`);
});

await test('blank text renders pure background', () => {
  const bmp = composeWidgetBmp([{ text: ' ', big: true }], SIZE);
  assert.equal(countFg(Buffer.from(bmp)), 0);
});

// ── ExtraKeyWidgets ───────────────────────────────────────────────────────────

class FakeDriver extends EventEmitter {
  model = MIRABOX_293S_MODEL;
  splashed: Array<{ keyIndex: number; bytes: Uint8Array; spec: DeviceImageSpec }> = [];
  cleared: number[] = [];
  open(): Promise<void> {
    return Promise.resolve();
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
  sendImage(): void {}
  setBrightness(): void {}
  clearKey(keyIndex: number): void {
    this.cleared.push(keyIndex);
  }
  sendSplashImage(keyIndex: number, bytes: Uint8Array, spec: DeviceImageSpec): void {
    this.splashed.push({ keyIndex, bytes, spec });
  }
}

const tick = (w: ExtraKeyWidgets): void => (w as unknown as { tick(): void }).tick();

console.log('\nExtraKeyWidgets');

await test('start() paints configured widgets, clears the rest', () => {
  const d = new FakeDriver();
  const w = new ExtraKeyWidgets(d, (wireId) =>
    wireId === 17 ? { widget: 'text', param: 'Hi' } : undefined,
  );
  w.start();
  w.stop();
  assert.deepEqual(d.cleared, [16, 18]);
  assert.equal(d.splashed.length, 1);
  assert.equal(d.splashed[0]!.keyIndex, 17);
  assert.equal(Buffer.from(d.splashed[0]!.bytes).toString('ascii', 0, 2), 'BM');
});

await test('splash spec uses the 293S splash orientation override (rotate 270)', () => {
  const d = new FakeDriver();
  const w = new ExtraKeyWidgets(d, () => ({ widget: 'text', param: 'x' }));
  w.start();
  w.stop();
  assert.equal(d.splashed[0]!.spec.rotate, 270);
});

await test('unchanged content is not repainted; repaint() forces it', () => {
  const d = new FakeDriver();
  const w = new ExtraKeyWidgets(d, (wireId) =>
    wireId === 16 ? { widget: 'text', param: 'static' } : undefined,
  );
  w.start();
  tick(w);
  tick(w);
  assert.equal(d.splashed.length, 1, 'static content painted once');
  assert.deepEqual(d.cleared, [17, 18], 'unassigned cleared once');
  w.repaint();
  w.stop();
  assert.equal(d.splashed.length, 2, 'repaint() forces a fresh paint');
});

await test('config change to none clears the key on the next tick', () => {
  const d = new FakeDriver();
  let cfg: { widget: 'text'; param: string } | undefined = { widget: 'text', param: 'x' };
  const w = new ExtraKeyWidgets(d, (wireId) => (wireId === 16 ? cfg : undefined));
  w.start();
  cfg = undefined;
  tick(w);
  w.stop();
  assert.deepEqual(d.cleared, [17, 18, 16]);
});

await test('model without extraKeys → no device I/O, no timer', () => {
  const d = new FakeDriver();
  const bare = { ...MIRABOX_293S_MODEL, keyMap: { ...MIRABOX_293S_MODEL.keyMap } };
  delete (bare.keyMap as { extraKeys?: readonly number[] }).extraKeys;
  d.model = bare;
  const w = new ExtraKeyWidgets(d, () => ({ widget: 'clock' }));
  w.start();
  w.stop();
  assert.equal(d.cleared.length, 0);
  assert.equal(d.splashed.length, 0);
});

// ── isExtraKeyConfig (migration guard) ────────────────────────────────────────

console.log('\nisExtraKeyConfig');

await test('accepts widget entries, rejects legacy action entries', () => {
  assert.ok(isExtraKeyConfig({ widget: 'clock' }));
  assert.ok(isExtraKeyConfig({ widget: 'text', param: 'hi' }));
  assert.ok(isExtraKeyConfig({ widget: 'command', param: 'date +%H:%M' }));
  assert.ok(!isExtraKeyConfig({ action: 'brightness-up' }), 'legacy shape rejected');
  assert.ok(!isExtraKeyConfig({ widget: 'shell' }), 'unknown widget rejected');
  assert.ok(!isExtraKeyConfig({ widget: 'text', param: 'x'.repeat(129) }), 'param cap');
});

await test('accepts plugin widget with pluginArg, rejects over-long pluginArg', () => {
  assert.ok(isExtraKeyConfig({ widget: 'plugin', param: 'stocks.js' }));
  assert.ok(isExtraKeyConfig({ widget: 'plugin', param: 'stocks.js', pluginArg: 'AAPL' }));
  assert.ok(
    isExtraKeyConfig({
      widget: 'plugin',
      param: 'stocks.js',
      pluginArg: 'AAPL',
      intervalMs: 30_000,
    }),
  );
  assert.ok(
    !isExtraKeyConfig({ widget: 'plugin', param: 'p.js', pluginArg: 'x'.repeat(129) }),
    'pluginArg cap',
  );
  assert.ok(!isExtraKeyConfig({ widget: 'plugin', pluginArg: 5 }), 'pluginArg must be a string');
});

await test('accepts command widget intervalMs/timeoutMs in range, rejects out of range', () => {
  assert.ok(
    isExtraKeyConfig({ widget: 'command', param: 'date', intervalMs: 1000, timeoutMs: 5000 }),
  );
  assert.ok(!isExtraKeyConfig({ widget: 'command', param: 'date', intervalMs: 999 }), 'below min');
  assert.ok(
    !isExtraKeyConfig({ widget: 'command', param: 'date', intervalMs: 3600_001 }),
    'above max',
  );
  assert.ok(
    !isExtraKeyConfig({ widget: 'command', param: 'date', timeoutMs: 60_001 }),
    'timeout above max',
  );
});

// ── ExtraKeyWidgets.forceRun ("Run now") ───────────────────────────────────────

console.log('\nExtraKeyWidgets.forceRun');

await test('forceRun executes the command immediately and repaints on completion', async () => {
  const d = new FakeDriver();
  const state: { cfg?: { widget: 'command'; param: string } } = {};
  const w = new ExtraKeyWidgets(d, (wireId) => (wireId === 16 ? state.cfg : undefined));
  w.start(); // no command configured yet — nothing spawned
  state.cfg = { widget: 'command', param: 'echo forcerun-test-marker' };
  const before = d.splashed.length;
  w.forceRun(16);
  for (let i = 0; i < 100 && d.splashed.length === before; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  w.stop();
  assert.ok(d.splashed.length > before, 'repaint triggered after forced run');
  assert.equal(d.splashed.at(-1)!.keyIndex, 16);
});

await test('forceRun is a no-op for a non-command (or unconfigured) key', () => {
  const d = new FakeDriver();
  const w = new ExtraKeyWidgets(d, (wireId) =>
    wireId === 16 ? { widget: 'text', param: 'x' } : undefined,
  );
  w.start();
  const before = d.splashed.length;
  w.forceRun(16); // configured, but not 'command'
  w.forceRun(17); // unconfigured
  w.stop();
  assert.equal(d.splashed.length, before, 'no repaint scheduled');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) tjs.exit(1);
