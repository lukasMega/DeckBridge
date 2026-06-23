export const ELGATO_VID = 0x0fd9;
export const ELGATO_MK2_PID = 0x00a5;
export const ELGATO_TCP_PORT = 5343;
export const ELGATO_PKT_SIZE_RX = 1024;
export const ELGATO_PKT_SIZE_TX = 512;
export const ELGATO_CHILD_PORT = 5344;
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
// the CORA servers (5343/5344) to a single interface. WebUI is unaffected (always
// WEBUI_LISTEN_ADDRESS, localhost-only).
export const SERVER_LISTEN_ADDRESS =
  (typeof tjs !== 'undefined' ? tjs.env['DECKBRIDGE_BIND'] : undefined) ?? '0.0.0.0';

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
