// Pure helpers for the WSL relay (issue #257): the WSL probe script and its verdicts,
// wsl.exe text decoding, relay log-line mapping and release URLs. No I/O, so every branch
// is unit-tested without WSL.
import type { LogLevel } from '../shared/logger.js';
import type { WslRelayState } from '../web/contract-wsl-relay.js';

/** The Linux build needs glibc 2.38+ (see release.yml). */
const MIN_GLIBC: readonly [number, number] = [2, 38];
const RELEASE_BASE = 'https://github.com/lukasMega/DeckBridge/releases/download';

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

export function isIPv4(s: string): boolean {
  return IPV4.test(s);
}

export type RelayTarget = { ip: string } | { error: string };

/** The address the WSL relay dials: `--bind` when it is a real LAN IPv4, else the LAN IP.
 *  WSL can't reach loopback, so a loopback bind has no working target. */
export function relayTarget(bind: string, lanIp: string): RelayTarget {
  if (bind === '127.0.0.1' || bind.startsWith('127.') || bind === 'localhost' || bind === '::1') {
    return {
      error: `DeckBridge is bound to ${bind}; WSL can't reach it. Remove the bind setting.`,
    };
  }
  const ip = isIPv4(bind) && bind !== '0.0.0.0' ? bind : lanIp;
  return ip === '' ? { error: 'No network address found' } : { ip };
}

/** No quotes on purpose: wsl.exe re-parses the Windows command line, so quoting differs. */
export const DETECT_SCRIPT =
  'echo kernel=$(uname -r); echo arch=$(uname -m); echo glibc=$(getconf GNU_LIBC_VERSION); ' +
  'echo ip=$(hostname -I); echo mode=$(wslinfo --networking-mode 2>/dev/null); ' +
  'echo distro=$WSL_DISTRO_NAME';

export interface DetectResult {
  kernel: string;
  arch: string;
  /** Version only ("2.39"), without the "glibc " prefix. */
  glibc: string;
  /** Raw `hostname -I`. */
  ip: string;
  mode: string;
  distro: string;
  /** Only WSL2 kernels carry `microsoft-standard`; WSL1 reports `-Microsoft`. */
  wsl2: boolean;
  /** First IPv4 of `ip`. */
  wslIp: string | null;
}

export interface DetectProblem {
  state: Extract<WslRelayState, 'wsl1' | 'mirrored' | 'old-glibc'>;
  detail: string;
  fixCommand: string;
}

export function parseDetect(stdout: string): DetectResult {
  const kv: Record<string, string> = {};
  for (const raw of stdout.split('\n')) {
    const i = raw.indexOf('=');
    if (i > 0) kv[raw.slice(0, i).trim()] = raw.slice(i + 1).trim();
  }
  const ip = kv.ip ?? '';
  const kernel = kv.kernel ?? '';
  return {
    kernel,
    arch: kv.arch ?? '',
    glibc: (kv.glibc ?? '').replace(/^glibc\s+/i, ''),
    ip,
    mode: (kv.mode ?? '').toLowerCase(),
    distro: kv.distro ?? '',
    wsl2: kernel.toLowerCase().includes('microsoft-standard'),
    wslIp: ip.split(/\s+/).find(isIPv4) ?? null,
  };
}

function glibcTooOld(version: string): boolean {
  const m = /^(\d+)\.(\d+)/.exec(version);
  if (!m) return false; // unknown: let the relay's own exit output say so
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major < MIN_GLIBC[0] || (major === MIN_GLIBC[0] && minor < MIN_GLIBC[1]);
}

/** `null` when WSL can host the relay, else the first blocking problem. */
export function classifyDetect(r: DetectResult, hostIps: readonly string[]): DetectProblem | null {
  if (r.kernel !== '' && !r.wsl2) {
    const d = r.distro || 'Ubuntu-24.04';
    return {
      state: 'wsl1',
      detail: 'This distro runs WSL 1, which shares the Windows IP addresses.',
      fixCommand: `wsl --set-version ${d} 2`,
    };
  }
  if (r.mode === 'mirrored' || (r.wslIp !== null && hostIps.includes(r.wslIp))) {
    return {
      state: 'mirrored',
      detail: 'WSL uses mirrored networking and shares the Windows IP addresses.',
      fixCommand:
        'Set networkingMode=NAT under [wsl2] in %UserProfile%\\.wslconfig, then run: wsl --shutdown',
    };
  }
  if (glibcTooOld(r.glibc)) {
    return {
      state: 'old-glibc',
      detail: `This distro has glibc ${r.glibc}; the relay needs ${MIN_GLIBC.join('.')} or newer.`,
      fixCommand: 'wsl --install -d Ubuntu-24.04; wsl --set-default Ubuntu-24.04',
    };
  }
  return null;
}

export function noWslFix(): string {
  return 'wsl --install   (in an administrator PowerShell, then restart the PC)';
}

/** Admin PowerShell; unverified on real Windows. */
export function firewallFixCommand(): string {
  return (
    'New-NetFirewallRule -DisplayName "DeckBridge WSL relay" -Direction Inbound -Action Allow ' +
    '-Protocol TCP -LocalPort 5343,5344 -InterfaceAlias "vEthernet (WSL*)"'
  );
}

/** True for UTF-16LE output: a BOM, or a NUL after an ASCII byte near the start. */
export function looksUtf16(bytes: Uint8Array): boolean {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return true;
  const n = Math.min(bytes.length, 16);
  for (let i = 1; i < n; i += 2) if (bytes[i] === 0 && bytes[i - 1] !== 0) return true;
  return false;
}

/** wsl.exe's own messages are UTF-16LE; Linux command output is UTF-8. */
export function decodeWslText(bytes: Uint8Array): string {
  if (!looksUtf16(bytes)) return new TextDecoder().decode(bytes);
  let out = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    out += String.fromCharCode(bytes[i]! | (bytes[i + 1]! << 8));
  }
  return out.replace(/^\uFEFF/, '').replace(/\r/g, '');
}

export type RelayEventKind = 'blocked' | 'probe-ok' | 'ready' | 'connected' | 'closed' | 'error';

export interface RelayLine {
  level: LogLevel;
  /** The line without the logger's time/level/[component] prefix. */
  message: string;
  event: RelayEventKind | null;
}

// Console format of shared/logger.ts: `HH:MM:SS.mmm LEVEL [component] message`.
const LOG_LINE = /^\d{2}:\d{2}:\d{2}\.\d{3} (DEBUG|INFO |WARN |ERROR) \[[^\]]*\] (.*)$/;
const LEVELS: Record<string, LogLevel> = {
  DEBUG: 'debug',
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
};

const EVENT_PREFIXES: ReadonlyArray<readonly [string, RelayEventKind]> = [
  ['waiting for DeckBridge at', 'blocked'],
  ['dock: sn=', 'probe-ok'],
  ['listening on', 'ready'],
  ['Elgato connected (', 'connected'],
  ["can't listen on", 'error'],
];

/** Maps a line of `deckbridge relay` (main/relay/run.ts) to a level and an event. Lines
 *  without the logger prefix (a loader error, wsl.exe text) pass through at `info`. */
export function parseRelayLine(line: string): RelayLine {
  const m = LOG_LINE.exec(line.replace(/\r$/, ''));
  const level = m ? (LEVELS[m[1]!.trim()] ?? 'info') : 'info';
  const message = m ? m[2]! : line.trim();
  let event: RelayEventKind | null = null;
  for (const [prefix, kind] of EVENT_PREFIXES) {
    if (message.startsWith(prefix)) event = kind;
  }
  if (event === null && / closed by /.test(message)) event = 'closed';
  return { level, message, event };
}

/** `uname -m` to the release asset's arch, or null when no Linux build exists. */
export function zipArch(uname: string): 'x86_64' | 'arm64' | null {
  if (uname === 'x86_64') return 'x86_64';
  if (uname === 'aarch64') return 'arm64';
  return null;
}

const bare = (version: string): string => version.replace(/^v/, '');

/** package.mjs names the asset `deckbridge-v<version>-<os>-<arch>.zip`. */
export function zipName(version: string, arch: 'x86_64' | 'arm64'): string {
  return `deckbridge-v${bare(version)}-linux-${arch}.zip`;
}

export function releaseZipUrl(version: string, arch: 'x86_64' | 'arm64'): string {
  return `${RELEASE_BASE}/deckbridge-v${bare(version)}/${zipName(version, arch)}`;
}

export function sumsUrl(version: string): string {
  return `${RELEASE_BASE}/deckbridge-v${bare(version)}/SHA256SUMS.txt`;
}

/** The hash for `name` in a `sha256sum` listing (`<hex>  <name>`, name maybe `*`-prefixed). */
export function findSha256(sums: string, name: string): string | null {
  for (const line of sums.split('\n')) {
    const t = line.trim();
    const hash = t.slice(0, 64);
    if (!/^[0-9a-f]{64}$/i.test(hash)) continue;
    const file = t.slice(64).trim().replace(/^\*/, '');
    if (file === name || file.endsWith(`/${name}`)) return hash.toLowerCase();
  }
  return null;
}
