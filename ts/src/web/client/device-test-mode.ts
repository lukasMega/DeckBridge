import { getSnapshot } from './store.js';
import { showToast } from './ui-helpers.js';

/** Observer only: device commands and Elgato forwarding continue normally. */
export function showDeviceAction(action: { dockIndex: number; message: string }): void {
  const { deviceTestMode, status } = getSnapshot();
  if (deviceTestMode && action.dockIndex === (status.selectedDock ?? 0)) {
    showToast(action.message);
  }
}
