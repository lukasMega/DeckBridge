//! Native mDNS (DNS-SD) advertisement for Windows, via the Win32 `Dnsapi.dll`
//! service-registration API (`DnsServiceRegister`/`DnsServiceDeRegister`, built
//! into Windows since 10 1703 — no Bonjour/avahi dependency, unlike macOS/Linux
//! which shell out to `dns-sd`/`avahi-publish-service`).
//!
//! Registrations are keyed by port (one deckbridge process can run several
//! docks, each with its own CORA TCP port), tracked in a module-level static
//! map. `start` fires the register call and returns immediately — Windows
//! completes registration asynchronously and invokes the completion callback,
//! which we ignore (fire-and-forget, per the "never block the CORA hot path"
//! rule; TS never awaits mDNS readiness). `stop` deregisters synchronously,
//! mirroring how the TS side's `stop()` kills the `dns-sd` subprocess
//! synchronously on the other platforms.

use crate::util::ffi_guard;
use std::collections::HashMap;
use std::ffi::c_char;
use std::ptr::null_mut;
use std::sync::Mutex;

use windows::core::PCWSTR;
use windows::Win32::NetworkManagement::Dns::{
    DnsServiceConstructInstance, DnsServiceDeRegister, DnsServiceFreeInstance, DnsServiceRegister,
    DNS_SERVICE_INSTANCE, DNS_SERVICE_REGISTER_REQUEST,
};

// The Win32 header (windns.h) defines a single DNS_QUERY_REQUEST_VERSION1 = 1
// reused across every DNS service request struct's `Version` field; the crate
// only exposes it wrapped as a different newtype (DNS_QUERY_OPTIONS), so use
// the literal directly here instead of unwrapping that unrelated type.
const DNS_SERVICE_REGISTER_REQUEST_VERSION1: u32 = 1;

/// The in-flight/registered service instance, kept alive for `DnsServiceDeRegister`
/// (it needs the same `DNS_SERVICE_INSTANCE*` that was registered) and to
/// guarantee only one registration runs per port.
struct ActiveRegistration {
    instance: *mut DNS_SERVICE_INSTANCE,
}
// SAFETY: the pointer is only read/freed via the Dnsapi calls below, which are
// safe to invoke from any thread, and access is serialized by the Mutex.
unsafe impl Send for ActiveRegistration {}

static ACTIVE: Mutex<Option<HashMap<u16, ActiveRegistration>>> = Mutex::new(None);

fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Parses `key=value` pairs, one per line (matches the `\n`-joined convention
/// used elsewhere in this crate, e.g. `mirabox_hid_list_paths`).
fn parse_txt(txt: &str) -> Vec<(String, String)> {
    txt.lines()
        .filter_map(|line| line.split_once('='))
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

/// Starts advertising `name` on `service_type` (e.g. `_elg._tcp`) at `port`,
/// with the given TXT record. Returns 1 on success (registration initiated —
/// NOT necessarily complete, Windows finishes it asynchronously), 0 on failure.
///
/// # Safety
/// `name`, `service_type`, `txt_kv` must be valid, null-terminated C strings.
#[no_mangle]
pub unsafe extern "C" fn mdns_advertise_start(
    name: *const c_char,
    service_type: *const c_char,
    port: u16,
    txt_kv: *const c_char,
) -> i32 {
    ffi_guard(0, || {
        if name.is_null() || service_type.is_null() {
            return 0;
        }
        // SAFETY: caller guarantees these are valid null-terminated C strings.
        let name = unsafe { std::ffi::CStr::from_ptr(name) }
            .to_string_lossy()
            .into_owned();
        // SAFETY: as above — a valid null-terminated C string per the fn contract.
        let service_type = unsafe { std::ffi::CStr::from_ptr(service_type) }
            .to_string_lossy()
            .into_owned();
        let txt = if txt_kv.is_null() {
            String::new()
        } else {
            // SAFETY: caller guarantees a valid null-terminated C string.
            unsafe { std::ffi::CStr::from_ptr(txt_kv) }
                .to_string_lossy()
                .into_owned()
        };

        let mut guard = ACTIVE.lock().unwrap_or_else(|e| e.into_inner());
        let map = guard.get_or_insert_with(HashMap::new);
        // A previous registration on this port must be torn down before starting
        // a new one — DnsServiceRegister doesn't replace an existing instance in
        // place. Registrations on other ports (other docks) are left untouched.
        if let Some(prev) = map.remove(&port) {
            // SAFETY: prev.instance was registered by a prior advertise_start call.
            unsafe { deregister(prev.instance) };
        }

        let instance_name = to_wide(&format!("{name}.{service_type}.local"));
        let host_name = to_wide("localhost.local");
        let pairs = parse_txt(&txt);
        let key_wides: Vec<Vec<u16>> = pairs.iter().map(|(k, _)| to_wide(k)).collect();
        let val_wides: Vec<Vec<u16>> = pairs.iter().map(|(_, v)| to_wide(v)).collect();
        let keys: Vec<PCWSTR> = key_wides.iter().map(|w| PCWSTR(w.as_ptr())).collect();
        let values: Vec<PCWSTR> = val_wides.iter().map(|w| PCWSTR(w.as_ptr())).collect();

        // SAFETY: instance_name/host_name are valid NUL-terminated wide strings
        // that outlive this call; keys/values arrays have matching lengths.
        let instance = unsafe {
            DnsServiceConstructInstance(
                PCWSTR(instance_name.as_ptr()),
                PCWSTR(host_name.as_ptr()),
                None,
                None,
                port,
                0,
                0,
                keys.len() as u32,
                keys.as_ptr(),
                values.as_ptr(),
            )
        };
        if instance.is_null() {
            return 0;
        }

        let request = DNS_SERVICE_REGISTER_REQUEST {
            Version: DNS_SERVICE_REGISTER_REQUEST_VERSION1,
            InterfaceIndex: 0,
            pServiceInstance: instance,
            pRegisterCompletionCallback: None,
            pQueryContext: null_mut(),
            hCredentials: windows::Win32::Foundation::HANDLE::default(),
            unicastEnabled: false.into(),
        };

        // SAFETY: request is fully initialized; no completion callback is
        // registered, so the async completion has nothing to call back into —
        // fire-and-forget as required on the CORA hot path.
        let status = unsafe { DnsServiceRegister(&request, None) };
        if status != 0 {
            // SAFETY: instance was allocated by DnsServiceConstructInstance above.
            unsafe { DnsServiceFreeInstance(instance) };
            return 0;
        }

        map.insert(port, ActiveRegistration { instance });
        1
    })
}

/// SAFETY: `instance` must be a live pointer previously returned by
/// `DnsServiceConstructInstance` and registered via `DnsServiceRegister`.
unsafe fn deregister(instance: *mut DNS_SERVICE_INSTANCE) {
    let request = DNS_SERVICE_REGISTER_REQUEST {
        Version: DNS_SERVICE_REGISTER_REQUEST_VERSION1,
        InterfaceIndex: 0,
        pServiceInstance: instance,
        pRegisterCompletionCallback: None,
        pQueryContext: null_mut(),
        hCredentials: windows::Win32::Foundation::HANDLE::default(),
        unicastEnabled: false.into(),
    };
    // SAFETY: request references a live, previously-registered instance.
    unsafe {
        let _ = DnsServiceDeRegister(&request, None);
        DnsServiceFreeInstance(instance);
    }
}

/// Stops advertising on `port` (no-op if that port has no active registration;
/// other ports' registrations are untouched). Blocking, per the plan: only
/// `stop()` (app shutdown / dock stop) may block; `start()` never does.
#[no_mangle]
pub extern "C" fn mdns_advertise_stop(port: u16) {
    ffi_guard((), || {
        let mut guard = ACTIVE.lock().unwrap_or_else(|e| e.into_inner());
        let Some(map) = guard.as_mut() else { return };
        if let Some(active) = map.remove(&port) {
            // SAFETY: active.instance was registered by a prior advertise_start.
            unsafe { deregister(active.instance) };
        }
    });
}
