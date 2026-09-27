// WebUI wire contract: the `web-contract` leaf — DTOs sent over `/api/*` or the
// WS broadcast, nothing else. Zero imports, type-only edge, both tiers re-export
// from here. See "Architecture is lint-enforced" in CLAUDE.md.

/** 'elgato'/'bitfocus' are set only once a client-specific query is observed
 *  (cora/primary-server.ts / cora/child-server.ts), 'unknown' otherwise. */
export type ClientApp = 'elgato' | 'bitfocus' | 'unknown';

export type KeyState = 'down' | 'up';

/** One extra key's display-widget assignment. `types.ts` holds the runtime
 *  `EXTRA_KEY_WIDGETS` list and proves it against this union with `satisfies`. */
export type ExtraKeyWidget = 'none' | 'clock' | 'date' | 'text' | 'weather' | 'command' | 'plugin';

/** What pressing an extra key with a switch does: refresh its widget, run its press
 *  command, or both. Absent = 'command' when a press command is set, else 'refresh'.
 *  `types.ts` holds the runtime `EXTRA_KEY_PRESS_ACTIONS` list. */
export type ExtraKeyPressAction = 'refresh' | 'command' | 'both';

/** Widget text size: a step on the font ladder relative to each line's default
 *  (0 = default), or 'fit' = the largest step that shows everything.
 *  `types.ts` holds the runtime `EXTRA_KEY_TEXT_SIZES` list. */
export type ExtraKeyTextSize = 'fit' | -2 | -1 | 0 | 1 | 2;

/** How a free-text widget splits a line too wide for the display: at spaces (an
 *  over-long word is split mid-word) or at any character. Absent = no wrapping. */
export type ExtraKeyWrap = 'words' | 'chars';

/** Widget font family: Spleen (monospace) or X11 Helvetica (proportional, narrower). */
export type ExtraKeyFont = 'regular' | 'narrow';
export type ExtraKeyAlign = 'left' | 'center' | 'right';
export type ExtraKeyVAlign = 'top' | 'middle' | 'bottom';

/** How a widget's text is drawn. Every field optional; absent = default, and defaults
 *  are never persisted. Bounds + guard: extra-key-config.ts (`textStyleError`). */
export interface ExtraKeyTextStyle {
  textSize?: ExtraKeyTextSize; // default 0
  wrap?: ExtraKeyWrap; // default off; free-text widgets only
  font?: ExtraKeyFont; // default 'regular'
  color?: string; // '#rrggbb', default '#e8e8ec'
  background?: string; // '#rrggbb', default '#101014'
  align?: ExtraKeyAlign; // default 'center'
  valign?: ExtraKeyVAlign; // default 'middle'
  padding?: number; // px each side, 0..16, default 0
  lineGap?: number; // px between rows, 0..8, default 0
  bold?: boolean; // default false
  outline?: string; // '#rrggbb' 1-px outline colour; absent = none
  ellipsis?: boolean; // default true — stored only when false
}

/** Who paints the touch strip (AKP05E). `elgato` = the app only; `deckbridge-ignore`
 *  = DeckBridge widgets, Elgato strip images dropped; `deckbridge-repaint` = DeckBridge
 *  widgets on assigned zones, Elgato content on the rest. `types.ts` holds the runtime
 *  `TOUCH_STRIP_MODES` list. */
export type TouchStripMode = 'elgato' | 'deckbridge-ignore' | 'deckbridge-repaint';

/** WS `extraKeyImage`: one side key's widget image as base64 BMP; no data = cleared
 *  (side key) or a status-only update (touch-strip `zone`, whose image is not mirrored). */
export interface ExtraKeyImageMsg {
  wireId: number;
  data?: string;
  /** The widget text did not fit at its text size. */
  clipped?: boolean;
  zone?: boolean;
}

/** WS `stripWrite`: one touch-strip upload as it reached the device (base64 JPEG);
 *  `full` = the whole strip, `clear` = drop the dock's mirror. */
export type StripWriteMsg = { clear: true } | { wireId: number; data: string; full?: true };

/** One touch-strip widget display, as the WebUI needs it to place device writes. */
export interface WidgetDisplayInfo {
  wireId: number;
  label: string;
  /** Device image size of this display (AKP05E slot: 176×112). */
  width: number;
  height: number;
  /** Left edge on the full strip, in device strip pixels; absent = no full-strip surface. */
  stripX?: number;
  /** Device orientation applied to every strip upload; the preview undoes it. */
  rotate: 0 | 90 | 180 | 270;
  flipH: boolean;
  flipV: boolean;
}

/** One size option rendered by POST /api/extra-key/preview. */
export interface ExtraKeyPreview {
  textSize: ExtraKeyTextSize;
  /** base64 BMP */
  data: string;
  clipped: boolean;
}

export interface ExtraKeyPreviewResponse {
  wireId: number;
  previews: ExtraKeyPreview[];
}

/** Shell commands one rotary encoder runs when disconnected from the Elgato app. */
export interface EncoderCommands {
  press?: string;
  rotateCw?: string;
  rotateCcw?: string;
}

/** Encoder override — only honored while the strip is in a `deckbridge-*` mode.
 *  `commands` is keyed by encoder index ('0'..'3'). */
export interface EncoderSettings {
  /** Default true = forward knob events to the Elgato app. */
  connectToApp?: boolean;
  commands?: Record<string, EncoderCommands>;
}

/** Live status of one plugin-widget key (see plugin-host.ts). */
export type PluginStatus = 'pending' | 'ok' | 'err' | 'disabled';

/** GET /api/plugins: the plugins dir (empty-state hint), the *.js files found
 *  there (dropdown), and each plugin key's live status, keyed by wire id. */
export interface PluginsInfo {
  dir: string;
  files: string[];
  status: Record<string, PluginStatus>;
}

export interface Stats {
  uptimeMs: number;
  elgatoRxPkts: number;
  elgatoTxPkts: number;
  imagesSent: number;
}

export interface MockDeviceConfig {
  dockFirmwareVersion: string;
  childFirmwareVersion: string;
  serialNumber: string;
  childSerialNumber: string;
  productId: number;
  macAddress: string;
}

/** Identifiers actually sent to the Elgato app (mDNS + CORA device-info frames)
 *  for the active device: `mockConfig` while driverMode is 'mock', the real
 *  dock's fixed identity otherwise. Read-only, shown under Settings. */
export interface DeviceIdentity extends MockDeviceConfig {
  mdnsServiceName: string;
  // Present only for a real (non-mock) dock with a persisted identity — lets
  // the WebUI edit mdnsServiceName via POST /api/device-identity/mdns-name.
  deviceKey?: string;
}

/** Identity reported by the physical USB device. Absent in mock mode. */
export interface RealDeviceIdentity {
  modelName: string;
  serialNumber?: string;
  firmwareVersion?: string;
}

export interface KeyEventEntry {
  ts: number;
  mk2Index: number;
  state: KeyState;
  /** Raw wire id, pre-keyMap; absent for identity-mapped models and in mock mode.
   *  Key-map learn mode needs it: a wrong map is the thing being fixed, so the
   *  mapped index alone can't derive `wireInputToCora`. */
  wireId?: number;
}

export interface DeviceModelInfo {
  id: string;
  name: string;
  keyCount: number;
}

/** GET /api/update / POST /api/update/check reply, and the `update` WS
 *  broadcast payload — see update-check.ts. */
export interface UpdateInfo {
  enabled: boolean;
  current: string;
  latest?: string;
  updateAvailable: boolean;
  releaseUrl?: string;
  lastCheckedAt?: number;
  dismissedVersion?: string;
  error?: 'no-curl' | 'network' | 'parse';
}

/** GET /api/state's `elgatoAutoRestart` field, and the POST /api/elgato-auto-restart
 *  reply — see infra/elgato-app.ts §4.4. `supported` is false on Linux (no Elgato
 *  app build), where the WebUI shows a note and disables the controls. */
export interface ElgatoAutoRestartState {
  enabled: boolean;
  delayS: number;
  supported: boolean;
}

/** Server log level; `silent` never reaches the wire. */
export type WireLogLevel = 'debug' | 'info' | 'warn' | 'error';

export type DriverMode = 'real' | 'mock';

export interface LogEntry {
  ts: number;
  level: WireLogLevel;
  component: string;
  message: string;
}

/** One CORA/USB wire-trace line (Advanced view comm console). */
export interface CommEntry {
  ts: number;
  direction: 'rx' | 'tx';
  protocol: 'elgato' | 'mirabox';
  component: string;
  human: string;
  hex: string;
  totalBytes: number;
}

/** One extra key's widget assignment, keyed by device wire id in settings and on the wire. */
export interface ExtraKeyConfig {
  widget: ExtraKeyWidget;
  /** text: the content to show; weather: "lat,lon"; command: the shell command;
   *  plugin: the plugin file name (in the plugins dir). */
  param?: string;
  /** command/plugin widget: how often (ms) to re-run/poll. Command default
   *  COMMAND_INTERVAL_DEFAULT_MS; plugin default PLUGIN_INTERVAL_DEFAULT_MS. */
  intervalMs?: number;
  /** command widget only: kill the process after this many ms. Default COMMAND_TIMEOUT_DEFAULT_MS. */
  timeoutMs?: number;
  /** plugin widget only: the per-key argument passed to the plugin (ctx.param). */
  pluginArg?: string;
  /** How the text is drawn (size, wrap, font, colours, …); only non-defaults stored. */
  style?: ExtraKeyTextStyle;
  /** Shell command run on press — only extra keys with a switch
   *  (keyMap.extraKeyInputs). Independent of the widget, so kept across widget changes. */
  pressCommand?: string;
  /** What a press does (pressable keys only) — see effectivePressAction. Part of the
   *  press side like pressCommand, so also kept across widget changes. */
  pressAction?: ExtraKeyPressAction;
}

/** One dock's status as shown in the WebUI (primary index 0 + extras). */
export interface DockStatus {
  index: number; // 0 = primary
  modelId: string;
  modelName: string;
  keyCount: number;
  columns: number;
  rows: number;
  primaryPort: number; // the port the user enters in the Elgato app
  primaryConnected: boolean; // primary (Network Dock) CORA client attached = app discovered us
  elgatoConnected: boolean; // child CORA client attached = paired & active
  brightness: number; // last level applied to this dock's panel (0-100)
  // The identifiers this dock actually sends to the Elgato app (mDNS advert +
  // CORA device-info/capabilities frames) — shown read-only under Settings,
  // per-dock so a multi-device setup shows the currently selected dock's own
  // identity rather than always the primary's.
  dockFirmwareVersion: string;
  childFirmwareVersion: string;
  serialNumber: string;
  childSerialNumber: string;
  productId: number;
  macAddress: string;
  mdnsServiceName: string;
  // Stable per-physical-device key (see device-identity.ts) this dock's
  // identity was generated/looked-up from. Empty for mock-mode docks, which
  // have no persisted identity. Used by the WebUI to edit mdnsServiceName.
  deviceKey: string;
  // Identity reported by the physical USB device. Absent in mock mode.
  realDeviceIdentity?: RealDeviceIdentity;
  // Device wire ids of physical keys outside the emulated CORA grid (293S 6th
  // column). Present only when the model has any — the WebUI renders the
  // extra-keys panel off this.
  extraKeys?: readonly number[];
  /** The `extraKeys` that have a switch (AKP05E right column as a Stream Deck +) —
   *  the WebUI offers a press command only on these. */
  pressableExtraKeys?: readonly number[];
  /** Device-native widget displays outside CORA's key grid, such as AKP05E's touch strip. */
  widgetDisplays?: readonly WidgetDisplayInfo[];
  /** Physical rotary encoders (AKP05/AKP05E: 4) — the WebUI's knob-override rows. */
  encoderCount?: number;
  /** CORA profile this dock re-pairs as (`cora.advertiseAs`, e.g. AKP05E → 'stream-deck-plus').
   *  The desktop's image orientation follows the profile, so the WebUI preview needs it. */
  coraProfile?: string;
  /** Advertised touch-strip size (Plus profile: 800×100) — the WebUI strip preview canvas. */
  touchStripSize?: TouchStripSize;
}

export interface TouchStripSize {
  width: number;
  height: number;
}

export interface StatusSnapshot {
  driverMode: DriverMode;
  driverConnected: boolean;
  elgatoConnected: boolean;
  elgatoRemoteAddr: string | null;
  clientApp: ClientApp;
  brightness: number;
  modelId: string;
  modelName: string;
  keyCount: number;
  columns: number;
  rows: number;
  /** True when the Elgato desktop app is running AND we do not hold the device —
   *  i.e. it is plausibly blocking us. NOT "the Elgato app is running": while
   *  DeckBridge is connected this is always false, app running or not. */
  elgatoAppConflict: boolean;
  /** True when an Elgato-branded device (MK.2/Mini) is enumerated on USB —
   *  independent of whether we could open it. Gates the "Elgato app is
   *  blocking access" screen so it doesn't fire for non-Elgato hardware. */
  elgatoDevicePresent: boolean;
  localIp: string;
  docks: DockStatus[];
  selectedDock: number;
}

/** GET /api/state: the status snapshot plus everything a freshly loaded page needs.
 *  Key images are not in it — a new WS client is sent the selected dock's frames. */
export interface StateResponse extends StatusSnapshot {
  // Omitted from the wire payload in simple-only builds — see state-response.ts.
  logs?: LogEntry[];
  commLogs?: CommEntry[];
  keyEvents: KeyEventEntry[];
  stats: Stats;
  mockConfig: MockDeviceConfig;
  brightnessOverride: boolean;
  deviceModels: DeviceModelInfo[];
  deviceIdentity: DeviceIdentity;
  realDeviceIdentity?: RealDeviceIdentity;
  // The SELECTED dock's extra-key assignments, keyed by device wire id.
  extraKeys: Record<string, ExtraKeyConfig>;
  /** The SELECTED dock's touch-strip mode + knob override (AKP05E). */
  touchStripMode: TouchStripMode;
  touchStripRepaintMs: number;
  encoders: EncoderSettings;
  /** Log level currently in effect (not merely the persisted one) + where the
   *  log file lives — both surfaced under Settings so a reporter can turn on
   *  debug logging and find the file. */
  logLevel: string;
  logFilePath: string;
  /** Multi-deck opt-in (settings.json `multiDeck`). Read once per Settings-page
   *  mount, like logLevel — it is not in the status snapshot. */
  multiDeck: boolean;
  /** GitHub-release update check (update-check.ts) — cached, no network. */
  updateInfo: UpdateInfo;
  /** Elgato-app auto-restart opt-out + grace delay (settings.json
   *  `elgatoAutoRestart`/`elgatoAutoRestartDelayS`) — read once per Settings-page
   *  mount, like `updateInfo`. */
  elgatoAutoRestart: ElgatoAutoRestartState;
}

// Device tuning (GET /api/device-overrides). The server's DeviceModelOverride
// (devices/driver.ts) must stay assignable to these wire shapes.

export interface TuningCropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TuningImage {
  rotate?: 0 | 90 | 180 | 270;
  flipH?: boolean;
  flipV?: boolean;
  width?: number;
  height?: number;
  quality?: number;
  maxBytes?: number;
  blur?: number;
  sharpen?: number;
  crop?: number;
  /** Partial while the form is being edited; the server rejects an incomplete rect. */
  cropRect?: Partial<TuningCropRect>;
  resizeFilter?: 'triangle' | 'nearest' | 'lanczos3';
  resizeMode?: 'resize' | 'pad' | 'crop';
  padFill?: 'black' | 'average' | 'edge';
  transform?: 'passthrough' | 'sidecar';
}

/** `effective.image`: every tunable field, plus the protocol facts the device
 *  reports but no override may set. */
export interface EffectiveTuningImage extends TuningImage {
  format?: 'jpeg' | 'bmp';
  colorMode?: 'rgb' | 'bgr';
  bmpPpm?: number;
}

export interface TuningKeyMap {
  coraToWireImage?: readonly number[];
  wireInputToCora?: readonly number[];
  inputOffset?: number;
  imageOffset?: number;
  extraKeys?: readonly number[];
}

export interface TuningCora {
  advertiseAs?: string;
  productId?: number;
}

/** Every wire field is sent; the WebUI only reads and sets this one. */
export type TuningWire = { batchImageTransfers?: boolean; [key: string]: unknown };

export interface TuningOverride {
  image?: TuningImage;
  keyMap?: TuningKeyMap;
  wire?: TuningWire;
  splash?: unknown;
  cora?: TuningCora;
}

/** A CORA emulation profile the device may re-pair as (from CORA_PROFILES). */
export interface EmulationProfile {
  id: string;
  name: string;
  productId: number;
}

/** GET /api/device-overrides payload: the registry values (`defaults`), what the
 *  user has set (`overrides`), what the device is actually running (`effective`),
 *  and the form seed (`tunable`). */
export interface DeviceOverridesView {
  modelId: string;
  modelName: string;
  defaults: TuningOverride;
  overrides: TuningOverride;
  /** True in safe mode (`--no-overrides`): `overrides` is still persisted (so
   *  Reset works) but `effective` equals the registry defaults, because that is
   *  what the device is actually running. */
  safeMode: boolean;
  /** The FULL effective spec — for display/diagnostics. Do NOT seed the form from this: it
   *  carries the non-tunable protocol facts (`format`, `colorMode`, `bmpPpm`) too, and
   *  POSTing them straight back is rejected. Seed from `tunable` instead. */
  effective: { image: EffectiveTuningImage; keyMap: TuningKeyMap } & Omit<
    TuningOverride,
    'image' | 'keyMap'
  >;
  /** `effective`, projected down to exactly the fields an override may set — so a
   *  round-trip (seed the form → Apply unchanged) is always valid. */
  tunable: TuningOverride;
  /** CORA profiles this model may re-pair as (its `cora.emulations`), with their PID. */
  profiles: EmulationProfile[];
  /** Key image size the Elgato app sends (the advertised model's key size) — what
   *  the transform fits into `effective.image` width×height. */
  sourceSize: { width: number; height: number };
}

/** WS `image`: one key of the selected dock, base64. */
export interface KeyImageMsg {
  mk2Index: number;
  data: string;
  format: 'jpeg' | 'bmp';
}

/** WS `touchImage`: a Stream Deck + strip frame (base64 JPEG); no region = the full strip. */
export interface TouchImageMsg {
  data: string;
  region?: { x: number; y: number; w: number; h: number };
}

/** Every WS broadcast: event name → payload. Server `broadcast<K>` and the client
 *  handler table are both keyed by this map, so neither side can drift. */
/** Typed WS send: the payload must match its event. */
export type WsBroadcast = <K extends keyof WsEvents>(event: K, data: WsEvents[K]) => void;

export interface WsEvents {
  status: StatusSnapshot;
  image: KeyImageMsg;
  /** The selected dock's frames were dropped (model change / disconnect). */
  imagesReset: Record<string, never>;
  touchImage: TouchImageMsg;
  stripWrite: StripWriteMsg;
  extraKeyImage: ExtraKeyImageMsg;
  brightness: { level: number };
  brightnessOverride: { enabled: boolean };
  extraKeys: { configs: Record<string, ExtraKeyConfig> };
  touchStripMode: { mode: TouchStripMode };
  touchStripRepaint: { ms: number };
  encoders: { encoders: EncoderSettings };
  deviceAction: { dockIndex: number; message: string };
  keyEvent: KeyEventEntry;
  logBatch: LogEntry[];
  commBatch: CommEntry[];
  stats: Stats;
  mockConfig: MockDeviceConfig;
  update: UpdateInfo;
}
