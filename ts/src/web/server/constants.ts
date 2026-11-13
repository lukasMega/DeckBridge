// WebUI server tunables: WS timers, ring-buffer caps, mock-config bounds.

export const WS_KEEPALIVE_INTERVAL_MS = 30_000;
export const STATS_BROADCAST_INTERVAL_MS = 5_000;
export const KEY_EVENT_BUFFER_MAX = 50;
export const COMM_BUFFER_MAX = 500;
export const COMM_BROADCAST_FLUSH_MS = 100;
export const LOG_BUFFER_MAX = 500;
export const MOCK_FW_VERSION_MAX_LEN = 8;
export const MOCK_SERIAL_MAX_LEN = 20;
export const MOCK_PRODUCT_ID_MASK = 0xffff;
