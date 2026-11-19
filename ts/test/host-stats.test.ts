import assert from 'tjs:assert';
import {
  HOST_STATS_INTERVAL_MS,
  HostStatsSampler,
  type HostStatsSeams,
  type StatsChild,
} from '../src/infra/host-stats.js';
import {
  cpuPercent,
  parseMeminfo,
  parseProcStat,
  parseTopCpu,
  parseTopMem,
  parseTypeperfRow,
} from '../src/infra/host-stats-parse.js';
import { applyPluginStats, clampPercent } from '../src/shared/host-stats.js';
import type { HostStats } from '../src/shared/host-stats.js';
import { currentLogLevel, setLogLevel, setWebUILog } from '../src/shared/logger.js';
import { test, testAsync, summaryExit } from './helpers/harness.js';

console.log('\nhost-stats: parsers');

// Real `top -l 2 -s 1 -n 0` output from macOS 27 (two samples; a process list is off).
const TOP_OUTPUT = `Processes: 690 total, 6 running, 684 sleeping, 4160 threads
2026/11/18 14:50:44
Load Avg: 5.07, 4.96, 6.03
CPU usage: 46.0% user, 17.0% sys, 37.0% idle
SharedLibs: 504M resident, 118M data, 99M linkedit.
MemRegions: 177523 total, 5276M resident, 132M private, 1549M shared.
PhysMem: 15G used (2240M wired, 3810M compressor), 70M unused.
VM: 319T vsize, 57G framework vsize, 7849630(0) swapins, 8990881(0) swapouts.
Networks: packets: 78038024/55G in, 46720817/18G out.
Disks: 43156490/886G read, 24397905/1031G written.


Processes: 691 total, 5 running, 686 sleeping, 4163 threads
2026/11/18 14:50:45
Load Avg: 5.07, 4.96, 6.03
CPU usage: 42.84% user, 6.5% sys, 51.10% idle
SharedLibs: 504M resident, 118M data, 99M linkedit.
MemRegions: 37 total, 4064K resident, 132M private, 1549M shared.
PhysMem: 15G used (2134M wired, 3809M compressor), 106M unused.
VM: 319T vsize, 57G framework vsize, 7849630(0) swapins, 8990881(0) swapouts.
Networks: packets: 78038073/55G in, 46720862/18G out.
Disks: 43156553/886G read, 24398226/1031G written.
`;

// Linux: the aggregate line of /proc/stat (guest columns last) and a 5.x /proc/meminfo.
const STAT_1 =
  'cpu  1000 0 500 8000 500 0 0 0 0 0\ncpu0 500 0 250 4000 250 0 0 0 0 0\nintr 1 2 3\n';
const STAT_2 = 'cpu  1600 0 800 8600 600 0 0 0 999 0\ncpu0 800 0 400 4300 300 0 0 0 0 0\n';
const MEMINFO = `MemTotal:       16314568 kB
MemFree:         1030436 kB
MemAvailable:    9421576 kB
Buffers:          503156 kB
Cached:          7425380 kB
SwapCached:        10092 kB
`;

// Windows: typeperf -si 2 "\\Processor(_Total)\\% Processor Time" "\\Memory\\% Committed Bytes In Use"
const TYPEPERF_HEADER =
  '"(PDH-CSV 4.0)","\\\\DESKTOP-ABC\\Processor(_Total)\\% Processor Time","\\\\DESKTOP-ABC\\Memory\\% Committed Bytes In Use"';
const TYPEPERF_ROW_1 = '"11/18/2026 10:00:02.123","12.345678","45.678901"';
const TYPEPERF_ROW_2 = '"11/18/2026 10:00:04.126","7.000000","46.700001"';
const TYPEPERF_OUTPUT = `\r\n${TYPEPERF_HEADER}\r\n${TYPEPERF_ROW_1}\r\n${TYPEPERF_ROW_2}\r\n`;

test('proc/stat: busy share between two reads, guest columns not double counted', () => {
  const a = parseProcStat(STAT_1)!;
  const b = parseProcStat(STAT_2)!;
  assert.deepEqual(a, { busy: 1500, total: 10000 });
  assert.deepEqual(b, { busy: 2400, total: 11600 }, 'guest 999 is already inside user');
  assert.equal(cpuPercent(a, b), 56); // 900 / 1600 = 56.25
  assert.equal(cpuPercent(b, b), 0, 'no ticks passed');
  assert.equal(parseProcStat('intr 1 2 3\n'), null);
  assert.equal(parseProcStat('cpu  1 2 x 4\n'), null);
});

test('meminfo: used share from MemAvailable, with the old-kernel fallback', () => {
  assert.equal(parseMeminfo(MEMINFO), 42); // (16314568 - 9421576) / 16314568
  const old = MEMINFO.replace(/^MemAvailable:.*\n/m, '');
  assert.equal(parseMeminfo(old), 45); // available = free + buffers + cached
  assert.equal(parseMeminfo('MemFree: 1 kB\n'), null);
  assert.equal(parseMeminfo('MemTotal: 100 kB\n'), null, 'nothing to subtract');
});

test('macOS top: CPU is user + sys, memory is used over used + unused', () => {
  const lines = TOP_OUTPUT.split('\n');
  const cpu = lines.filter((l) => l.startsWith('CPU usage:')).map(parseTopCpu);
  const mem = lines.filter((l) => l.startsWith('PhysMem:')).map(parseTopMem);
  assert.deepEqual(cpu, [63, 49]);
  assert.deepEqual(mem, [100, 99]); // 15G / (15G + 70M), 15G / (15G + 106M)
  assert.equal(
    parseTopMem('PhysMem: 9873M used (1500M wired, 100M compressor), 6511M unused.'),
    60,
  );
  assert.equal(parseTopCpu('CPU usage: 42,84% user, 6,5% sys, 51,10% idle'), 49, 'decimal comma');
  assert.equal(parseTopCpu('CPU usage: nonsense'), null);
  assert.equal(parseTopMem('PhysMem: lots'), null);
});

test('Windows typeperf: data rows parse, header and blank cells do not', () => {
  assert.deepEqual(parseTypeperfRow(TYPEPERF_ROW_1), { cpu: 12, mem: 46 });
  assert.deepEqual(parseTypeperfRow(TYPEPERF_ROW_2), { cpu: 7, mem: 47 });
  assert.deepEqual(parseTypeperfRow('"11/18/2026 10:00:02.123","12,5","45,6"'), {
    cpu: 13,
    mem: 46,
  });
  assert.equal(parseTypeperfRow(TYPEPERF_HEADER), null);
  assert.equal(
    parseTypeperfRow('"11/18/2026 10:00:02.123"," ","45.6"'),
    null,
    'unreadable counter',
  );
  assert.equal(parseTypeperfRow('Exiting, please wait...'), null);
  assert.equal(parseTypeperfRow(''), null);
});

test('clampPercent rounds into 0-100 and maps junk to 0', () => {
  assert.equal(clampPercent(49.5), 50);
  assert.equal(clampPercent(-3), 0);
  assert.equal(clampPercent(101), 100);
  assert.equal(clampPercent(Number.NaN), 0);
  assert.equal(clampPercent(Number.POSITIVE_INFINITY), 0);
});

test('applyPluginStats: given keys replace the built-in ones, omitted keys keep them', () => {
  const builtin: HostStats = { cpu: 10, mem: 20, gpu: 0 };
  assert.deepEqual(applyPluginStats('{"cpu":12,"mem":34,"gpu":56}', builtin), {
    cpu: 12,
    mem: 34,
    gpu: 56,
  });
  assert.deepEqual(applyPluginStats('{"gpu":77}', builtin), { cpu: 10, mem: 20, gpu: 77 });
  assert.deepEqual(applyPluginStats('{"cpu":150.4,"mem":-5}', builtin), {
    cpu: 100,
    mem: 0,
    gpu: 0,
  });
  for (const bad of ['', 'cpu=1', '[1,2,3]', 'null', '{}', '{"cpu":"12"}', '{"cpu":null}']) {
    assert.equal(applyPluginStats(bad, builtin), null, bad);
  }
});

console.log('\nhost-stats: sampler');

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 5));
const encoder = new TextEncoder();

/** A child whose stdout the test writes; kill() ends the stream like a real exit. */
class FakeChild implements StatsChild {
  readonly kills: string[] = [];
  readonly stdout: ReadableStream<Uint8Array>;
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  private readonly exit = Promise.withResolvers<{ exit_status: number }>();

  constructor() {
    this.stdout = new ReadableStream<Uint8Array>({
      start: (c) => {
        this.controller = c;
      },
    });
  }
  wait(): Promise<{ exit_status: number }> {
    return this.exit.promise;
  }
  kill(signal?: string): void {
    this.kills.push(signal ?? '');
    this.controller.close();
    this.exit.resolve({ exit_status: 0 });
  }
  write(text: string): void {
    this.controller.enqueue(encoder.encode(text));
  }
  die(status: number): void {
    this.exit.resolve({ exit_status: status });
  }
}

class Rig {
  readonly spawned: Array<{ argv: string[]; child: FakeChild }> = [];
  readonly reads: string[] = [];
  files = new Map<string, string[]>(); // path -> queue of contents, last one repeats
  tick: (() => void) | undefined;
  timers = 0;
  stoppedTimers = 0;
  spawnError: Error | undefined;
  readonly sampler: HostStatsSampler;

  constructor(platform: string) {
    const seams: HostStatsSeams = {
      platform: () => platform,
      readText: (path) => {
        this.reads.push(path);
        const queue = this.files.get(path);
        if (!queue) return Promise.reject(new Error(`ENOENT ${path}`));
        return Promise.resolve(queue.length > 1 ? queue.shift()! : queue[0]!);
      },
      spawn: (argv) => {
        if (this.spawnError) throw this.spawnError;
        const child = new FakeChild();
        this.spawned.push({ argv, child });
        return child;
      },
      every: (fn, ms) => {
        assert.equal(ms, HOST_STATS_INTERVAL_MS);
        this.timers++;
        this.tick = fn;
        return () => {
          this.stoppedTimers++;
          this.tick = undefined;
        };
      },
    };
    this.sampler = new HostStatsSampler(seams);
  }

  /** Run the sampler's timer once and let async work settle. */
  async fire(): Promise<void> {
    this.tick?.();
    await flush();
  }
}

/** Warnings logged while `run` executes. */
async function warnings(run: () => Promise<void>): Promise<string[]> {
  const before = currentLogLevel();
  const out: string[] = [];
  setLogLevel('warn');
  setWebUILog((level, _component, message) => {
    if (level === 'warn') out.push(message);
  });
  try {
    await run();
  } finally {
    setLogLevel(before === 'silent' ? 'info' : before);
    setWebUILog(() => undefined);
  }
  return out;
}

const seen = (): { got: HostStats[]; listener: (s: HostStats) => void } => {
  const got: HostStats[] = [];
  return { got, listener: (s) => got.push(s) };
};

await testAsync('Linux: baseline read, CPU from the delta, memory from meminfo', async () => {
  const rig = new Rig('Linux');
  rig.files.set('/proc/stat', [STAT_1, STAT_2]);
  rig.files.set('/proc/meminfo', [MEMINFO]);
  const { got, listener } = seen();
  rig.sampler.acquire(listener);
  await flush();
  assert.deepEqual(rig.reads, ['/proc/stat', '/proc/meminfo'], 'one baseline read at start');
  assert.equal(got.length, 0, 'the baseline is not emitted');
  await rig.fire();
  assert.deepEqual(got, [{ cpu: 56, mem: 42, gpu: 0 }]);
  assert.equal(rig.spawned.length, 0, 'no child on Linux');
  rig.sampler.release(listener);
});

await testAsync('Linux: an unreadable /proc warns once and reads 0', async () => {
  const rig = new Rig('Linux'); // no files -> every read rejects
  const { got, listener } = seen();
  const logged = await warnings(async () => {
    rig.sampler.acquire(listener);
    await flush();
    await rig.fire();
    await rig.fire();
  });
  assert.deepEqual(got, [
    { cpu: 0, mem: 0, gpu: 0 },
    { cpu: 0, mem: 0, gpu: 0 },
  ]);
  assert.equal(logged.length, 1, 'logged once');
  assert.ok(logged[0]!.includes('host stats unavailable'));
  rig.sampler.release(listener);
});

await testAsync(
  'macOS: one top child however many consumers, killed on the last release',
  async () => {
    const rig = new Rig('macOS');
    const a = seen();
    const b = seen();
    rig.sampler.acquire(a.listener);
    assert.equal(rig.spawned.length, 1);
    assert.deepEqual(rig.spawned[0]!.argv, ['top', '-l', '0', '-s', '2', '-n', '0']);
    const { child } = rig.spawned[0]!;
    // Split mid-line: the parser must buffer across chunks.
    const cut = TOP_OUTPUT.indexOf('CPU usage:') + 12;
    child.write(TOP_OUTPUT.slice(0, cut));
    child.write(TOP_OUTPUT.slice(cut));
    await flush();
    await rig.fire();
    assert.deepEqual(a.got, [{ cpu: 49, mem: 99, gpu: 0 }], 'the newest block wins');

    rig.sampler.acquire(b.listener);
    assert.equal(rig.spawned.length, 1, 'a second consumer shares the child');
    assert.deepEqual(
      b.got,
      [{ cpu: 49, mem: 99, gpu: 0 }],
      'a late consumer gets the latest at once',
    );
    assert.equal(rig.sampler.consumers, 2);

    rig.sampler.release(a.listener);
    assert.deepEqual(child.kills, [], 'still one consumer left');
    assert.equal(rig.stoppedTimers, 0);
    rig.sampler.release(a.listener); // a stranger / double release changes nothing
    assert.equal(rig.sampler.consumers, 1);
    rig.sampler.release(b.listener);
    assert.deepEqual(child.kills, ['SIGTERM'], 'the last release kills the child');
    assert.equal(rig.stoppedTimers, 1);
    assert.equal(rig.tick, undefined);

    rig.sampler.acquire(a.listener);
    assert.equal(rig.spawned.length, 2, 'a new consumer after a full stop spawns afresh');
    rig.sampler.release(a.listener);
    assert.deepEqual(rig.spawned[1]!.child.kills, ['SIGTERM']);
  },
);

test('macOS: acquiring the same listener twice counts once', () => {
  const rig = new Rig('macOS');
  const { listener } = seen();
  rig.sampler.acquire(listener);
  rig.sampler.acquire(listener);
  assert.equal(rig.sampler.consumers, 1);
  assert.equal(rig.spawned.length, 1);
  rig.sampler.release(listener);
  assert.equal(rig.spawned[0]!.child.kills.length, 1);
});

await testAsync('macOS: a line that does not parse warns once and reads 0', async () => {
  const rig = new Rig('macOS');
  const { got, listener } = seen();
  const logged = await warnings(async () => {
    rig.sampler.acquire(listener);
    rig.spawned[0]!.child.write(
      'CPU usage: ???\nPhysMem: ???\nCPU usage: still bad\nPhysMem: 15G used (1G wired), 1G unused.\n',
    );
    await flush();
    await rig.fire();
  });
  assert.deepEqual(
    got,
    [{ cpu: 0, mem: 94, gpu: 0 }],
    'cpu failed to 0, the good memory line wins',
  );
  assert.equal(logged.length, 1);
  rig.sampler.release(listener);
});

await testAsync(
  'macOS: a missing top binary warns once and the sampler still ticks zeros',
  async () => {
    const rig = new Rig('macOS');
    rig.spawnError = new Error('ENOENT');
    const { got, listener } = seen();
    const logged = await warnings(async () => {
      rig.sampler.acquire(listener);
      await rig.fire();
      await rig.fire();
    });
    assert.equal(got.length, 2, 'the tick keeps running so a stats plugin is still polled');
    assert.deepEqual(got[0], { cpu: 0, mem: 0, gpu: 0 });
    assert.equal(logged.length, 1);
    rig.sampler.release(listener);
  },
);

await testAsync('a child that dies on its own is reported once', async () => {
  const rig = new Rig('macOS');
  const { listener } = seen();
  const logged = await warnings(async () => {
    rig.sampler.acquire(listener);
    rig.spawned[0]!.child.die(1);
    await flush();
  });
  assert.equal(logged.length, 1);
  assert.ok(logged[0]!.includes('exited with status 1'));
  rig.sampler.release(listener); // the kill after an exit must not throw
});

await testAsync('Windows: one typeperf child, header skipped, CRLF rows parsed', async () => {
  const rig = new Rig('Windows');
  const { got, listener } = seen();
  rig.sampler.acquire(listener);
  assert.deepEqual(rig.spawned[0]!.argv, [
    'typeperf',
    '-si',
    '2',
    '\\Processor(_Total)\\% Processor Time',
    '\\Memory\\% Committed Bytes In Use',
  ]);
  rig.spawned[0]!.child.write(TYPEPERF_OUTPUT);
  await flush();
  await rig.fire();
  assert.deepEqual(got, [{ cpu: 7, mem: 47, gpu: 0 }]);
  rig.sampler.release(listener);
  assert.deepEqual(rig.spawned[0]!.child.kills, ['SIGTERM']);
});

await testAsync('Windows: "Error: No valid counters" (a localized OS) warns once', async () => {
  const rig = new Rig('Windows');
  const { got, listener } = seen();
  const logged = await warnings(async () => {
    rig.sampler.acquire(listener);
    rig.spawned[0]!.child.write('Error:\r\nNo valid counters.\r\nError: No valid counters.\r\n');
    await flush();
    await rig.fire();
  });
  assert.deepEqual(got, [{ cpu: 0, mem: 0, gpu: 0 }]);
  assert.equal(logged.length, 1);
  rig.sampler.release(listener);
});

await testAsync('a throwing listener does not stop the others', async () => {
  const rig = new Rig('macOS');
  const { got, listener } = seen();
  rig.sampler.acquire(() => {
    throw new Error('boom');
  });
  rig.sampler.acquire(listener);
  await warnings(async () => {
    await rig.fire();
  });
  assert.equal(got.length, 1);
});

summaryExit();
