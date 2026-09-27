// Server-side control surface for the Elgato-app auto-restart feature (see
// .claude/plans/2026-09-27_auto-restart-elgato-app.md §4.4). Owns the ONE
// ElgatoAppControl instance for this process — main/elgato-auto-restart.ts and
// the tray "Restart Elgato App" item both go through `webui.elgatoApp`, never
// creating a control of their own, so quit/launch state (in-flight restart)
// stays consistent across every trigger.
import { createElgatoAppControl } from '../../infra/elgato-app.js';
import type { ElgatoAppControl, RestartResult } from '../../infra/elgato-app.js';
import { platformName } from '../../infra/os-utils.js';
import type { ControllerHost } from './types.js';

const SUPPORTED_PLATFORMS = new Set(['macOS', 'Windows']);

export interface ElgatoAppState {
  enabled: boolean;
  delayS: number;
  /** False on Linux (no Elgato app build) — the WebUI shows a note and disables
   *  the controls instead of a toggle that can never do anything. */
  supported: boolean;
}

export class ElgatoAppController {
  readonly control: ElgatoAppControl = createElgatoAppControl();

  constructor(private readonly host: ControllerHost) {}

  state(): ElgatoAppState {
    return {
      enabled: this.host.settings.elgatoAutoRestartEnabled(),
      delayS: this.host.settings.elgatoAutoRestartDelaySeconds(),
      supported: SUPPORTED_PLATFORMS.has(platformName()),
    };
  }

  /** Persist the auto-restart opt-out + grace delay (WebUI "Elgato app" toggle/field). */
  set(enabled: boolean, delayS?: number): void {
    this.host.settings.setElgatoAutoRestart(enabled, delayS);
  }

  /** Manual restart (WebUI button / tray "Restart Elgato App"): the app is
   *  running → `restart()`; not running → `launch()`, mapped onto the same
   *  RestartResult shape so both callers handle one response type. */
  async restartNow(): Promise<RestartResult> {
    if (await this.control.isRunning()) return this.control.restart();
    const launched = await this.control.launch();
    return launched ? { ok: true, killed: false } : { ok: false, reason: 'launch-failed' };
  }
}
