// The WebUI half of the update check (see update-check.ts): wires the pure
// checker to persisted settings and broadcasts a change so an open UI updates
// without polling. Split out of web-ui-server.ts to keep that file under the
// 500-line check-loc gate.
import { createUpdateChecker } from '../../infra/update-check.js';
import type { UpdateChecker, UpdateInfo } from '../../infra/update-check.js';
import { fetchLatestRelease } from '../../infra/update-check.js';
import { warn } from '../../shared/logger.js';
import type { ControllerHost } from './types.js';

export class UpdateController {
  private readonly checker: UpdateChecker;
  private onChange?: (info: UpdateInfo) => void;
  private onInstall?: () => void;

  constructor(
    private readonly host: ControllerHost,
    currentVersion: string,
  ) {
    this.checker = createUpdateChecker({
      currentVersion,
      isEnabled: () => this.host.settings.updateCheck ?? true,
      getState: () => this.host.settings.updateState,
      setState: (s) => this.host.settings.setUpdateState(s),
      fetchRelease: (v) => fetchLatestRelease(v),
      canInstall: tjs.env.DECKBRIDGE_UPDATER === '1',
      zipPlatform: __ZIP_PLATFORM__,
    });
  }

  info(): UpdateInfo {
    return this.checker.toInfo();
  }

  setOnChange(onChange: (info: UpdateInfo) => void): void {
    this.onChange = onChange;
  }

  setOnInstall(onInstall: () => void): void {
    this.onInstall = onInstall;
  }

  takeNotification(): string | null {
    return this.checker.takeNotification();
  }

  /** False when not under the Tauri shell or no newer version is known. */
  install(): boolean {
    const info = this.checker.toInfo();
    if (!info.canInstall || !info.updateAvailable || !this.onInstall) return false;
    warn('update', `installing v${info.latest ?? '?'} — exiting for the updater`);
    this.onInstall();
    return true;
  }

  private notify(info: UpdateInfo): void {
    this.host.broadcast('update', info);
    this.onChange?.(info);
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
