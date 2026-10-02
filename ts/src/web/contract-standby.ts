// Standby & burn-in care wire DTOs (GET/POST /api/standby): third file of the
// web-contract leaf, split out of contract.ts for the line gate. Zero imports.

export type StandbyWakePress = 'swallow' | 'forward';
export type StandbyOffMode = 'auto' | 'brightness0';
export type StandbyAppGoneAction = 'none' | 'clock' | 'off';

export interface StandbySettings {
  idleDim: boolean; // default false
  idleMinutes: number; // integer 1..240, default 5 (also the night-off idle timeout)
  idleLevel: number; // integer 0..100, default 10
  offWhenIdle: boolean; // default false: second idle stage, screen off
  offMinutes: number; // integer 1..1440, default 30; > idleMinutes when idleDim is on
  offMode: StandbyOffMode; // default 'auto': hardware sleep where model.sleep, else brightness 0
  wakePress: StandbyWakePress; // default 'swallow'
  appGoneAction: StandbyAppGoneAction; // default 'none'
  clockLevel: number; // integer 0..100, default 20 (appGoneAction 'clock')
  night: boolean; // default false
  nightStart: string; // 'HH:MM' 00:00..23:59, default '23:00'
  nightEnd: string; // 'HH:MM', default '07:00'; must differ from nightStart
  nightLevel: number; // integer 0..100, default 10
  nightOffWhenIdle: boolean; // default true (only acts while night is on)
  pixelShift: boolean; // default false
  sleepCommand?: string; // settings.json only; non-empty string, at most 1024 chars
  wakeCommand?: string; // settings.json only; non-empty string, at most 1024 chars
}

/** GET/POST /api/standby payload for the selected dock. */
export interface StandbyView {
  dock: number;
  /** Without sleepCommand/wakeCommand (never sent to the browser). */
  settings: Omit<StandbySettings, 'sleepCommand' | 'wakeCommand'>;
  /** Local wall-clock time of the DeckBridge host, 'HH:MM': what the night window follows. */
  serverTime: string;
  /** The selected dock's model can hardware-sleep (model.sleep set). */
  canSleep: boolean;
  /** False on the browser deck: the panel hides the 'clock' choice. */
  canShowClock: boolean;
  /** True when settings.json holds a sleep/wake command (panel shows a read-only note). */
  hasCommands: boolean;
}
