// Parsers for the OS tools the built-in host-stats sampler reads (host-stats.ts). Pure text
// in, number out; null = the text is not what the tool prints, which the sampler reports once.
import { clampPercent } from '../shared/host-stats.js';

/** Cumulative CPU ticks from /proc/stat's aggregate line. */
export interface CpuTicks {
  busy: number;
  total: number;
}

/** "12,5" -> 12.5: a few locales print the decimal comma. */
const num = (raw: string): number => Number(raw.replace(',', '.'));

/** `cpu  user nice system idle iowait irq softirq steal guest guest_nice`. The guest columns
 *  are already inside user/nice, so only the first eight count. */
export function parseProcStat(text: string): CpuTicks | null {
  const line = text.split('\n').find((l) => l.startsWith('cpu '));
  if (line === undefined) return null;
  const f = line.slice(4).trim().split(/\s+/).map(Number);
  if (f.length < 4 || f.some((n) => !Number.isFinite(n))) return null;
  const total = f.slice(0, 8).reduce((a, b) => a + b, 0);
  return { busy: total - f[3]! - (f[4] ?? 0), total };
}

/** Busy share between two reads; 0 when no ticks passed. */
export function cpuPercent(prev: CpuTicks, cur: CpuTicks): number {
  const total = cur.total - prev.total;
  return total > 0 ? clampPercent(((cur.busy - prev.busy) / total) * 100) : 0;
}

const meminfoKb = (text: string, key: string): number | undefined => {
  const m = new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(text);
  return m ? Number(m[1]) : undefined;
};

/** Used share of RAM: MemTotal less MemAvailable (what the kernel could hand out without
 *  swapping), or free + buffers + cached on a kernel older than 3.14. */
export function parseMeminfo(text: string): number | null {
  const total = meminfoKb(text, 'MemTotal');
  if (!total) return null;
  const free = meminfoKb(text, 'MemFree');
  const avail =
    meminfoKb(text, 'MemAvailable') ??
    (free === undefined
      ? undefined
      : free + (meminfoKb(text, 'Buffers') ?? 0) + (meminfoKb(text, 'Cached') ?? 0));
  return avail === undefined ? null : clampPercent(((total - avail) / total) * 100);
}

const TOP_CPU = /^CPU usage: ([\d.,]+)% user, ([\d.,]+)% sys, [\d.,]+% idle/;
const TOP_USED = /^PhysMem: ([\d.,]+)([KMGT]) used/;
const TOP_UNUSED = /, ([\d.,]+)([KMGT]) unused/;
const UNIT: Readonly<Record<string, number>> = { K: 1, M: 1024, G: 1024 ** 2, T: 1024 ** 3 };

/** macOS `top` header `CPU usage: 42.84% user, 6.5% sys, 51.10% idle` -> user + sys. */
export function parseTopCpu(line: string): number | null {
  const m = TOP_CPU.exec(line);
  return m ? clampPercent(num(m[1]!) + num(m[2]!)) : null;
}

/** macOS `top` header `PhysMem: 15G used (2240M wired, 3810M compressor), 70M unused.` ->
 *  used / (used + unused). top rounds big figures to whole GB, so this moves in ~3% steps
 *  on a 16 GB machine. */
export function parseTopMem(line: string): number | null {
  const [u, f] = [TOP_USED.exec(line), TOP_UNUSED.exec(line)];
  if (!u || !f) return null;
  const used = num(u[1]!) * UNIT[u[2]!]!;
  const unused = num(f[1]!) * UNIT[f[2]!]!;
  return used + unused > 0 ? clampPercent((used / (used + unused)) * 100) : null;
}

/** One `typeperf` CSV data row: `"11/18/2026 10:00:00.123","12.345678","45.678901"`
 *  (processor time %, committed bytes in use %). Header, blank and status lines are null. */
export function parseTypeperfRow(line: string): { cpu: number; mem: number } | null {
  const m = /^"[^"]*","([^"]*)","([^"]*)"\s*$/.exec(line);
  // A blank cell is how typeperf prints a counter it could not read; Number('') would be 0.
  if (!m || !m[1]!.trim() || !m[2]!.trim()) return null;
  const [cpu, mem] = [num(m[1]!), num(m[2]!)];
  return Number.isFinite(cpu) && Number.isFinite(mem)
    ? { cpu: clampPercent(cpu), mem: clampPercent(mem) }
    : null;
}
