// Guard for POST /api/key/:n (click-to-press): a virtual press fires the user's real
// Elgato actions, so it is opt-in and only for a key that exists on the selected dock.
import type { DockStatus } from '../../shared/types.js';
import type { ReqError } from './types.js';

export const KEY_PRESS_DISABLED =
  'key press from the web UI is disabled (Settings → Click to press)';

export function checkKeyPress(
  enabled: boolean,
  dock: Pick<DockStatus, 'index' | 'keyCount'> | undefined,
  n: number,
): ReqError | { dock: number; index: number } {
  if (!enabled) return { status: 403, error: KEY_PRESS_DISABLED };
  if (!dock) return { status: 409, error: 'no dock is selected' };
  if (!Number.isInteger(n) || n < 0 || n >= dock.keyCount) {
    return { status: 400, error: `key index must be 0–${dock.keyCount - 1}` };
  }
  return { dock: dock.index, index: n };
}
