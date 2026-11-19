import assert from 'tjs:assert';
import { WideKeyStats, type StatsSampler } from '../src/main/wide-key-stats.js';
import { ULANZI_D200_MODEL } from '../src/devices/ulanzi/ulanzi-d200.js';
import { DEFAULT_MODEL } from '../src/devices/registry.js';
import type { DeviceModel, DockDriver } from '../src/devices/driver.js';
import type { DockPrefs } from '../src/infra/dock-prefs.js';
import type { PluginValue } from '../src/plugin/plugin-host.js';
import { resolveWideKey } from '../src/shared/wide-key.js';
import type { WideKeyConfig } from '../src/shared/types.js';
import type { HostStats } from '../src/shared/host-stats.js';
import { currentLogLevel, setLogLevel, setWebUILog } from '../src/shared/logger.js';
import { test, summaryExit } from './helpers/harness.js';

console.log('\nwide-key-stats');

class Sampler implements StatsSampler {
  readonly listeners = new Set<(s: HostStats) => void>();
  acquire(l: (s: HostStats) => void): void {
    this.listeners.add(l);
  }
  release(l: (s: HostStats) => void): void {
    this.listeners.delete(l);
  }
  emit(s: HostStats): void {
    for (const l of this.listeners) l(s);
  }
}

class Driver {
  readonly calls: string[] = [];
  setHostStats(cpu: number, mem: number, gpu: number): void {
    this.calls.push(`${cpu}/${mem}/${gpu}`);
  }
}

interface PluginCall {
  file: string | undefined;
  arg: string | undefined;
  interval: number | undefined;
}

function rig(
  initial: Partial<WideKeyConfig> = { content: 'stats' },
  model: DeviceModel = ULANZI_D200_MODEL,
) {
  let stored: Partial<WideKeyConfig> | undefined = initial;
  let driver: Driver | null = new Driver();
  const sampler = new Sampler();
  const pluginCalls: PluginCall[] = [];
  let reply: PluginValue = { value: undefined, status: 'pending' };
  let onUpdate: (() => void) | undefined;
  const stats = new WideKeyStats({
    driver: () => driver as unknown as DockDriver | null,
    prefs: () => ({ wideKey: () => resolveWideKey(stored) }) as unknown as DockPrefs,
    model: () => model,
    sampler,
    plugin: (file, arg, interval, update) => {
      pluginCalls.push({ file, arg, interval });
      onUpdate = update;
      return reply;
    },
  });
  return {
    stats,
    sampler,
    pluginCalls,
    get driver() {
      return driver!;
    },
    setDriver: (d: Driver | null) => (driver = d),
    store: (s: Partial<WideKeyConfig> | undefined) => (stored = s),
    reply: (r: PluginValue) => (reply = r),
    updated: () => onUpdate?.(),
  };
}

const ok = (value: string | null): PluginValue => ({ value, status: 'ok' });

/** Warnings logged while `run` executes. */
function warnings(run: () => void): string[] {
  const before = currentLogLevel();
  const out: string[] = [];
  setLogLevel('warn');
  setWebUILog((level, _component, message) => {
    if (level === 'warn') out.push(message);
  });
  try {
    run();
  } finally {
    setLogLevel(before === 'silent' ? 'info' : before);
    setWebUILog(() => undefined);
  }
  return out;
}

test('subscribes only while the stats content shows, and zeroes the driver on leaving', () => {
  const r = rig({ content: 'clock' });
  r.stats.sync();
  assert.equal(r.sampler.listeners.size, 0);
  r.store({ content: 'stats' });
  r.stats.sync();
  assert.equal(r.sampler.listeners.size, 1);
  r.sampler.emit({ cpu: 20, mem: 30, gpu: 0 });
  r.store({ content: 'dial' });
  r.stats.sync();
  assert.equal(r.sampler.listeners.size, 0);
  assert.deepEqual(r.driver.calls, ['20/30/0', '0/0/0']);
  r.stats.sync();
  assert.deepEqual(r.driver.calls, ['20/30/0', '0/0/0'], 'nothing more once released');
});

test('current() mirrors what the driver was last sent, and is empty out of stats mode', () => {
  const r = rig({ content: 'clock' });
  r.stats.sync();
  assert.equal(r.stats.current(), undefined, 'not subscribed');
  r.store({ content: 'stats' });
  r.stats.sync();
  assert.deepEqual(r.stats.current(), { cpu: 0, mem: 0, gpu: 0 }, 'zeros before a first sample');
  r.sampler.emit({ cpu: 20, mem: 30, gpu: 0 });
  assert.deepEqual(r.stats.current(), { cpu: 20, mem: 30, gpu: 0 });
  r.stats.current()!.cpu = 99;
  assert.equal(r.stats.current()!.cpu, 20, 'a copy: the caller cannot edit the sent figures');
  r.store({ content: 'stats', statsPlugin: 'sys.js' });
  r.reply(ok('{"cpu":90,"mem":80,"gpu":70}'));
  r.stats.sync();
  assert.deepEqual(r.stats.current(), { cpu: 90, mem: 80, gpu: 70 }, 'a plugin override shows');
  const calls = r.pluginCalls.length;
  r.stats.current();
  assert.equal(r.pluginCalls.length, calls, 'reading never asks the plugin');
  r.store({ content: 'dial' });
  r.stats.sync();
  assert.equal(r.stats.current(), undefined, 'released');
  const gone = rig();
  gone.setDriver(null);
  gone.stats.sync();
  assert.equal(gone.stats.current(), undefined, 'no device, no figures');
});

test('a model with no info window, or a driver without setHostStats, never subscribes', () => {
  const none = rig({ content: 'stats' }, DEFAULT_MODEL);
  none.stats.sync();
  assert.equal(none.sampler.listeners.size, 0);
  const bare = rig();
  bare.setDriver({} as Driver);
  bare.stats.sync();
  assert.equal(bare.sampler.listeners.size, 0);
  const gone = rig();
  gone.setDriver(null);
  gone.stats.sync();
  assert.equal(gone.sampler.listeners.size, 0);
});

test('a detached driver releases the sampler; a new one gets the figures afresh', () => {
  const r = rig();
  r.stats.sync();
  r.sampler.emit({ cpu: 5, mem: 6, gpu: 0 });
  r.setDriver(null);
  r.stats.sync();
  assert.equal(r.sampler.listeners.size, 0);
  const fresh = new Driver();
  r.setDriver(fresh);
  r.stats.sync();
  r.sampler.emit({ cpu: 5, mem: 6, gpu: 0 });
  assert.deepEqual(fresh.calls, ['5/6/0'], 'the same figures still reach a replugged driver');
});

test('built-in figures reach the driver once per change', () => {
  const r = rig();
  r.stats.sync();
  r.sampler.emit({ cpu: 1, mem: 2, gpu: 0 });
  r.sampler.emit({ cpu: 1, mem: 2, gpu: 0 });
  r.sampler.emit({ cpu: 3, mem: 2, gpu: 0 });
  assert.deepEqual(r.driver.calls, ['1/2/0', '3/2/0']);
  assert.deepEqual(r.pluginCalls, [], 'no plugin is asked without statsPlugin');
});

test('a stats plugin overrides the built-in figures, GPU included', () => {
  const r = rig({ content: 'stats', statsPlugin: 'sys.js' });
  r.reply(ok('{"cpu":90,"mem":80,"gpu":70}'));
  r.stats.sync();
  r.sampler.emit({ cpu: 1, mem: 2, gpu: 0 });
  assert.deepEqual(r.driver.calls.at(-1), '90/80/70');
  assert.deepEqual(r.pluginCalls.at(-1), { file: 'sys.js', arg: undefined, interval: undefined });
});

test('a plugin that gives only some keys keeps the built-in value for the rest', () => {
  const r = rig({ content: 'stats', statsPlugin: 'gpu.js' });
  r.reply(ok('{"gpu":42}'));
  r.stats.sync();
  r.sampler.emit({ cpu: 11, mem: 22, gpu: 0 });
  assert.deepEqual(r.driver.calls.at(-1), '11/22/42');
});

test('a plugin update repaints at once, not at the next sample', () => {
  const r = rig({ content: 'stats', statsPlugin: 'sys.js' });
  r.stats.sync();
  r.sampler.emit({ cpu: 1, mem: 2, gpu: 0 });
  assert.deepEqual(r.driver.calls, ['1/2/0'], 'no reply yet: built-in');
  r.reply(ok('{"cpu":55,"mem":66,"gpu":77}'));
  r.updated();
  assert.deepEqual(r.driver.calls, ['1/2/0', '55/66/77']);
});

test('no reply, an error or a null reply fall back to the built-in figures', () => {
  const r = rig({ content: 'stats', statsPlugin: 'sys.js' });
  r.stats.sync();
  r.sampler.emit({ cpu: 4, mem: 5, gpu: 0 });
  r.reply({ value: undefined, status: 'err' });
  r.sampler.emit({ cpu: 4, mem: 6, gpu: 0 });
  r.reply(ok(null));
  r.sampler.emit({ cpu: 4, mem: 7, gpu: 0 });
  assert.deepEqual(r.driver.calls, ['4/5/0', '4/6/0', '4/7/0']);
});

test('bad plugin JSON uses the built-in figures and warns once until it recovers', () => {
  const r = rig({ content: 'stats', statsPlugin: 'sys.js' });
  r.stats.sync();
  const logged = warnings(() => {
    r.reply(ok('not json'));
    r.sampler.emit({ cpu: 8, mem: 9, gpu: 0 });
    r.sampler.emit({ cpu: 8, mem: 10, gpu: 0 });
    r.reply(ok('{"cpu":"high"}'));
    r.sampler.emit({ cpu: 8, mem: 11, gpu: 0 });
  });
  assert.deepEqual(r.driver.calls, ['8/9/0', '8/10/0', '8/11/0'], 'built-in the whole time');
  assert.equal(logged.length, 1, 'warned once');
  assert.ok(logged[0]!.includes('sys.js'));
  r.reply(ok('{"cpu":1}'));
  r.sampler.emit({ cpu: 8, mem: 12, gpu: 0 });
  assert.equal(r.driver.calls.at(-1), '1/12/0', 'a good reply is used again');
  const again = warnings(() => {
    r.reply(ok('oops'));
    r.sampler.emit({ cpu: 8, mem: 13, gpu: 0 });
  });
  assert.equal(again.length, 1, 'warns again after a recovery');
});

test('removing the plugin goes back to the built-in figures without a sample', () => {
  const r = rig({ content: 'stats', statsPlugin: 'sys.js' });
  r.reply(ok('{"cpu":90,"mem":80,"gpu":70}'));
  r.stats.sync();
  r.sampler.emit({ cpu: 1, mem: 2, gpu: 0 });
  r.store({ content: 'stats' });
  r.stats.sync();
  assert.deepEqual(r.driver.calls, ['90/80/70', '1/2/0']);
});

test('a plugin update after the window left stats mode sends nothing', () => {
  const r = rig({ content: 'stats', statsPlugin: 'sys.js' });
  r.stats.sync();
  r.store({ content: 'clock' });
  r.stats.sync();
  const before = r.driver.calls.length;
  r.reply(ok('{"cpu":1,"mem":2,"gpu":3}'));
  r.updated();
  assert.equal(r.driver.calls.length, before);
});

summaryExit();
