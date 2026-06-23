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
