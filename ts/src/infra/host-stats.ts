// Built-in host CPU / memory sampler behind the Ulanzi D200 info window's stats mode.
//
// Ref-counted: it runs only while some dock shows the stats content and stops (child
// killed, timer cleared) with the last release, so it costs nothing otherwise. Main thread
// but never blocking and never on the CORA ACK path: Linux reads /proc through async file
// reads, macOS and Windows keep ONE long-lived child (`top` / `typeperf`) whose stdout is
// parsed as it streams. `tjs.system` has no CPU load or memory figure, hence the children.
// GPU stays 0: no portable source (a stats plugin can supply it).
import { warn } from '../shared/logger.js';
import { NO_STATS } from '../shared/host-stats.js';
import type { HostStats } from '../shared/host-stats.js';
import { platformName } from './os-utils.js';
import { spawnOwned } from './owned-spawn.js';
import {
  cpuPercent,
  parseMeminfo,
  parseProcStat,
  parseTopCpu,
  parseTopMem,
  parseTypeperfRow,
} from './host-stats-parse.js';
import type { CpuTicks } from './host-stats-parse.js';

/** Sample cadence; the info window's own keepalive is 2 s, so faster would only be dropped. */
export const HOST_STATS_INTERVAL_MS = 2000;
/** A child line longer than this is garbage (no newline): drop it instead of growing. */
const MAX_LINE_CHARS = 64 * 1024;

export type StatsListener = (stats: HostStats) => void;

/** The part of a child process the sampler uses. */
export interface StatsChild {
  readonly stdout: ReadableStream<Uint8Array>;
  wait(): Promise<{ exit_status: number }>;
  kill(signal?: string): void;
}

/** Everything the sampler takes from the OS; tests replace it. */
export interface HostStatsSeams {
  platform(): string;
  readText(path: string): Promise<string>;
  spawn(argv: string[]): StatsChild;
  /** Repeat `fn` until the returned stop function runs. */
  every(fn: () => void, ms: number): () => void;
}

const realSeams: HostStatsSeams = {
  platform: platformName,
  readText: async (path) => new TextDecoder().decode(await tjs.readFile(path)),
  spawn: (argv) => spawnOwned(argv, { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' }),
  every: (fn, ms) => {
    const timer = setInterval(fn, ms);
    return () => clearInterval(timer);
  },
};

/** One running measurement: `poll` for pull sources (Linux), a child for streaming ones. */
interface Source {
  poll?(): Promise<void>;
  stop(): void;
}

// -si 2: one row per 2 s. The English counter names are what typeperf resolves; a localized
// Windows prints "Error: No valid counters", which the sampler reports once.
const TYPEPERF = [
  'typeperf',
  '-si',
  String(HOST_STATS_INTERVAL_MS / 1000),
  '\\Processor(_Total)\\% Processor Time',
  '\\Memory\\% Committed Bytes In Use',
];
// -n 0: no process list, only the header block. -l 0: sample until killed.
const TOP = ['top', '-l', '0', '-s', String(HOST_STATS_INTERVAL_MS / 1000), '-n', '0'];

export class HostStatsSampler {
  private readonly listeners = new Set<StatsListener>();
  private latest: HostStats = { ...NO_STATS };
  private source: Source | undefined;
  private stopTick: (() => void) | undefined;
  private polling = false;
  private sampled = false;
  private warned = false;

  constructor(private readonly seams: HostStatsSeams = realSeams) {}

  /** Consumers right now (the sampler runs while this is above 0). */
  get consumers(): number {
    return this.listeners.size;
  }

  /** Start sampling for `listener` (once per tick, with the newest figures). Acquiring the
   *  same listener twice counts once. */
  acquire(listener: StatsListener): void {
    if (this.listeners.has(listener)) return;
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.start();
    else if (this.sampled) listener({ ...this.latest });
  }

  /** The last release stops the child and the timer. Releasing a stranger is a no-op. */
  release(listener: StatsListener): void {
    if (this.listeners.delete(listener) && this.listeners.size === 0) this.stop();
  }

  private start(): void {
    this.latest = { ...NO_STATS };
    this.sampled = false;
    const source = this.openSource();
    this.source = source;
    // Linux: the first read is the CPU baseline, so it carries memory only.
    if (source.poll) void source.poll();
    this.stopTick = this.seams.every(() => this.tick(source), HOST_STATS_INTERVAL_MS);
  }

  private stop(): void {
    this.stopTick?.();
    this.stopTick = undefined;
    this.source?.stop();
    this.source = undefined;
  }

  private tick(source: Source): void {
    if (source !== this.source) return;
    if (!source.poll) {
      this.emit();
      return;
    }
    if (this.polling) return; // a slow read must not stack
    this.polling = true;
    void source.poll().then(() => {
      this.polling = false;
      if (source === this.source) this.emit();
      return undefined;
    });
  }

  private emit(): void {
    this.sampled = true;
    for (const listener of this.listeners) {
      try {
        listener({ ...this.latest });
      } catch (e) {
        warn('hoststats', `listener failed: ${(e as Error).message}`);
      }
    }
  }

  /** First failure is logged, later ones stay quiet; the figure that failed reads 0. */
  private fail(what: string): void {
    if (this.warned) return;
    this.warned = true;
    warn('hoststats', `built-in host stats unavailable (${what}); showing 0`);
  }

  private openSource(): Source {
    const platform = this.seams.platform();
    if (platform === 'macOS') return this.openChild(TOP, (line) => this.onTopLine(line));
    if (platform === 'Windows')
      return this.openChild(TYPEPERF, (line) => this.onTypeperfLine(line));
    return this.openProc();
  }

  private onTopLine(line: string): void {
    if (line.startsWith('CPU usage:')) this.set('cpu', parseTopCpu(line), line);
    else if (line.startsWith('PhysMem:')) this.set('mem', parseTopMem(line), line);
  }

  private onTypeperfLine(line: string): void {
    if (line.startsWith('Error:')) {
      this.fail(`typeperf cannot read its counters (it needs English counter names): ${line}`);
      return;
    }
    // The header row has the same shape as a data row; counter paths just don't parse.
    if (!line.startsWith('"') || line.startsWith('"(PDH-CSV')) return;
    const row = parseTypeperfRow(line);
    if (row === null) {
      this.fail(`typeperf row: ${line.slice(0, 120)}`);
      this.latest.cpu = 0;
      this.latest.mem = 0;
    } else {
      this.latest.cpu = row.cpu;
      this.latest.mem = row.mem;
    }
  }

  private set(key: 'cpu' | 'mem', value: number | null, line: string): void {
    if (value === null) this.fail(`unparsable line: ${line.slice(0, 120)}`);
    this.latest[key] = value ?? 0;
  }

  /** Linux: /proc/stat + /proc/meminfo, CPU as the delta between two reads. */
  private openProc(): Source {
    let prev: CpuTicks | null = null;
    return {
      stop: () => undefined,
      poll: async () => {
        try {
          const [stat, mem] = await Promise.all([
            this.seams.readText('/proc/stat'),
            this.seams.readText('/proc/meminfo'),
          ]);
          const ticks = parseProcStat(stat);
          const used = parseMeminfo(mem);
          if (ticks === null || used === null) throw new Error('unrecognized /proc format');
          this.latest.cpu = prev ? cpuPercent(prev, ticks) : 0;
          this.latest.mem = used;
          prev = ticks;
        } catch (e) {
          this.fail((e as Error).message);
          this.latest = { ...NO_STATS };
        }
      },
    };
  }

  /** One long-lived child; its stdout is parsed line by line as it arrives. */
  private openChild(argv: string[], onLine: (line: string) => void): Source {
    let stopped = false;
    let child: StatsChild;
    try {
      child = this.seams.spawn(argv);
    } catch (e) {
      this.fail(`${argv[0]}: ${(e as Error).message}`);
      return { stop: () => undefined };
    }
    void pumpLines(child.stdout, (line) => {
      if (!stopped) onLine(line);
    }).catch(() => undefined);
    // An early death (missing binary, bad args) leaves the last figures; report it once.
    void child.wait().then(
      ({ exit_status }) => {
        if (!stopped) this.fail(`${argv[0]} exited with status ${exit_status}`);
        return undefined;
      },
      () => undefined,
    );
    return {
      stop: () => {
        stopped = true;
        try {
          child.kill('SIGTERM');
        } catch {
          // already gone
        }
      },
    };
  }
}

/** Decode a byte stream into lines. A final unterminated line is dropped (the child only
 *  ends when killed). */
async function pumpLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let end = buffer.indexOf('\n');
    while (end >= 0) {
      onLine(buffer.slice(0, end).replace(/\r$/, ''));
      buffer = buffer.slice(end + 1);
      end = buffer.indexOf('\n');
    }
    if (buffer.length > MAX_LINE_CHARS) buffer = '';
  }
}

/** The process-wide sampler the docks share. */
export const hostStats = new HostStatsSampler();
