// Info-window ("wide key") wire DTOs (GET/POST /api/wide-key): the Ulanzi D200's wide
// slot. Another file of the web-contract leaf, split out of contract.ts for the line
// gate. Zero imports.

/** What the window shows. 'widget' = a DeckBridge widget, 'elgato' = the Elgato app's images
 *  of the cells under the window; both are a mode-2 background image. */
export type WideKeyContent = 'clock' | 'dial' | 'stats' | 'widget' | 'elgato';
/** Firmware digital-clock variants (small-window modes 200..203). */
export type WideKeyClockMode = 200 | 201 | 202 | 203;
export type WideKeyHourFormat = '12H' | '24H';
/** Press routing: an Elgato cell, the DeckBridge extra-key action of the widget, or nothing. */
export type WideKeyPress = 'elgato-13' | 'elgato-14' | 'deckbridge' | 'none';
/** Which Elgato cells (MK.2 index 13 / 14) the window shows: both side by side, or one centred. */
export type WideKeyElgatoSource = 'both' | 'elgato-13' | 'elgato-14';
/** Under content 'widget': Elgato images are dropped, or shown until `overrideMs` passes
 *  with no new one (the AKP05 strip's 'deckbridge-repaint'). */
export type WideKeyElgatoImages = 'ignore' | 'override';

/** Persisted shape, per device. Settings may hold any subset; absent keys take the default. */
export interface WideKeyConfig {
  content: WideKeyContent; // default 'clock'
  clockMode?: WideKeyClockMode; // only for 'clock'; default 203
  hourFormat?: WideKeyHourFormat; // default '24H'
  press: WideKeyPress; // default 'none'
  statsPlugin?: string; // plugin file that overrides the built-in stats; absent = built-in
  elgatoSource?: WideKeyElgatoSource; // default 'both'
  elgatoImages?: WideKeyElgatoImages; // default 'ignore'
  overrideMs?: number; // 'override' hold-off; default 5000
}

/** A config with the defaults applied. */
export type ResolvedWideKey = Required<Omit<WideKeyConfig, 'statsPlugin'>> &
  Pick<WideKeyConfig, 'statsPlugin'>;

/** Whole percents 0-100: what the window's Stats content shows right now. */
export interface WideKeyLiveStats {
  cpu: number;
  mem: number;
  gpu: number;
}

/** GET/POST /api/wide-key payload for the selected dock. */
export interface WideKeyView {
  dock: number;
  config: ResolvedWideKey;
  /** The contents the selected model can show right now. */
  contents: readonly WideKeyContent[];
  /** The clock variants the selected model lists. */
  clockModes: readonly WideKeyClockMode[];
  /** The press routings on offer. */
  presses: readonly WideKeyPress[];
  /** Only while the window shows Stats on a connected device: the figures it was last sent. */
  stats?: WideKeyLiveStats;
}
