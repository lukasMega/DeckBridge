// The WebUI half of the update check (see update-check.ts): wires the pure
// checker to persisted settings and broadcasts a change so an open UI updates
// without polling. Split out of web-ui-server.ts to keep that file under the
// 500-line check-loc gate.
import { createUpdateChecker } from '../../update-check.js';
import type { UpdateChecker, UpdateInfo } from '../../update-check.js';
import { fetchLatestRelease } from '../../update-check.js';
import { DailyPingController } from './daily-ping-controller.js';
import type { DockStatus } from '../../types.js';
import type { ControllerHost } from './types.js';

export class UpdateController {
  private readonly checker: UpdateChecker;
  private readonly dailyPing: DailyPingController;
  private onChange?: (info: UpdateInfo) => void;

  constructor(
    private readonly host: ControllerHost,
    currentVersion: string,
    docks: () => DockStatus[],
  ) {
    this.dailyPing = new DailyPingController(host, currentVersion, docks);
    this.checker = createUpdateChecker({
      currentVersion,
      isEnabled: () => this.host.settings.updateCheck ?? true,
      getState: () => this.host.settings.updateState,
      setState: (s) => this.host.settings.setUpdateState(s),
      fetchRelease: (v) => fetchLatestRelease(v),
    });
  }

  info(): UpdateInfo {
    return this.checker.toInfo();
  }

  setOnChange(onChange: (info: UpdateInfo) => void): void {
    this.onChange = onChange;
  }

  private notify(info: UpdateInfo): void {
    this.host.broadcast('update', info);
    this.onChange?.(info);
  }

  /** Daily usage ping, on its own timer (app.ts): the dwell gate rejects a
   *  session's first minutes, which on the shared 24 h interval cost a whole
   *  day. Never throws — dailyPing must not break anything. */
  async ping(): Promise<void> {
    await this.dailyPing.ping();
  }

  /** Runs the (possibly cached) check and broadcasts the result. */
  async check(force: boolean): Promise<UpdateInfo> {
    const info = await this.checker.check(force);
    this.notify(info);
    return info;
  }

  dismiss(version: string): UpdateInfo {
    this.checker.dismiss(version);
    const info = this.checker.toInfo();
    this.notify(info);
    return info;
  }

  setEnabled(enabled: boolean): void {
    this.host.settings.setUpdateCheck(enabled);
    this.notify(this.checker.toInfo());
  }
}
