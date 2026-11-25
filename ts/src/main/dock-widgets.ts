import type { DeviceModel, DockDriver } from '../devices/driver.js';
import type { DockPrefs } from '../infra/dock-prefs.js';
import type { DockPages } from './dock-pages.js';
import type { DockHooks } from './dock-types.js';
import { paintedConfig } from './dock-wide-key.js';
import { ExtraKeyWidgets } from './extra-keys.js';

/** Create the widget scheduler once the dock has a device identity. */
export function startDockWidgets(
  driver: DockDriver,
  prefs: DockPrefs | undefined,
  model: () => DeviceModel,
  pages: DockPages,
  onPaint: DockHooks['widgetPaint'],
  yields: (wire: number, at: number) => boolean,
): ExtraKeyWidgets | null {
  if (!prefs) return null;
  const widgets = new ExtraKeyWidgets(
    driver,
    (wire) => paintedConfig(model(), prefs, wire, pages.layoutConfig(wire)),
    prefs.stripMode(),
    () => prefs.repaintMs(),
    onPaint,
    {
      tapFeedback: () => prefs.tapFeedback(),
      pixelShift: () => prefs.standby().pixelShift,
      yields,
    },
  );
  widgets.start();
  return widgets;
}
