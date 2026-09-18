// The WebUI-server half of the daily usage ping (see telemetry.ts): wires the
// pure pinger to persisted settings and to the live dock list.
//
// Owned by UpdateController rather than by WebUIServer directly — the two are
// one background job (one daily timer, one opt-out), and web-ui-server.ts sits
// on the 500-line check-loc gate.
import { createTelemetry, sendBeacon } from '../../telemetry.js';
import { platformName } from '../../os-utils.js';
import type { Telemetry } from '../../telemetry.js';
import type { DockStatus } from '../../types.js';
import type { ControllerHost } from './types.js';

export class TelemetryController {
  private readonly telemetry: Telemetry;

  constructor(host: ControllerHost, currentVersion: string, docks: () => DockStatus[]) {
    this.telemetry = createTelemetry({
      currentVersion,
      // `updateCheck: false` disables this too: that toggle reads as "no
      // background network calls", not "no update check specifically".
      isEnabled: () => (host.settings.a7s ?? true) && (host.settings.updateCheck ?? true),
      getLastPingDay: () => host.settings.a7sDay,
      setLastPingDay: (day) => host.settings.setTelemetryDay(day),
      modelIds: () => docks().map((d) => d.modelId),
      send: (encoded, version) => sendBeacon(encoded, version),
      platform: platformName,
    });
  }

  /** Never throws to the caller's detriment and never broadcasts — no UI
   *  reflects this. At most one beacon per UTC day (telemetry.ts). */
  async ping(): Promise<void> {
    await this.telemetry.ping();
  }
}
