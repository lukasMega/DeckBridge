// tjs:ffi bindings for libdeckbridge_native's Windows-only native mDNS advertise
// (DnsServiceRegister/DnsServiceDeRegister via the `windows` crate — see
// rust/deckbridge-native/src/mdns_windows.rs). The symbols only exist in the
// cdylib built for target_os=windows; dlopen-ing them on macOS/Linux fails
// (caught below), so callers don't need to gate on FFI.suffix themselves.
import FFI from 'tjs:ffi';
import { STRING, UINT16, INT } from './hidapi.ts';
import { debug, warn } from '../logger.js';

const DECKBRIDGE_NATIVE_LIB = 'DECKBRIDGE_NATIVE_LIB';

interface MdnsSymbols {
  mdns_advertise_start(name: string, serviceType: string, port: number, txtKv: string): number;
  mdns_advertise_stop(): void;
}

let lib: { symbols: MdnsSymbols; close(): void } | null = null;
let loadAttempted = false;

function load(): { symbols: MdnsSymbols; close(): void } | null {
  if (lib) return lib;
  if (loadAttempted) return null; // already failed once this process — don't retry every call
  loadAttempted = true;

  const path = (typeof tjs !== 'undefined' ? tjs.env[DECKBRIDGE_NATIVE_LIB] : undefined) ?? '';
  if (!path) {
    debug('ffi', `${DECKBRIDGE_NATIVE_LIB} not set - skipping native mdns advertise`);
    return null;
  }
  try {
    lib = FFI.dlopen(path, {
      mdns_advertise_start: { args: [STRING, STRING, UINT16, STRING], returns: INT },
      mdns_advertise_stop: { args: [], returns: 'void' },
    }) as unknown as { symbols: MdnsSymbols; close(): void };
    return lib;
  } catch (e) {
    debug('ffi', `native mdns advertise unavailable: ${String(e)}`);
    return null;
  }
}

/** True if the native mdns_advertise_start/_stop symbols are resolvable in the
 *  loaded DECKBRIDGE_NATIVE_LIB — side-effect-free (dlopen only, never calls
 *  mdns_advertise_start). Used by the requirements page to report which mDNS
 *  path is active without actually registering a service. */
export function isNativeMdnsAvailable(): boolean {
  return load() !== null;
}

/** Starts native mDNS advertise (Windows only; fire-and-forget — Windows
 *  completes registration asynchronously). Returns true if the registration
 *  call itself succeeded, false if the native lib/symbols are unavailable or
 *  the call failed (caller should fall back to spawning dns-sd). */
export function mdnsAdvertiseStart(
  name: string,
  serviceType: string,
  port: number,
  txtKv: string,
): boolean {
  const l = load();
  if (!l) return false;
  try {
    return l.symbols.mdns_advertise_start(name, serviceType, port, txtKv) === 1;
  } catch (e) {
    warn('ffi', `mdns_advertise_start threw: ${String(e)}`);
    return false;
  }
}

/** Stops native mDNS advertise (no-op if never started / unavailable). */
export function mdnsAdvertiseStop(): void {
  if (!lib) return;
  try {
    lib.symbols.mdns_advertise_stop();
  } catch (e) {
    warn('ffi', `mdns_advertise_stop threw: ${String(e)}`);
  }
}
