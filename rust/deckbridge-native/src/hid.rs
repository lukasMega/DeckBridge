use hidapi::HidApi;
use std::collections::BTreeSet;
use std::os::raw::c_char;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::Mutex;

/// Process-lifetime `HidApi`, lazily created without automatic discovery.
static HID_API: Mutex<Option<HidApi>> = Mutex::new(None);

/// Run `f` against exactly the requested VID/PID filters. Avoiding the implicit
/// `add_devices(0, 0)` matters on Windows: full HIDAPI discovery requests descriptor
/// strings from unrelated keyboards, and issue #67 found several that block those
/// requests for five seconds per collection.
fn with_api<T>(default: T, filters: &[(u16, u16)], f: impl FnOnce(&HidApi) -> T) -> T {
    let mut guard = HID_API.lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_none() {
        #[allow(deprecated)]
        let created = HidApi::new_without_enumerate();
        match created {
            Ok(api) => *guard = Some(api),
            Err(_) => return default,
        }
    }
    let Some(api) = guard.as_mut() else {
        return default;
    };
    if api.reset_devices().is_err() {
        return default;
    }
    for &(vid, pid) in filters {
        if api.add_devices(vid, pid).is_err() {
            return default;
        }
    }
    f(api)
}

/// Drop the process-lifetime `HidApi` (hid_exit), so the next enumeration starts
/// from a fresh hid_init. Returns 1 if an instance was dropped, 0 if none existed.
///
/// `reset_devices()` + `add_devices()` only rebuild HIDAPI's *own* device list; the
/// platform backend's shared enumeration state (on macOS, the `IOHIDManager` created
/// at hid_init and scheduled on that thread's run loop) survives. When a device is
/// unplugged and replugged, that state can stop reporting the device for the rest of
/// the process lifetime. Call this after a disconnect so a replug is seen again.
///
/// Safe alongside the USB worker: that thread drives a separately dlopen'd
/// `libhidapi`, a distinct copy with its own globals and open handles.
#[no_mangle]
pub extern "C" fn mirabox_hid_reset() -> i32 {
    let result = catch_unwind(AssertUnwindSafe(|| {
        let mut guard = HID_API.lock().unwrap_or_else(|e| e.into_inner());
        i32::from(guard.take().is_some())
    }));
    result.unwrap_or(0)
}

/// Find a HID device path by vendor ID, product ID, usage page, and usage.
/// Enumerates all HID interfaces (unlike hid_open which picks the first).
/// `pid == 0` means match any product ID (backward-compatible).
/// Writes a null-terminated path into `out_buf`. Returns 1 if found, 0 otherwise.
///
/// # Safety
/// `out_buf` must be null or valid for `out_len` bytes for the duration of the call.
#[no_mangle]
pub unsafe extern "C" fn mirabox_hid_find_path(
    vid: u16,
    pid: u16,
    usage_page: u16,
    usage: u16,
    out_buf: *mut c_char,
    out_len: usize,
) -> i32 {
    let result = catch_unwind(AssertUnwindSafe(|| {
        if out_buf.is_null() || out_len == 0 {
            return 0;
        }
        with_api(0, &[(vid, pid)], |api| {
            for info in api.device_list() {
                if info.vendor_id() == vid
                    && (pid == 0 || info.product_id() == pid)
                    && info.usage_page() == usage_page
                    && info.usage() == usage
                {
                    let path_bytes = info.path().to_bytes_with_nul();
                    let copy_len = path_bytes.len().min(out_len);
                    // SAFETY: out_buf is non-null and valid for out_len bytes (checked at
                    // entry); copy_len is clamped to out_len, and the NUL write below stays
                    // within the buffer.
                    unsafe {
                        std::ptr::copy_nonoverlapping(
                            path_bytes.as_ptr().cast::<c_char>(),
                            out_buf,
                            copy_len,
                        );
                        // Ensure null termination if the buffer was too small
                        if copy_len == out_len {
                            *out_buf.add(out_len - 1) = 0;
                        }
                    }
                    return 1;
                }
            }
            0
        })
    }));
    result.unwrap_or(0)
}

/// List every HID device path matching `vid`/`pid`/`usage_page`/`usage`, one per
/// line (`\n`-separated), NUL-terminated, into `out_buf`. Returns the number of
/// paths written (0 on no match / error / null buffer). Same match predicate as
/// `mirabox_hid_find_path` (`pid == 0` matches any product). Enumeration only —
/// never opens. Truncates cleanly if the buffer fills (stops before overflow,
/// still NUL-terminates); the returned count reflects only paths actually written.
///
/// Lets the host drive N units of the SAME model as separate docks: it opens each
/// distinct path via `hid_open_path` instead of grabbing only the first match.
///
/// # Safety
/// `out_buf` must be null or valid for `out_len` bytes for the duration of the call.
#[no_mangle]
pub unsafe extern "C" fn mirabox_hid_list_paths(
    vid: u16,
    pid: u16,
    usage_page: u16,
    usage: u16,
    out_buf: *mut c_char,
    out_len: usize,
) -> i32 {
    let result = catch_unwind(AssertUnwindSafe(|| {
        if out_buf.is_null() || out_len == 0 {
            return 0;
        }
        with_api(0, &[(vid, pid)], |api| {
            let mut count: i32 = 0;
            let mut pos: usize = 0; // bytes written so far (excluding the final NUL)
            for info in api.device_list() {
                if info.vendor_id() == vid
                    && (pid == 0 || info.product_id() == pid)
                    && info.usage_page() == usage_page
                    && info.usage() == usage
                {
                    // `to_bytes()` excludes the NUL. Newline before every entry after
                    // the first; need room for that separator, the path, and the NUL.
                    let path_bytes = info.path().to_bytes();
                    let sep = usize::from(count > 0);
                    if pos + sep + path_bytes.len() + 1 > out_len {
                        break;
                    }
                    // SAFETY: the bounds check above guarantees pos + sep + len + 1 <= out_len,
                    // so every write below (separator, path bytes, terminating NUL) stays in range.
                    unsafe {
                        if sep == 1 {
                            *out_buf.add(pos) = b'\n' as c_char;
                            pos += 1;
                        }
                        std::ptr::copy_nonoverlapping(
                            path_bytes.as_ptr().cast::<c_char>(),
                            out_buf.add(pos),
                            path_bytes.len(),
                        );
                        pos += path_bytes.len();
                    }
                    count += 1;
                }
            }
            // SAFETY: pos <= out_len - 1 (the loop reserves a byte for the NUL before writing).
            unsafe {
                *out_buf.add(pos) = 0;
            }
            count
        })
    }));
    result.unwrap_or(0)
}

/// Write the USB serial-number string of the HID interface whose enumerated
/// path equals `path` into `out_buf` (null-terminated). Returns 1 if a matching
/// device with a non-empty serial was found, 0 otherwise (no match / empty
/// serial). Enumeration only — never opens the device.
///
/// Used to derive a STABLE per-physical-device key (VID:PID:serial) instead of
/// the volatile macOS IOKit path (`DevSrvsID:<entryID>`), which changes across
/// reboot/replug and makes the same unit look new. Matched by exact path so it
/// is unambiguous even with two identical units connected.
///
/// # Safety
/// `path` must be a valid null-terminated C string. `out_buf` must be null or
/// valid for `out_len` bytes for the duration of the call.
#[no_mangle]
pub unsafe extern "C" fn mirabox_hid_serial_for_path(
    path: *const c_char,
    out_buf: *mut c_char,
    out_len: usize,
) -> i32 {
    let result = catch_unwind(AssertUnwindSafe(|| {
        if path.is_null() || out_buf.is_null() || out_len == 0 {
            return 0;
        }
        // SAFETY: caller guarantees `path` is a valid null-terminated C string.
        let want = unsafe { std::ffi::CStr::from_ptr(path) };
        with_api(0, &[(0, 0)], |api| {
            for info in api.device_list() {
                if info.path() != want {
                    continue;
                }
                let Some(serial) = info.serial_number() else {
                    return 0;
                };
                if serial.is_empty() {
                    return 0;
                }
                let bytes = serial.as_bytes();
                let copy_len = bytes.len().min(out_len - 1);
                // SAFETY: out_buf is non-null and valid for out_len bytes (checked at
                // entry); copy_len < out_len leaves room for the NUL terminator.
                unsafe {
                    std::ptr::copy_nonoverlapping(
                        bytes.as_ptr().cast::<c_char>(),
                        out_buf,
                        copy_len,
                    );
                    *out_buf.add(copy_len) = 0;
                }
                return 1;
            }
            0
        })
    }));
    result.unwrap_or(0)
}

/// Returns 1 if any HID interface matches `vid` + `pid` (usage ignored), else 0.
/// `pid == 0` matches any product. Enumeration only — never opens the device.
///
/// Used for device-presence detection during the host's probe so it can pick the
/// connected model WITHOUT calling hid_open() on absent devices (which corrupts
/// IOKit state on macOS) or loading hidapi in a throwaway worker (whose teardown
/// SIGBUSes while IOKit run-loop callbacks are live).
#[no_mangle]
pub extern "C" fn mirabox_hid_present(vid: u16, pid: u16) -> i32 {
    let result = catch_unwind(AssertUnwindSafe(|| {
        with_api(0, &[(vid, pid)], |api| {
            for info in api.device_list() {
                if info.vendor_id() == vid && (pid == 0 || info.product_id() == pid) {
                    return 1;
                }
            }
            0
        })
    }));
    result.unwrap_or(0)
}

/// Sanitize one enumerated string field for the TSV line format used by
/// `mirabox_hid_list_all`: tabs and newlines would break the record separators,
/// and an absent field becomes `-` so column counts stay fixed.
fn tsv_field(value: Option<&str>) -> String {
    match value {
        None | Some("") => "-".to_string(),
        Some(s) => s.replace(['\t', '\n', '\r'], " "),
    }
}

fn write_hid_rows(api: &HidApi, out_buf: *mut c_char, out_len: usize) -> i32 {
    let mut count: i32 = 0;
    let mut pos: usize = 0;
    for info in api.device_list() {
        let record = format!(
            "{:04x}\t{:04x}\t{:04x}\t{:04x}\t{}\t{}\t{}\t{}\t{}",
            info.vendor_id(),
            info.product_id(),
            info.usage_page(),
            info.usage(),
            info.interface_number(),
            tsv_field(info.manufacturer_string()),
            tsv_field(info.product_string()),
            tsv_field(info.serial_number()),
            tsv_field(info.path().to_str().ok()),
        );
        let bytes = record.as_bytes();
        let sep = usize::from(count > 0);
        if pos + sep + bytes.len() + 1 > out_len {
            break;
        }
        // SAFETY: callers validate the output buffer; the bounds check reserves
        // room for every byte plus the final NUL.
        unsafe {
            if sep == 1 {
                *out_buf.add(pos) = b'\n' as c_char;
                pos += 1;
            }
            std::ptr::copy_nonoverlapping(
                bytes.as_ptr().cast::<c_char>(),
                out_buf.add(pos),
                bytes.len(),
            );
            pos += bytes.len();
        }
        count += 1;
    }
    // SAFETY: every loop iteration reserves one byte for this terminator.
    unsafe {
        *out_buf.add(pos) = 0;
    }
    count
}

fn parse_vid_pid_filters(spec: &str) -> Vec<(u16, u16)> {
    spec.split(',')
        .filter_map(|pair| {
            let (vid, pid) = pair.split_once(':')?;
            Some((
                u16::from_str_radix(vid, 16).ok()?,
                u16::from_str_radix(pid, 16).ok()?,
            ))
        })
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

/// List only interfaces matching comma-separated hexadecimal `VID:PID` pairs.
/// HIDAPI therefore skips descriptor-string queries for unrelated devices.
/// Operational discovery uses this export; full enumeration remains diagnostics-only.
///
/// # Safety
/// `filter_spec` must be a valid null-terminated C string. `out_buf` must be null
/// or valid for `out_len` bytes for the duration of the call.
#[no_mangle]
pub unsafe extern "C" fn mirabox_hid_list_supported(
    filter_spec: *const c_char,
    out_buf: *mut c_char,
    out_len: usize,
) -> i32 {
    let result = catch_unwind(AssertUnwindSafe(|| {
        if filter_spec.is_null() || out_buf.is_null() || out_len == 0 {
            return 0;
        }
        // SAFETY: caller guarantees `filter_spec` is null-terminated.
        let Ok(spec) = unsafe { std::ffi::CStr::from_ptr(filter_spec) }.to_str() else {
            return 0;
        };
        let filters = parse_vid_pid_filters(spec);
        if filters.is_empty() {
            // SAFETY: output buffer validity was checked above.
            unsafe { *out_buf = 0 };
            return 0;
        }
        with_api(0, &filters, |api| write_hid_rows(api, out_buf, out_len))
    }));
    result.unwrap_or(0)
}

/// List EVERY connected HID interface, one TSV record per line, NUL-terminated,
/// into `out_buf`. Returns the number of records written (0 on error / null
/// buffer). Enumeration only — never opens a device.
///
/// Columns: `vid<TAB>pid<TAB>usage_page<TAB>usage<TAB>interface<TAB>manufacturer
/// <TAB>product<TAB>serial<TAB>path`, with vid/pid/usage_page/usage as 4-digit
/// lowercase hex and absent strings as `-`.
///
/// Unlike `mirabox_hid_list_paths` this filters nothing: the point is to see the
/// devices DeckBridge does NOT recognize — a composite HID keyboard whose
/// enumeration is slow is the prime suspect behind the "freeze when a keyboard is
/// plugged in" report, and no VID/PID-filtered call can show it.
///
/// Truncates cleanly if the buffer fills (stops before overflow, still
/// NUL-terminates); the returned count reflects only records actually written.
///
/// # Safety
/// `out_buf` must be null or valid for `out_len` bytes for the duration of the call.
#[no_mangle]
pub unsafe extern "C" fn mirabox_hid_list_all(out_buf: *mut c_char, out_len: usize) -> i32 {
    let result = catch_unwind(AssertUnwindSafe(|| {
        if out_buf.is_null() || out_len == 0 {
            return 0;
        }
        with_api(0, &[(0, 0)], |api| write_hid_rows(api, out_buf, out_len))
    }));
    result.unwrap_or(0)
}

#[cfg(test)]
mod list_all_tests {
    use super::{parse_vid_pid_filters, tsv_field};

    #[test]
    fn absent_and_empty_fields_become_a_dash() {
        assert_eq!(tsv_field(None), "-");
        assert_eq!(tsv_field(Some("")), "-");
    }

    #[test]
    fn separators_inside_a_field_are_replaced() {
        assert_eq!(tsv_field(Some("a\tb\nc\rd")), "a b c d");
    }

    #[test]
    fn ordinary_values_pass_through() {
        assert_eq!(tsv_field(Some("Mirabox 293V3")), "Mirabox 293V3");
    }

    #[test]
    fn supported_filters_parse_and_deduplicate() {
        assert_eq!(
            parse_vid_pid_filters("0fd9:006c,0300:3010,0fd9:006c,bad"),
            vec![(0x0300, 0x3010), (0x0fd9, 0x006c)]
        );
    }
}
