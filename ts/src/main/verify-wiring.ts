// Verify wizard (web/server/verify-controller.ts) → the docks: hold, test-pattern paints and
// live draft applies. The draft itself reaches the docks through DriverManager.overrideFor.
import { log } from '../shared/logger.js';
import type { WebUIServer } from '../web/server/index.js';
import type { VerifyPaintKey } from '../web/server/verify-controller.js';
import type { DriverManager } from './driver-manager.js';

export function wireVerify(
  webui: Pick<WebUIServer, 'verify' | 'on'>,
  driverManager: Pick<DriverManager, 'dock' | 'reloadDeviceTuning'>,
): void {
  webui.verify.configure({
    hasAppFrames: (index) => driverManager.dock(index)?.hasAppFrames() ?? false,
  });
  webui.on('verifyHold', (index: number, on: boolean, repaint: boolean) => {
    driverManager.dock(index)?.setVerifyHold(on, repaint);
  });
  webui.on('verifyPaint', (index: number, keys: readonly VerifyPaintKey[]) => {
    const dock = driverManager.dock(index);
    for (const { key, bytes } of keys) dock?.paintVerify(key, bytes);
  });
  // A draft is image-only, so it always swaps live.
  webui.on('verifyDraft', (modelId: string) => {
    driverManager.reloadDeviceTuning(modelId, 'live').catch((err: unknown) => {
      log('error', 'verify', `draft apply (${modelId}) failed: ${(err as Error).message}`);
    });
  });
}
