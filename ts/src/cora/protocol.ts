// CORA wire constants: packet sizes, report ids, and payload offsets the
// primary/child servers speak. Protocol facts only — no runtime state.

export const ELGATO_VID = 0x0fd9;
export const ELGATO_PKT_SIZE_RX = 1024;
export const ELGATO_PKT_SIZE_TX = 512;
export const ELGATO_KEEPALIVE_MS = 2000;
export const ELGATO_IMAGE_HEADER_SIZE = 8;

export const NETWORK_DOCK_PID = 0xffff;

export const KEEPALIVE_PAYLOAD_SIZE = 32;

export const MAX_RECEIVE_BUFFER = 128 * 1024;

// Per-key cap on accumulated image-chunk bytes before the LAST flag arrives, see S4
export const MAX_IMAGE_ASSEMBLY_BYTES = 1024 * 1024;
export const MAX_IMAGE_ASSEMBLY_CHUNKS = 4096;
/** Across every in-flight assembly of one connection, so many keys cannot each sit
 *  just under the per-key cap. */
export const MAX_TOTAL_ASSEMBLY_BYTES = 8 * 1024 * 1024;
/** An incomplete assembly untouched this long is abandoned on the next new assembly. */
export const ASSEMBLY_STALE_MS = 30_000;

// Capabilities packet structure
export const CHILD_CAPS_VERSION = 0x0200;
export const CHILD_CAPS_LAYOUT_TYPE = 0x02;
export const CHILD_CAPS_SERIAL_MAX_LEN = 30;
export const MANUFACTURER_STRING = 'Elgato';

// Feature report buffer sizes and offsets
export const SECONDARY_DETECT_RESPONSE_SIZE = 8;
export const SERIAL_REPORT_SIZE = 32;
export const DEVICE_INFO_REPORT_SIZE = 32;
export const DEVICE_INFO_VID_OFFSET = 2;
export const DEVICE_INFO_PID_OFFSET = 4;
export const FW_VERSION_FIELD_LEN = 8;
export const CORA_FW_VERSION_OFFSET = 8;
export const CORA_SERIAL_LEN_OFFSET = 3;
export const CORA_SERIAL_DATA_OFFSET = 4;

// Key event packet layout
export const KEY_EVENT_STATE_OFFSET = 4;

// Reconnect
export const RECONNECT_DELAY_MS = 2_000;

// Image chunk layout
export const IMAGE_CHUNK_KEY_OFFSET = 2;
export const IMAGE_CHUNK_FLAG_OFFSET = 3;
export const IMAGE_CHUNK_LEN_OFFSET = 4;
export const IMAGE_CHUNK_LAST_FLAG = 1;

// Stream Deck + partial-window (0x0C) chunk header — one JPEG region of the 800×100
// touch window, split across chunks that each repeat the region rectangle.
export const PARTIAL_WINDOW_HEADER_SIZE = 16;
export const PARTIAL_WINDOW_X_OFFSET = 2;
export const PARTIAL_WINDOW_Y_OFFSET = 4;
export const PARTIAL_WINDOW_W_OFFSET = 6;
export const PARTIAL_WINDOW_H_OFFSET = 8;
export const PARTIAL_WINDOW_LAST_OFFSET = 10;
export const PARTIAL_WINDOW_SIZE_OFFSET = 13;

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

// Stream Deck + output-report image commands (byte 1 when byte0 = 0x02). Routing
// only — see cora/child-payload.ts; the 0x0B/0x0C chunk layouts are UNVERIFIED.
export const IMG_CMD_LCD = 0x08; // full 800×480 LCD
export const IMG_CMD_WINDOW = 0x0b; // window strip 800×100
export const IMG_CMD_WINDOW_PARTIAL = 0x0c; // partial window (X/Y/W/H header)

// Input report sub-types (byte 1 of the 0x01 input report the child server emits).
export const INPUT_SUBTYPE_BUTTONS = 0x00;
export const INPUT_SUBTYPE_TOUCH = 0x02;
export const INPUT_SUBTYPE_ENCODER = 0x03;

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
