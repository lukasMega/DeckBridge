/** Shared low-level libhidapi plumbing for the in-worker HID drivers
 *  (MiraboxDriver, ElgatoHidDriver). Owns the per-worker library singleton,
 *  the device handle, the polling read loop, write-error logging, and the
 *  cleanup teardown. Behavioral specifics (path resolution, read buffer size,
 *  input parsing, shutdown write, write framing) are template hooks the
 *  subclass fills in.
 *
 *  USB latency has priority: the read/write paths are synchronous — no await,
 *  setImmediate, queueMicrotask, or promises are introduced here. */
import { EventEmitter } from 'node:events';
import { loadHidapi } from '../ffi/hidapi.js';
import type { HidapiSymbols } from '../ffi/hidapi.js';
import { error } from '../logger.js';

// Module-level singleton — loaded once per worker thread, shared by every
// driver instance on that thread.
// Prevents GC from calling dlclose() between retries: hid_init() registers
// IOKit callbacks that reference library code; dlclose() while they're live
// causes SIGBUS on the next dlopen(). Cleared in _teardownLib() after device close.
let _workerHidLib: { symbols: HidapiSymbols; close(): void } | null = null;

export abstract class HidDeviceBase extends EventEmitter {
  protected device: unknown = null;
  protected hidLib: { symbols: HidapiSymbols; close(): void } | null = null;
  protected readTimer: ReturnType<typeof setInterval> | null = null;

  /** Acquire (or reuse) the per-worker hidapi singleton and assign it to
   *  `this.hidLib`. Returns the symbol table for use by the caller. */
  protected _acquireLib(): HidapiSymbols {
    if (!_workerHidLib) {
      _workerHidLib = loadHidapi();
    }
    this.hidLib = _workerHidLib;
    return this.hidLib.symbols;
  }

  /** Begin the polling read loop. hid_read_timeout blocks ≤ pollMs — safe on
   *  the single-threaded event loop because data is available immediately or
   *  not at all in practice. On a negative read it runs cleanup, then emits
   *  'error' + 'disconnect'; on a positive read it forwards to parseInput. */
  protected _startReadLoop(
    hid: HidapiSymbols,
    bufSize: number,
    pollMs: number,
    parseInput: (data: Uint8Array, n: number) => void,
  ): void {
    const readBuf = new Uint8Array(bufSize);
    this.readTimer = setInterval(() => {
      if (!this.device || !this.hidLib) return;
      const n = hid.hid_read_timeout(this.device, readBuf, bufSize, pollMs);
      if (n < 0) {
        // A negative read means the handle is gone (device unplugged). hid_error()
        // is unreliable here: on macOS it returns a wchar_t* the FFI reads as a
        // char*, yielding a single garbage char (e.g. "S"). Log a fixed, accurate
        // message instead (A6).
        this._cleanup();
        this.emit('error', new Error('device read failed — disconnected'));
        this.emit('disconnect');
        return;
      }
      if (n > 0) {
        parseInput(readBuf, n);
      }
    }, pollMs);
  }

  /** Synchronous hid_write with shared error logging. On a negative return the
   *  hidapi error string is extracted (falling back to 'unknown') and logged
   *  under `logTag` using the caller's `message` builder — the two drivers
   *  format the failure line differently, so the message stays per-caller. */
  protected _writeRaw(
    buf: Uint8Array,
    logTag: string,
    message: (n: number, errStr: string) => string,
  ): number {
    if (!this.device || !this.hidLib) return -1;
    const n = this.hidLib.symbols.hid_write(this.device, buf, buf.length);
    if (n < 0) {
      const errStr = this.hidLib.symbols.hid_error(this.device) ?? 'unknown';
      error(logTag, message(n, errStr));
    }
    return n;
  }

  /** Stop the read timer. */
  protected _stopReadTimer(): void {
    if (this.readTimer) {
      clearInterval(this.readTimer);
      this.readTimer = null;
    }
  }

  /** Close the open device handle, after giving the subclass a chance to issue
   *  its per-driver shutdown write (disconnect packets / reset-to-logo) while
   *  the device is still open. */
  protected _closeDevice(): void {
    if (this.device && this.hidLib) {
      try {
        this.onBeforeClose();
      } catch {
        /* shutdown write must never block teardown */
      }
      this.hidLib.symbols.hid_close(this.device);
      this.device = null;
    }
  }

  /** Tear down the per-worker library: hid_exit(), dlclose, and reset the
   *  singleton so the next worker load is fresh. Run on normal cleanup (after a
   *  device was opened and closed). Returns the hid_exit() code (or null if no
   *  library was loaded) so callers that log it can. */
  protected _teardownLib(): number | null {
    if (this.hidLib) {
      const exitRet = this.hidLib.symbols.hid_exit();
      this.hidLib.close();
      this.hidLib = null;
      _workerHidLib = null; // allow fresh load on next worker
      return exitRet;
    }
    return null;
  }

  /** Release hidapi after a FAILED open (hid_init succeeded, but no device was
   *  opened). hid_init() schedules an IOHIDManager on THIS worker thread's run
   *  loop; if it is left live, the host's worker.terminate() destroys the thread
   *  with the manager still scheduled and SIGBUSes the whole process on macOS.
   *  hid_exit() unschedules/releases that manager, making the terminate safe.
   *  Deliberately skips dlclose(): the worker is about to be terminated, and
   *  dlclose churn on macOS HID libs is itself SIGBUS-prone (see _workerHidLib). */
  protected _releaseLibAfterFailedOpen(): void {
    if (this.hidLib) {
      try {
        this.hidLib.symbols.hid_exit();
      } catch {
        /* best-effort: terminate-safety is the goal, not a clean exit code */
      }
      this.hidLib = null;
      _workerHidLib = null;
    }
  }

  /** Per-driver shutdown write, performed while the device is still open.
   *  Mirabox sends CLE-DC + HAN; Elgato sends a reset-to-logo feature report. */
  protected abstract onBeforeClose(): void;

  protected abstract _cleanup(): void;
}
