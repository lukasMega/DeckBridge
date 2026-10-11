// Types a Dock exchanges with its owner; split from dock.ts to keep it under the
// line limit.
import type { DockStatus, KeyState, TouchWindowRegion } from '../shared/types.js';
import type { WidgetPaint } from '../shared/widget-layout.js';
import type { PageObservation } from '../shared/page-match.js';
import type { DeviceModel } from '../devices/driver.js';
import type { PersistedSettings } from '../infra/settings.js';
import type { CoraDock } from './cora-dock.js';
import type { ImageFormat } from './dock-frames.js';
import type { DeviceInfo, DockIdentity } from './dock-status.js';
import type { StandbyInput } from './dock-standby.js';
import type { StandbyClock, StandbyTiming } from './standby-policy.js';

/** Where a dock reports out. All optional: a dock without a WebUI mirror just runs. */
export interface DockHooks {
  /** Status may have changed (brightness, identity, pairing, start/stop). */
  changed?: () => void;
  /** The attached USB driver reported an unplug. */
  disconnect?: () => void;
  /** Grid key press (activity feed + key-map learn mode). */
  key?: (mk2Index: number, state: KeyState, wireId?: number) => void;
  action?: (message: string) => void;
  image?: (key: number, data: Buffer, format: ImageFormat) => void;
  touchImage?: (data: Uint8Array, region?: TouchWindowRegion) => void;
  widgetPaint?: (wireId: number, paint: WidgetPaint | null) => void;
  stripWrite?: (wireId: number, jpeg: Uint8Array, full: boolean) => void;
  /** The Elgato app set a brightness this dock applied (WebUI slider). */
  brightness?: (level: number) => void;
  /** A key image was transformed and its device write dispatched; `cached` = LRU hit. */
  imageSent?: (keyIndex: number, cached: boolean) => void;
  /** A driver was attached; mock = the mock driver. */
  attached?: (mock: boolean) => void;
  /** Every device input, before standby/knob routing (Statistics). */
  input?: (input: StandbyInput) => void;
  /** The Elgato app's child client attached (after markPaired). */
  elgatoAttached?: () => void;
  /** The Elgato page recognition changed (the WebUI mirrors it). */
  pageObservation?: (obs: PageObservation) => void;
}

export type DockSettings = Pick<PersistedSettings, 'for' | 'getOrCreateIdentity' | 'markPaired'>;

export interface DockOptions {
  index: number;
  cora: CoraDock;
  /** CORA TCP ports: status + the bind-conflict message. */
  ports: { primary: number; child: number };
  settings: DockSettings;
  /** Known up front for a dock built around one USB unit; else resolveIdentity(). */
  identity?: DockIdentity;
  model?: DeviceModel;
  deviceInfo?: DeviceInfo;
  hooks?: DockHooks;
  getShuttingDown?: () => boolean;
  /** Extra status fields only this dock knows (the browser deck's connected pages). */
  statusExtra?: () => Partial<DockStatus>;
  /** Test seams for the standby timers; production passes neither. */
  standbyClock?: StandbyClock;
  standbyTiming?: StandbyTiming;
}
