// Feeds the Ulanzi D200 info window's stats mode. While a dock shows it, this subscribes to
// the shared host sampler (infra/host-stats.ts), lays an optional stats plugin's reply over
// the built-in figures and hands the result to the driver, which stores it for its next
// keepalive. Out of stats mode it holds no subscription, so the sampler (and its child) stop.
import { warn } from '../shared/logger.js';
import { NO_STATS, applyPluginStats, sameStats } from '../shared/host-stats.js';
import type { HostStats } from '../shared/host-stats.js';
import { wideKeyShowsStats } from '../shared/wide-key.js';
import { hostStats } from '../infra/host-stats.js';
import type { HostStatsSampler } from '../infra/host-stats.js';
import type { DockPrefs } from '../infra/dock-prefs.js';
import { pluginValueFor } from '../plugin/plugin-host.js';
import type { DeviceModel, DockDriver } from '../devices/driver.js';

/** The two sampler calls this needs; the process-wide sampler satisfies it. */
export type StatsSampler = Pick<HostStatsSampler, 'acquire' | 'release'>;

export interface WideKeyStatsDeps {
  driver: () => DockDriver | null;
  prefs: () => DockPrefs | undefined;
  model: () => DeviceModel;
  /** Seams: the process-wide sampler and the plugin reader. Tests pass fakes. */
  sampler?: StatsSampler;
  plugin?: typeof pluginValueFor;
}

export class WideKeyStats {
  private readonly sampler: StatsSampler;
  private readonly plugin: typeof pluginValueFor;
  private subscribed = false;
  private builtin: HostStats = { ...NO_STATS };
  /** What the current driver last got, so an unchanged tick sends no message. */
  private sent: { driver: DockDriver; stats: HostStats } | undefined;
  /** The plugin file whose bad reply was already reported (once until it recovers). */
  private warnedFor: string | undefined;
  private readonly onSample = (stats: HostStats): void => {
    this.builtin = stats;
    this.push();
  };

  constructor(private readonly deps: WideKeyStatsDeps) {
    this.sampler = deps.sampler ?? hostStats;
    this.plugin = deps.plugin ?? pluginValueFor;
  }

  /** Re-evaluate after anything that decides it: a driver attach/detach, a settings change. */
  sync(): void {
    const wanted = this.wanted();
    if (wanted && !this.subscribed) {
      this.subscribed = true;
      // A fresh (or just zeroed) driver holds zeros, so those need no message.
      const driver = this.deps.driver();
      this.sent = driver ? { driver, stats: { ...NO_STATS } } : undefined;
      this.sampler.acquire(this.onSample);
    } else if (!wanted && this.subscribed) {
      this.subscribed = false;
      this.sampler.release(this.onSample);
      this.clear();
    }
    // A changed stats plugin shows now, not at the next sample.
    this.push();
  }

  /** What the window shows now, for the WebUI preview; undefined out of stats mode or with no
   *  device. Reads the last-sent figures, so it never re-asks a plugin. */
  current(): HostStats | undefined {
    return this.subscribed && this.sent ? { ...this.sent.stats } : undefined;
  }

  private wanted(): boolean {
    const driver = this.deps.driver();
    const prefs = this.deps.prefs();
    const page = this.deps.model().page;
    return !!driver?.setHostStats && !!prefs && !!page && wideKeyShowsStats(prefs.wideKey(), page);
  }

  private push(): void {
    const driver = this.deps.driver();
    const cfg = this.deps.prefs()?.wideKey();
    // A plugin update can land after the window left stats mode.
    if (!this.subscribed || !driver?.setHostStats || !cfg) return;
    const stats = this.withPlugin(cfg.statsPlugin);
    if (this.sent?.driver === driver && sameStats(this.sent.stats, stats)) return;
    this.sent = { driver, stats };
    driver.setHostStats(stats.cpu, stats.mem, stats.gpu);
  }

  /** Plugin keys the user gives replace the built-in ones (GPU included). No reply yet, a
   *  null reply or a bad one all fall back to the built-in figures; a bad one warns once. */
  private withPlugin(file: string | undefined): HostStats {
    if (!file) {
      this.warnedFor = undefined;
      return this.builtin;
    }
    // Asking each tick also keeps the plugin host's entry alive (it reaps idle ones).
    const { value } = this.plugin(file, undefined, undefined, () => this.push());
    if (typeof value !== 'string') return this.builtin;
    const merged = applyPluginStats(value, this.builtin);
    if (merged) {
      this.warnedFor = undefined;
      return merged;
    }
    if (this.warnedFor !== file) {
      this.warnedFor = file;
      warn(
        'hoststats',
        `stats plugin ${file} must return JSON like {"cpu":12,"mem":34,"gpu":56}; using the built-in stats`,
      );
    }
    return this.builtin;
  }

  /** Leaving stats mode zeroes what the driver keeps, so the keepalive frame is the default's. */
  private clear(): void {
    const driver = this.deps.driver();
    const sent = this.sent;
    if (driver?.setHostStats && sent?.driver === driver && !sameStats(sent.stats, NO_STATS)) {
      driver.setHostStats(0, 0, 0);
    }
    this.sent = undefined;
    this.builtin = { ...NO_STATS };
    this.warnedFor = undefined;
  }
}
