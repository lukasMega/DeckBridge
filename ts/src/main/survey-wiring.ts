import type { TrayHandle, TrayNotify } from '../infra/tray.js';
import { sendSurvey } from '../infra/survey-send.js';
import { normalizeOs, parseOsVersion, readOsVersion } from '../infra/daily-ping.js';
import { platformName } from '../infra/os-utils.ts';
import type { WebUIServer } from '../web/server/index.js';
import { surveyContext } from '../web/server/survey.js';
import type { DriverManager } from './driver-manager.js';

/** The uptime gate is 30 min, so a coarse tick is enough and costs nothing. */
export const SURVEY_NOTIFY_CHECK_MS = 60_000;

export function surveyNotification(webuiPort: number): TrayNotify {
  return {
    title: 'DeckBridge',
    body: 'Enjoying DeckBridge? 3 quick taps help shape what comes next.',
    url: `http://localhost:${webuiPort}/?survey=1`,
  };
}

interface SurveyWiring {
  webui: WebUIServer;
  driverManager: DriverManager;
  getTray: () => TrayHandle | null;
  /** False with --no-webui: the notification's link would have nothing to open. */
  notify: boolean;
  timers: Array<ReturnType<typeof setTimeout>>;
}

export function wireSurvey({ webui, driverManager, getTray, notify, timers }: SurveyWiring): void {
  let osVersion: Promise<string> | undefined;
  webui.survey.configure({
    context: async () => {
      const platform = platformName();
      const os = normalizeOs(platform);
      osVersion ??= readOsVersion(os).then((raw) => parseOsVersion(os, raw));
      return surveyContext({
        version: __VERSION__,
        platform,
        osVersion: await osVersion,
        modelIds: driverManager.getDockStatuses().map((d) => d.modelId),
        now: new Date(),
      });
    },
    isMock: () =>
      __MOCK_BUILD__ && (driverManager.getDriverMode() === 'mock' || !!tjs.env.DECKBRIDGE_MOCK),
    send: sendSurvey,
    uptimeMs: () => webui.uptimeMs(),
  });
  if (!notify) return;
  timers.push(
    setInterval(function notifyTick() {
      // Without a tray nothing can show it, so keep the once-per-version mark unspent.
      const tray = getTray();
      if (tray && webui.survey.takeNotification(webui.uiOpened))
        tray.notify(surveyNotification(webui.port));
    }, SURVEY_NOTIFY_CHECK_MS),
  );
}
