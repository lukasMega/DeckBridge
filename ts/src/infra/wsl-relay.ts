// Runs `deckbridge relay` inside WSL2 so Stream Deck app 7.6.1 can pair on the same PC
// (issue #257, docs/elgato-same-computer.md): the WSL NAT VM has an IP Windows does not
// call its own. Everything WSL-facing goes through the injected WslRunner, so the state
// machine is tested with fakes (CI has no WSL).
import type { LogLevel } from '../shared/logger.js';
import type { WslRelayStatus } from '../web/contract-wsl-relay.js';
import {
  classifyDetect,
  DETECT_SCRIPT,
  findSha256,
  firewallFixCommand,
  noWslFix,
  parseDetect,
  parseRelayLine,
  releaseZipUrl,
  sumsUrl,
  zipArch,
  zipName,
} from './wsl-relay-parse.js';
import type { DetectResult, RelayTarget } from './wsl-relay-parse.js';

// A cold WSL boot can take far longer than a warm probe.
const DETECT_TIMEOUT_MS = 60_000;
const CLEANUP_TIMEOUT_MS = 3_000;
const RETRY_DELAY_MS = 5_000;
const RELAY_NAME = 'DeckBridge (WSL)';

export interface WslSpawned {
  /** Kills the child and resolves once it is gone (bounded). */
  stop(): Promise<void>;
  /** Exit code, or null when killed by a signal. */
  exited: Promise<number | null>;
}

export interface WslRunner {
  /** `wsl.exe -e <args>`. Rejects when wsl.exe is missing; a non-zero code is a result.
   *  `timedOut` means it was killed at `timeoutMs` (the code then says nothing). */
  exec(
    args: string[],
    timeoutMs: number,
  ): Promise<{ code: number; stdout: string; timedOut?: boolean }>;
  /** Long-running `wsl.exe -e <args>`; `onLine` gets stdout and stderr lines. */
  spawn(args: string[], onLine: (line: string) => void): WslSpawned;
  download(url: string, dest: string): Promise<void>;
  fetchText(url: string): Promise<string>;
  /** Lowercase hex digest of a Windows file. */
  sha256(path: string): Promise<string>;
  /** Extracts the zip into `dir`, dropping the zip's top-level folder. */
  unzip(zip: string, dir: string): Promise<void>;
  /** Windows path to the path seen from inside WSL. */
  toWslPath(winPath: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  /** Moves the finished `stage` directory to `dir`, replacing it (never a half-filled `dir`). */
  promote(stage: string, dir: string): Promise<void>;
  /** Removes every directory under `root` except `keep` (old relay versions). */
  pruneOthers(root: string, keep: string): Promise<void>;
}

export interface WslRelayDeps {
  /** Null where WSL can't run (`supported: false`); it is never used then. */
  runner: WslRunner | null;
  /** DeckBridge's version ("0.22.0"); picks the release zip. */
  version: string;
  /** Windows cache dir; the relay binary lives in `<cacheDir>/wsl-relay/<version>/`. */
  cacheDir: string;
  /** The Windows machine's own IPv4s, to spot mirrored networking. */
  hostIps(): string[];
  /** The address DeckBridge listens on, which WSL reaches through the NAT; or why there is none. */
  target(): RelayTarget;
  targetPort: number;
  lastIp(): string | undefined;
  saveLastIp(ip: string): void;
  log(level: LogLevel, message: string): void;
  onStatus(status: WslRelayStatus): void;
  supported: boolean;
  /** DECKBRIDGE_WSL_RELAY_ZIP: a local path or URL to use instead of the release zip.
   *  For unreleased versions, so the checksum is skipped. */
  zipOverride?: string;
  /** Test seam; the retry after an unexpected exit waits this long. */
  retryDelayMs?: number;
}

const OFF: Omit<WslRelayStatus, 'supported'> = {
  enabled: false,
  state: 'off',
  wslIp: null,
  ipChanged: false,
  distro: null,
  detail: null,
  fixCommand: null,
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class WslRelay {
  private s: WslRelayStatus;
  private gen = 0;
  private proc: WslSpawned | null = null;
  private paired = false;
  private retried = false;
  private lastLine = '';
  /** Flows run one at a time: a cancelled one may still be mid-download. */
  private inflight: Promise<void> = Promise.resolve();

  constructor(private readonly deps: WslRelayDeps) {
    this.s = { ...OFF, supported: deps.supported };
  }

  status(): WslRelayStatus {
    return { ...this.s };
  }

  /** Resolves once the relay process is started (or the flow stopped on a problem);
   *  later states (`blocked`, `ready`, `paired`) arrive through `onStatus`. */
  async setEnabled(on: boolean): Promise<WslRelayStatus> {
    if (!this.deps.supported || on === this.s.enabled) return this.status();
    if (!on) {
      await this.halt();
      this.set({ ...OFF });
      return this.status();
    }
    this.set({ enabled: true });
    this.retried = false;
    await this.runFlow();
    return this.status();
  }

  /** Runs the whole flow again (the user fixed WSL, the firewall, ...). */
  async recheck(): Promise<WslRelayStatus> {
    if (!this.s.enabled) return this.status();
    await this.halt();
    this.retried = false;
    await this.runFlow();
    return this.status();
  }

  /** Fed from the primary dock's Stream Deck app connection. */
  setPaired(paired: boolean): void {
    this.paired = paired;
    if (paired && this.s.state === 'ready') {
      this.set({ state: 'paired', ipChanged: false });
      this.savePairedIp();
    } else if (!paired && this.s.state === 'paired') this.set({ state: 'ready' });
  }

  /** Shutdown: stop the relay but keep the persisted switch. */
  async stop(): Promise<void> {
    await this.halt();
    if (this.s.enabled) this.set({ state: 'off', wslIp: null, detail: null, fixCommand: null });
  }

  /** Only a paired run proves the user added this IP, so only then is it the one to compare. */
  private savePairedIp(): void {
    if (this.s.wslIp !== null) this.deps.saveLastIp(this.s.wslIp);
  }

  private get runner(): WslRunner {
    if (this.deps.runner === null) throw new Error('WSL is not supported on this system.');
    return this.deps.runner;
  }

  private set(patch: Partial<WslRelayStatus>): void {
    const next = { ...this.s, ...patch };
    if (JSON.stringify(next) === JSON.stringify(this.s)) return;
    this.s = next;
    this.deps.onStatus({ ...next });
  }

  private async halt(): Promise<void> {
    this.gen++;
    const p = this.proc;
    this.proc = null;
    if (p === null) return;
    await p.stop().catch(() => undefined);
    await this.cleanupStale();
  }

  /** Killing wsl.exe may leave the Linux process running and holding 5343. */
  private async cleanupStale(): Promise<void> {
    try {
      await this.runner.exec(['pkill', '-f', 'deckbridge relay'], CLEANUP_TIMEOUT_MS);
    } catch {
      // best effort
    }
  }

  private runFlow(): Promise<void> {
    const gen = this.gen;
    this.set({ ...OFF, enabled: true, state: 'checking' });
    const run = this.inflight.then(() => this.startFlow(gen));
    this.inflight = run;
    return run;
  }

  /** Never rejects. */
  private async startFlow(gen: number): Promise<void> {
    const alive = (): boolean => gen === this.gen;
    try {
      if (!alive()) return;
      const target = this.deps.target();
      if ('error' in target) {
        this.fail(target.error);
        return;
      }
      const d = await this.detect(alive);
      if (d === null || !alive()) return;
      const arch = zipArch(d.arch);
      if (arch === null) {
        this.fail(`No Linux relay build exists for the CPU "${d.arch}".`);
        return;
      }
      const bin = await this.ensureBinary(arch, alive);
      if (bin === null || !alive()) return;
      await this.cleanupStale();
      const wslBin = await this.runner.toWslPath(bin);
      if (!alive()) return;
      this.launch(gen, wslBin, d.wslIp ?? '', target.ip);
    } catch (e) {
      if (alive()) this.fail((e as Error).message);
    }
  }

  /** The probe verdict, or null after the state was set to the problem. */
  private async detect(alive: () => boolean): Promise<DetectResult | null> {
    let out: { code: number; stdout: string; timedOut?: boolean };
    try {
      out = await this.runner.exec(['sh', '-c', DETECT_SCRIPT], DETECT_TIMEOUT_MS);
    } catch (e) {
      return this.noWsl((e as Error).message, alive);
    }
    if (!alive()) return null;
    if (out.timedOut === true) {
      this.fail('WSL took too long to start. Press Check again.');
      return null;
    }
    if (out.code !== 0) return this.noWsl(out.stdout.trim().split('\n')[0] ?? '', alive);
    const d = parseDetect(out.stdout);
    const problem = classifyDetect(d, this.deps.hostIps());
    if (problem !== null) {
      this.set({
        state: problem.state,
        detail: problem.detail,
        fixCommand: problem.fixCommand,
        distro: d.distro || null,
      });
      return null;
    }
    if (d.wslIp === null) {
      this.fail('WSL reports no IPv4 address.');
      return null;
    }
    this.set({ distro: d.distro || null });
    return d;
  }

  private noWsl(text: string, alive: () => boolean): null {
    if (alive()) {
      this.set({
        state: 'no-wsl',
        detail: text || 'WSL is not installed or has no Linux distribution.',
        fixCommand: noWslFix(),
      });
    }
    return null;
  }

  private fail(detail: string, state: WslRelayStatus['state'] = 'error'): void {
    this.deps.log('error', detail);
    this.set({ state, detail, fixCommand: null });
  }

  /** Windows path to the cached relay binary, downloading it first when missing. The zip is
   *  unpacked beside the final dir and moved in, so an interrupted run can't leave a binary
   *  that looks complete. */
  private async ensureBinary(
    arch: 'x86_64' | 'arm64',
    alive: () => boolean,
  ): Promise<string | null> {
    const { version, cacheDir, zipOverride } = this.deps;
    const runner = this.runner;
    const sep = cacheDir.includes('\\') ? '\\' : '/';
    const root = `${cacheDir}${sep}wsl-relay`;
    const dir = `${root}${sep}${version}`;
    const bin = `${dir}${sep}deckbridge`;
    if (zipOverride === undefined && (await runner.exists(bin))) return bin;
    if (!alive()) return null;
    this.set({ state: 'downloading' });
    try {
      const stage = `${dir}.part`;
      let zip = zipOverride;
      if (zip === undefined || /^https?:\/\//.test(zip)) {
        const url = zip ?? releaseZipUrl(version, arch);
        zip = `${stage}${sep}relay.zip`;
        await runner.download(url, zip);
        if (zipOverride === undefined) await this.verify(zip, arch);
      }
      if (!alive()) return null;
      await runner.unzip(zip, stage);
      if (!(await runner.exists(`${stage}${sep}deckbridge`))) {
        throw new Error('the zip has no deckbridge binary');
      }
      await runner.promote(stage, dir);
      await runner.pruneOthers(root, version);
    } catch (e) {
      if (alive()) this.fail(`Could not get the relay: ${(e as Error).message}`, 'download-failed');
      return null;
    }
    return bin;
  }

  private async verify(zip: string, arch: 'x86_64' | 'arm64'): Promise<void> {
    const { version } = this.deps;
    const runner = this.runner;
    const expected = findSha256(await runner.fetchText(sumsUrl(version)), zipName(version, arch));
    if (expected === null) throw new Error('the release lists no checksum for this zip');
    if ((await runner.sha256(zip)).toLowerCase() !== expected) {
      throw new Error('the downloaded zip does not match its SHA256 checksum');
    }
  }

  private launch(gen: number, wslBin: string, wslIp: string, targetIp: string): void {
    this.lastLine = '';
    this.set({ state: 'starting', detail: null, fixCommand: null });
    const proc = this.runner.spawn(
      [
        wslBin,
        'relay',
        '--target',
        targetIp,
        '--target-port',
        String(this.deps.targetPort),
        '--no-advertise',
        '--name',
        RELAY_NAME,
      ],
      (line) => {
        if (gen === this.gen) this.onLine(line, wslIp);
      },
    );
    this.proc = proc;
    void proc.exited.then((code) => this.onExit(gen, proc, code));
  }

  private onLine(line: string, wslIp: string): void {
    const r = parseRelayLine(line);
    if (r.message === '') return;
    this.lastLine = r.message;
    this.deps.log(r.level, r.message);
    if (r.event === 'blocked') {
      this.set({ state: 'blocked', detail: r.message, fixCommand: firewallFixCommand() });
    } else if (r.event === 'probe-ok' && this.s.state === 'blocked') {
      this.set({ state: 'starting', detail: null, fixCommand: null });
    } else if (r.event === 'ready') {
      this.retried = false; // a later crash gets its retry again
      const last = this.deps.lastIp();
      const paired = this.paired;
      this.set({
        state: paired ? 'paired' : 'ready',
        wslIp,
        ipChanged: !paired && last !== undefined && last !== wslIp,
        detail: null,
        fixCommand: null,
      });
      if (paired) this.savePairedIp();
    }
  }

  private async onExit(gen: number, proc: WslSpawned, code: number | null): Promise<void> {
    if (gen !== this.gen || this.proc !== proc) return; // stopped on purpose
    this.proc = null;
    const why = this.lastLine || `The relay exited (code ${code ?? 'signal'}).`;
    this.deps.log('warn', `relay process ended (code ${code ?? 'signal'})`);
    if (this.retried) return this.giveUp(why);
    this.retried = true;
    this.set({ state: 'starting', detail: 'The relay stopped; restarting it.', fixCommand: null });
    await sleep(this.deps.retryDelayMs ?? RETRY_DELAY_MS);
    if (gen === this.gen) await this.runFlow();
  }

  private giveUp(why: string): void {
    if (/GLIBC_\d/.test(why)) {
      this.set({
        state: 'old-glibc',
        detail: 'This distro is too old for the relay (glibc 2.38 or newer is needed).',
        fixCommand: 'wsl --install -d Ubuntu-24.04; wsl --set-default Ubuntu-24.04',
      });
    } else {
      this.set({ state: 'error', detail: why, fixCommand: null });
    }
  }
}
