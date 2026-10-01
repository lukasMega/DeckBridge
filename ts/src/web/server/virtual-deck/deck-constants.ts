// Browser deck tunables. See .claude/plans/2026-09-30_virtual-browser-deck.md (D-D, D-E).

/** `hello.v` must equal this; the page carries its own copy (G1 forbids sharing). */
export const DECK_PROTOCOL_VERSION = 1;
/** Binary frames sent but not yet acked, per session. */
export const DECK_MAX_IN_FLIGHT = 6;
export const DECK_MAX_CLIENTS = 4;
/** No message at all for this long drops the session and releases its held keys. */
export const DECK_LIVENESS_TIMEOUT_MS = 3500;
export const DECK_HELLO_TIMEOUT_MS = 3000;
/** A `down` this far behind the session's best-case latency is dropped, never delivered late. */
export const DECK_MAX_DOWN_LATENESS_MS = 1000;
export const DECK_MAX_TEXT_BYTES = 1024;
export const DECK_MAX_MSGS_PER_S = 60;
export const DECK_TICK_MS = 1000;
/** Paired browsers; the rest of ACCESS_TOKENS_MAX stays free for push tokens. */
export const DECK_DEVICES_MAX = 8;
export const DECK_DEVICE_NAME_MAX = 40;

export const PAIRING_TTL_MS = 300_000;
export const PAIRING_MAX_FAILS = 5;

/** Offset samples are kept per bucket for this long (clock drift cannot accumulate). */
export const FRESHNESS_BUCKET_MS = 10_000;
export const FRESHNESS_WINDOW_MS = 60_000;
export const LATENCY_WINDOW_SIZE = 200;
