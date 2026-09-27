// Mock-driver event wiring, split out of driver-manager.ts. Mirrors
// attachRealDriverListeners, minus the wire→mk2 key mapping: the mock already
// emits mk2 indices for grid keys and image wire ids for extra keys.
import type { MockDriver } from '../devices/mock.js';
import type { DialEvent, KeyEvent, KeyState, TouchInputEvent } from '../shared/types.js';
import type { ElgatoChildServer } from '../cora/child-server.js';
import type { WebUIServer } from '../web/server/index.js';
import type { PrimaryDock } from './driver-manager-primary.js';
import { dialActionText, touchActionText } from './device-session-status.js';

export interface MockSinks {
  primary: PrimaryDock;
  childServer: Pick<ElgatoChildServer, 'sendKeyEvent' | 'sendDial' | 'sendTouch'>;
  webui: Pick<WebUIServer, 'notifyKeyEvent' | 'notifyDeviceAction'>;
}

export function wireMockDriver(
  driver: MockDriver,
  { primary, childServer, webui }: MockSinks,
): void {
  driver.on('key', (e: KeyEvent) => {
    childServer.sendKeyEvent(e.keyIndex, e.state);
    webui.notifyKeyEvent(e.keyIndex, e.state);
  });
  driver.on('extraKey', ({ wireId, state }: { wireId: number; state: KeyState }) => {
    webui.notifyDeviceAction(0, `Extra key ${wireId} ${state === 'down' ? 'pressed' : 'released'}`);
    primary.handleExtraKey(wireId, state);
  });
  driver.on('dial', (e: DialEvent) => {
    webui.notifyDeviceAction(0, dialActionText(e));
    if (!primary.handleDial(e)) childServer.sendDial(e);
  });
  driver.on('touch', (e: TouchInputEvent) => {
    webui.notifyDeviceAction(0, touchActionText(e, driver.model));
    if (!primary.handleTouch(e)) childServer.sendTouch(e);
  });
}
