use hidapi::HidApi;
use std::os::raw::c_char;
use std::panic::{catch_unwind, AssertUnwindSafe};

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
        let Ok(api) = HidApi::new() else {
            return 0;
        };
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
        let Ok(api) = HidApi::new() else {
            return 0;
        };
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
        let Ok(api) = HidApi::new() else {
            return 0;
        };
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
                std::ptr::copy_nonoverlapping(bytes.as_ptr().cast::<c_char>(), out_buf, copy_len);
                *out_buf.add(copy_len) = 0;
            }
            return 1;
        }
        0
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
        let Ok(api) = HidApi::new() else {
            return 0;
        };
        for info in api.device_list() {
            if info.vendor_id() == vid && (pid == 0 || info.product_id() == pid) {
                return 1;
            }
        }
        0
    }));
    result.unwrap_or(0)
}
