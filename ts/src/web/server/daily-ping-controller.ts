// The WebUI-server half of the daily usage ping (see daily-ping.ts): wires the
// pure pinger to persisted settings and to the live dock list.
//
// Owned by UpdateController rather than by WebUIServer directly — the two are
// one background job (one daily timer, one opt-out), and web-ui-server.ts sits
// on the 500-line check-loc gate.
import { createDailyPing, sendBeacon } from '../../daily-ping.js';
import { platformName } from '../../os-utils.js';
import type { DailyPing } from '../../daily-ping.js';
import type { DockStatus } from '../../types.js';
import type { ControllerHost } from './types.js';

export class DailyPingController {
  private readonly dailyPing: DailyPing;

  constructor(host: ControllerHost, currentVersion: string, docks: () => DockStatus[]) {
    this.dailyPing = createDailyPing({
      currentVersion,
      isEnabled: () => host.settings.a7s ?? true,
      getLastPingDay: () => host.settings.a7sDay,
      setLastPingDay: (day) => host.settings.setDailyPingDay(day),
      modelIds: () => docks().map((d) => d.modelId),
      send: (encoded, version) => sendBeacon(encoded, version),
      platform: platformName,
      browserLocale: () => host.settings.browserLocale,
    });
  }

  /** Never throws to the caller's detriment and never broadcasts — no UI
   *  reflects this. At most one beacon per UTC day (daily-ping.ts). */
  async ping(): Promise<void> {
    await this.dailyPing.ping();
  }
}
