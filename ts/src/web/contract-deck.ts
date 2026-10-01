// Browser deck wire contract: the phone page's WebSocket messages and the admin panel's DTOs.
// Zero-import leaf like contract.ts; both tiers import it type-only, so the protocol
// version number (`hello.v`) lives in each tier's own constants.

export interface DeckLayout {
  profile: string;
  columns: number;
  rows: number;
  keyCount: number;
  /** CSS rotation the page applies to key images (CORA MK.2 images arrive pre-rotated). */
  rotate: 0 | 180;
}

/** Client → server, JSON text, each ≤ 1024 bytes. `now` is the client's performance.now(). */
export type DeckClientMsg =
  | { t: 'hello'; v: number; token: string; clientId: string; now: number; name?: string }
  | { t: 'key'; k: number; s: 'down' | 'up'; now: number }
  | { t: 'releaseAll'; now: number }
  | { t: 'ping'; now: number }
  /** Cumulative count of binary frames received. */
  | { t: 'ack'; n: number };

export type DeckByeReason =
  | 'unauthorized'
  | 'revoked'
  | 'disabled'
  | 'full'
  | 'upgrade'
  | 'timeout'
  | 'protocol';

/** Server → client JSON text. Image frames are binary (see frame-codec.ts). A `bye` always
 *  precedes a server-initiated close: custom close codes do not reach tjs clients. */
export type DeckServerMsg =
  | {
      t: 'welcome';
      v: number;
      layout: DeckLayout;
      brightness: number;
      paired: boolean;
      deviceName: string;
    }
  | { t: 'pong'; now: number }
  | { t: 'brightness'; level: number }
  | { t: 'paired'; value: boolean }
  | { t: 'clear'; k: number }
  | { t: 'bye'; reason: DeckByeReason };

/** POST /deck/api/pair body: either the QR `code` or the typed `shortCode`. */
export interface DeckPairRequest {
  code?: string;
  shortCode?: string;
  name?: string;
}

export interface DeckPairResponse {
  token: string;
  deviceId: string;
}

export interface VirtualDeckDeviceView {
  id: string;
  name: string;
  createdAt: string;
  /** Epoch ms of the last connection since DeckBridge started; absent = none. */
  lastSeenAt?: number;
  connected: boolean;
}

/** A pairing offer shown by the admin panel. */
export interface PairingOffer {
  shortCode: string;
  qrUrl: string;
  urls: string[];
  expiresAt: number;
}

/** GET /api/virtual-deck. */
export interface VirtualDeckState {
  enabled: boolean;
  profile: string;
  listening: boolean;
  port: number;
  bindLoopbackOnly: boolean;
  lastError?: string;
  /** Plain `http://<ip>:<port>/deck/` per own IPv4. */
  urls: string[];
  devices: VirtualDeckDeviceView[];
  pending?: { expiresAt: number };
  latencyP95Ms?: number;
  /** CORA primary/child ports of the browser deck's dock (what the Elgato app is given). */
  coraPorts: { primary: number; child: number };
}
