// Recovers a pairing the Elgato app abandons. If a child handshake reply is late
// (a ~0.5 s main-thread pause is enough) the app resets the child socket and never
// re-opens it while its primary connection stays up — the dock looks connected
// but never pairs. Dropping the primary makes the app redo primary → child.
import type { EventEmitter } from 'node:events';
import { log } from './logger.js';
import { clearTimer } from './types.js';

/** A child session shorter than this counts as an aborted handshake. The app's
 *  own probe session (closed after 2–3 ms, re-opened at once) also qualifies,
 *  which is why recovery waits `recheckMs` for the re-open first. */
const EARLY_CHILD_DROP_MS = 2_000;
const PAIRING_RECHECK_MS = 3_000;
/** Cap per failure streak, so an app that keeps rejecting the dock can't loop us. */
const MAX_PAIRING_RETRIES = 3;

interface CoraEnd extends Pick<EventEmitter, 'on'> {
  readonly hasClient: boolean;
}

interface PairingWatchdogOptions {
  earlyDropMs?: number;
  recheckMs?: number;
  maxRetries?: number;
}

export class PairingWatchdog {
  private childSince = 0;
  private retries = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly earlyDropMs: number;
  private readonly recheckMs: number;
  private readonly maxRetries: number;

  constructor(
    private readonly primary: CoraEnd & { dropClient(): void },
    private readonly child: CoraEnd,
    private readonly label: string,
    opts: PairingWatchdogOptions = {},
  ) {
    this.earlyDropMs = opts.earlyDropMs ?? EARLY_CHILD_DROP_MS;
    this.recheckMs = opts.recheckMs ?? PAIRING_RECHECK_MS;
    this.maxRetries = opts.maxRetries ?? MAX_PAIRING_RETRIES;
    child.on('clientConnected', () => {
      this.childSince = Date.now();
      this.cancel();
    });
    child.on('clientDisconnected', () => this.onChildGone());
    primary.on('clientDisconnected', () => this.cancel());
  }

  /** Stop any pending recheck (server shutdown). */
  cancel(): void {
    this.timer = clearTimer(this.timer);
  }

  private onChildGone(): void {
    const lasted = Date.now() - this.childSince;
    if (lasted >= this.earlyDropMs) {
      this.retries = 0;
      return;
    }
    if (!this.primary.hasClient) return;
    this.cancel();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.child.hasClient || !this.primary.hasClient) return;
      if (this.retries >= this.maxRetries) {
        log(
          'warn',
          'elgato',
          `${this.label}: child pairing aborted, giving up after ${this.retries} retries`,
        );
        return;
      }
      this.retries++;
      log(
        'warn',
        'elgato',
        `${this.label}: child session aborted after ${lasted}ms and not re-opened — dropping primary to restart pairing (retry ${this.retries}/${this.maxRetries})`,
      );
      this.primary.dropClient();
    }, this.recheckMs);
  }
}

/** Attach a watchdog to one dock's primary/child pair; lives as long as the servers. */
export function watchPairing(
  primary: CoraEnd & { dropClient(): void },
  child: CoraEnd,
  label: string,
): PairingWatchdog {
  return new PairingWatchdog(primary, child, label);
}
