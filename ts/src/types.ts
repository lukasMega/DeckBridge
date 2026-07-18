export const ELGATO_VID = 0x0fd9;
export const ELGATO_MK2_PID = 0x00a5;
export const ELGATO_TCP_PORT = 5343;
export const ELGATO_PKT_SIZE_RX = 1024;
export const ELGATO_PKT_SIZE_TX = 512;
export const ELGATO_CHILD_PORT = 5344;
// Multi-device: extra docks use a fixed port stride off the primary pair, so
// session i listens on primary ELGATO_TCP_PORT+2i and child ELGATO_CHILD_PORT+2i.
export const CORA_PORT_STRIDE = 2;
// Session 0 (primary singleton) + up to 3 extra docks of distinct models.
export const MAX_DEVICE_SESSIONS = 4;
export const ELGATO_KEEPALIVE_MS = 2000;
export const ELGATO_IMAGE_HEADER_SIZE = 8;

export const NETWORK_DOCK_PID = 0xffff;

export const KEEPALIVE_PAYLOAD_SIZE = 32;

export const MAX_RECEIVE_BUFFER = 128 * 1024;

// Per-key cap on accumulated image-chunk bytes before the LAST flag arrives, see S4
export const MAX_IMAGE_ASSEMBLY_BYTES = 1024 * 1024;

// Default device identity strings
export const DEFAULT_DOCK_FIRMWARE_VERSION = '1.01.016';
export const DEFAULT_CHILD_FIRMWARE_VERSION = '1.01.000';
export const DEFAULT_DOCK_SERIAL_NUMBER = 'A7FZA5190ILSAA';
export const DEFAULT_CHILD_SERIAL_NUMBER = 'A7FZA5191ILSNQ';

// mDNS advertisement
export const MDNS_SERVICE_NAME = 'Network Stream Deck';
export const MDNS_SERVICE_TYPE = 'elg';
export const MDNS_PROTOCOL = 'tcp';
export const MDNS_TXT_DEVICE_TYPE = '215';
export const MDNS_TXT_VID = '4057';

// Capabilities packet structure
export const CHILD_CAPS_VERSION = 0x0200;
export const CHILD_CAPS_LAYOUT_TYPE = 0x02;
export const CHILD_CAPS_SERIAL_MAX_LEN = 30;
export const MANUFACTURER_STRING = 'Elgato';

// Feature report buffer sizes and offsets
export const SECONDARY_DETECT_RESPONSE_SIZE = 8;
export const FIRMWARE_REPORT_SIZE = 32;
export const SERIAL_REPORT_SIZE = 32;
export const DEVICE_INFO_REPORT_SIZE = 32;
export const DEVICE_INFO_VID_OFFSET = 2;
export const DEVICE_INFO_PID_OFFSET = 4;
export const FW_VERSION_FIELD_LEN = 8;
export const CORA_FW_VERSION_OFFSET = 8;
export const CORA_SERIAL_LEN_OFFSET = 3;
export const CORA_SERIAL_DATA_OFFSET = 4;

// Default MAC address for the dock (6 bytes, colon-separated hex string for UI)
export const DEFAULT_MAC_ADDRESS_STRING = '02:00:00:00:00:01';
export const DEFAULT_MAC_ADDRESS = [0x02, 0x00, 0x00, 0x00, 0x00, 0x01] as const;

// Key event packet layout
export const KEY_EVENT_RESERVED_BYTE = 0x00;
export const KEY_EVENT_STATE_OFFSET = 4;

// Mirabox protocol padding
export const BAT_PADDING_BYTES = 2;
export const LIG_PADDING_BYTES = 2;
export const CLE_PADDING_BYTES = 3;
export const HID_REPORT_ID_BYTE = 0x00;
export const CLEAR_ALL_KEYS = 0xff;
export const DEFAULT_BRIGHTNESS = 100;
export const DEFAULT_BRIGHTNESS_OVERRIDE = true;

// Image cache
export const IMAGE_CACHE_SIZE = 100;

// Image transform
export const IMAGE_JPEG_QUALITY = 0.9;

// Reconnect
export const RECONNECT_DELAY_MS = 2_000;

// WebUI server
export const WEBUI_PORT = 3000;
export const WEBUI_LISTEN_ADDRESS = '127.0.0.1';
export const SSE_KEEPALIVE_INTERVAL_MS = 30_000;
export const STATS_BROADCAST_INTERVAL_MS = 5_000;
export const KEY_EVENT_BUFFER_MAX = 50;
export const COMM_BUFFER_MAX = 500;
export const COMM_BROADCAST_FLUSH_MS = 100;
export const LOG_BUFFER_MAX = 500;
export const MOCK_FW_VERSION_MAX_LEN = 8;
export const MOCK_SERIAL_MAX_LEN = 20;
export const MOCK_PRODUCT_ID_MASK = 0xffff;

// Mock driver
export const MOCK_KEY_PRESS_DURATION_MS = 50;

// Image chunk layout
export const IMAGE_CHUNK_KEY_OFFSET = 2;
export const IMAGE_CHUNK_FLAG_OFFSET = 3;
export const IMAGE_CHUNK_LEN_OFFSET = 4;
export const IMAGE_CHUNK_LAST_FLAG = 1;

// Server listen address — override with DECKBRIDGE_BIND (e.g. "127.0.0.1") to restrict
// the CORA servers (5343/5344) to a single interface. WebUI honors the same override
// (see webuiBindAddr() below) — unset, it stays WEBUI_LISTEN_ADDRESS (localhost-only).
// A function, not a module-load constant: the CLI's --bind flag writes DECKBRIDGE_BIND
// into tjs.env from app.ts's body, which runs AFTER this module's imports (hence its
// top-level code) have already evaluated — a plain constant would freeze in the
// pre-flag value.
export function bindAddr(): string {
  return (typeof tjs !== 'undefined' ? tjs.env['DECKBRIDGE_BIND'] : undefined) ?? '0.0.0.0';
}

// WebUI listen address — same DECKBRIDGE_BIND override as bindAddr(), but defaults to
// WEBUI_LISTEN_ADDRESS (127.0.0.1) rather than 0.0.0.0: unset, the WebUI stays
// loopback-only exactly as before --bind existed; an explicit --bind (e.g. 0.0.0.0)
// exposes it on the LAN too, since on a headless box it's the only config surface.
export function webuiBindAddr(): string {
  return (
    (typeof tjs !== 'undefined' ? tjs.env['DECKBRIDGE_BIND'] : undefined) ?? WEBUI_LISTEN_ADDRESS
  );
}

// Active CORA client cannot be evicted by a newcomer within this window of its last
// received data, see S2. ELGATO_KEEPALIVE_MS (2s) means a live desktop sends data at
// least every ~2s; 10s tolerates ~5 missed keepalives before presuming the client dead.
export const CLIENT_EVICTION_GRACE_MS = 10_000;

// Keepalive packet offsets
export const KEEPALIVE_PKT_SEQ_OFFSET = 5;

// CORA HID operation codes
export const HID_OP_SEND_REPORT = 0x01;
export const HID_OP_GET_REPORT = 0x02;

// CORA feature report IDs (primary port)
export const FEATURE_KEEPALIVE_ACK = 0x1a;
export const FEATURE_GET_CAPABILITIES = 0x1c;
export const FEATURE_GET_DEVICE_INFO = 0x80;
export const FEATURE_GET_FW_LEGACY = 0x05;
export const FEATURE_GET_SERIAL_LEGACY = 0x06;
export const FEATURE_GET_DOCK_FW = 0x83;
export const FEATURE_GET_DOCK_SERIAL = 0x84;
export const FEATURE_GET_MAC = 0x85;
export const FEATURE_GET_CHILD_FW = 0x87;
export const FEATURE_GET_QUICK_PROBE = 0x8f;

// CORA event types (primary port, first byte of payload is always 0x01)
// Byte 1 is the event sub-type
export const PKT_EVENT = 0x01;
export const EVENT_SUBTYPE_KEEPALIVE = 0x0a;
export const EVENT_SUBTYPE_CAPABILITIES = 0x0b;

// CORA payload sub-commands (first byte)
export const PAYLOAD_TYPE_OUTPUT_REPORT = 0x02;
export const PAYLOAD_TYPE_FEATURE = 0x03;

// Image chunk sub-command (byte 1 when byte0 = 0x02)
export const IMG_CMD_WRITE = 0x07;

// Gen1 (Stream Deck Mini) image chunk constants
export const GEN1_IMG_CMD = 0x01; // byte[1] in gen1 output report
export const GEN1_IMAGE_HEADER_SIZE = 16;
export const GEN1_IMAGE_LAST_OFFSET = 4; // isLast (1 = last packet)
export const GEN1_IMAGE_KEY_OFFSET = 5; // keyIndex + 1 (1-based)

// Keepalive sub-type (byte 2 when byte0 = 0x01, byte1 = 0x0a)
export const KEEPALIVE_SUBTYPE = 0x02;

// Secondary port: report IDs for GET_REPORT
export const REPORT_BUTTON_STATE_INPUT = 0x01;
export const REPORT_FIRMWARE_VERSION = 0x05;
export const REPORT_SERIAL_NUMBER = 0x06;
export const REPORT_SECONDARY_DETECT = 0x08;
export const REPORT_DEVICE_INFO = 0x0b;

export type KeyState = 'down' | 'up';

// Which CORA client we detected on the current session — 'elgato' and
// 'bitfocus' are only set once a client-specific query is observed (see
// elgato-server.ts / elgato-child-server.ts), 'unknown' otherwise.
export type ClientApp = 'elgato' | 'bitfocus' | 'unknown';

export interface KeyEvent {
  keyIndex: number;
  state: KeyState;
}

export interface ImageEvent {
  keyIndex: number;
  data: Uint8Array; // holds JPEG (gen2) or BMP (gen1)
  format: 'jpeg' | 'bmp';
}

export interface CommEntry {
  ts: number;
  direction: 'rx' | 'tx';
  protocol: 'elgato' | 'mirabox';
  component: string;
  human: string;
  hex: string;
  totalBytes: number;
}

export interface LogObject {
  level: 'debug' | 'info' | 'warn' | 'error';
  component: string;
  message: string;
}

/** WebUI runtime override for image fit, applied on top of the model default.
 *  'resize' / 'pad-black' / 'pad-average' / 'pad-edge' force a fit mode;
 *  null = use the model's own resizeMode/padFill (see DeviceImageSpec). */
export type ImageModeOverride = 'resize' | 'pad-black' | 'pad-average' | 'pad-edge' | null;

// ── Extra keys (physical keys outside the emulated CORA grid) ──────────────
// 293S: the 6th column (wire ids 16/17/18) never maps to an MK.2 index, so
// DeckBridge binds its own actions to it. Config is persisted per device in
// settings.json (DeviceIdentitySettings.extraKeys, keyed by wire id).

// The extra keys are display-only (293S 6th column has no switches — verified
// on hardware 2026-07-16), so each is a small server-rendered widget, not an
// action trigger.
export const EXTRA_KEY_WIDGETS = [
  'none',
  'clock',
  'date',
  'text',
  'weather',
  'command',
  'plugin',
] as const;
export type ExtraKeyWidget = (typeof EXTRA_KEY_WIDGETS)[number];

/** Cap on the widget param (text content / weather "lat,lon" / shell command /
 *  plugin file name) and on the plugin per-key argument (pluginArg). */
export const EXTRA_KEY_PARAM_MAX = 128;

// Plugin widget: user JS run in an isolated Worker (see plugin-host.ts). Poll
// interval reuses ExtraKeyConfig.intervalMs as an override; the worker enforces
// the floor and default. Value strings are capped before rendering.
export const PLUGIN_INTERVAL_DEFAULT_MS = 5 * 1000;
export const PLUGIN_INTERVAL_MIN_MS = 1000;
export const PLUGIN_VALUE_MAX = 256;

// Command widget re-run interval / kill-timeout — user-configurable within
// these bounds (see extra-key-config popup), default when unset.
export const COMMAND_INTERVAL_DEFAULT_MS = 10 * 1000;
export const COMMAND_INTERVAL_MIN_MS = 1000;
export const COMMAND_INTERVAL_MAX_MS = 60 * 60 * 1000;
export const COMMAND_TIMEOUT_DEFAULT_MS = 5 * 1000;
export const COMMAND_TIMEOUT_MIN_MS = 1000;
export const COMMAND_TIMEOUT_MAX_MS = 60 * 1000;

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
}

const inRange = (n: number, min: number, max: number): boolean => n >= min && n <= max;

/** Shape guard for one persisted/imported extra-key entry. */
// oxlint-disable-next-line complexity
export function isExtraKeyConfig(v: unknown): v is ExtraKeyConfig {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.widget === 'string' &&
    (EXTRA_KEY_WIDGETS as readonly string[]).includes(r.widget) &&
    (r.param === undefined ||
      (typeof r.param === 'string' && r.param.length <= EXTRA_KEY_PARAM_MAX)) &&
    (r.intervalMs === undefined ||
      (typeof r.intervalMs === 'number' &&
        inRange(r.intervalMs, COMMAND_INTERVAL_MIN_MS, COMMAND_INTERVAL_MAX_MS))) &&
    (r.timeoutMs === undefined ||
      (typeof r.timeoutMs === 'number' &&
        inRange(r.timeoutMs, COMMAND_TIMEOUT_MIN_MS, COMMAND_TIMEOUT_MAX_MS))) &&
    (r.pluginArg === undefined ||
      (typeof r.pluginArg === 'string' && r.pluginArg.length <= EXTRA_KEY_PARAM_MAX))
  );
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
  // Device wire ids of physical keys outside the emulated CORA grid (293S 6th
  // column). Present only when the model has any — the WebUI renders the
  // extra-keys panel off this.
  extraKeys?: readonly number[];
}
