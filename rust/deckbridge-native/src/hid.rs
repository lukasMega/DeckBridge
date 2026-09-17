use crate::util::ffi_guard;
use hidapi::{DeviceInfo, HidApi};
use std::collections::BTreeSet;
use std::os::raw::c_char;
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

/// Enumeration match predicate shared by the exports below: `pid == 0` matches any
/// product id. `matches_usage` adds the HID usage page/usage pair.
fn matches_vid_pid(info: &DeviceInfo, vid: u16, pid: u16) -> bool {
    info.vendor_id() == vid && (pid == 0 || info.product_id() == pid)
}

fn matches_usage(info: &DeviceInfo, vid: u16, pid: u16, page: u16, usage: u16) -> bool {
    matches_vid_pid(info, vid, pid) && info.usage_page() == page && info.usage() == usage
}

/// Appends `\n`-joined records into a caller-owned C buffer and NUL-terminates it.
/// `push` rejects — without writing anything — a record that would not fit together
/// with its separator AND the final NUL, which is what lets `finish` always
/// terminate in bounds. Both list exports share this one bounds proof instead of
/// repeating the pointer arithmetic.
struct NulJoinWriter<'a> {
    buf: &'a mut [u8],
    pos: usize,
    count: i32,
}

impl<'a> NulJoinWriter<'a> {
    fn new(buf: &'a mut [u8]) -> Self {
        Self {
            buf,
            pos: 0,
            count: 0,
        }
    }

    /// # Safety
    /// `buf` must be non-null and valid for `len` bytes (`len >= 1`, so the
    /// terminator always has room) for the writer's lifetime, and unaliased while
    /// the writer lives.
    unsafe fn from_raw<'b>(buf: *mut c_char, len: usize) -> NulJoinWriter<'b> {
        // SAFETY: the caller's contract above; `c_char` and `u8` share size and
        // alignment, so the cast only reinterprets the bytes.
        NulJoinWriter::new(unsafe { std::slice::from_raw_parts_mut(buf.cast::<u8>(), len) })
    }

    /// Returns false, having written nothing, when `record` does not fit — callers
    /// stop at the first rejection so the output truncates cleanly on a record
    /// boundary.
    fn push(&mut self, record: &[u8]) -> bool {
        let sep = usize::from(self.count > 0);
        if self.pos + sep + record.len() + 1 > self.buf.len() {
            return false;
        }
        if sep == 1 {
            self.buf[self.pos] = b'\n';
            self.pos += 1;
        }
        self.buf[self.pos..self.pos + record.len()].copy_from_slice(record);
        self.pos += record.len();
        self.count += 1;
        true
    }

    /// Writes the terminating NUL and returns the number of records written.
    fn finish(self) -> i32 {
        self.buf[self.pos] = 0;
        self.count
    }
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
    ffi_guard(0, || {
        let mut guard = HID_API.lock().unwrap_or_else(|e| e.into_inner());
        i32::from(guard.take().is_some())
    })
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
    ffi_guard(0, || {
        if out_buf.is_null() || out_len == 0 {
            return 0;
        }
        with_api(0, &[(vid, pid)], |api| {
            for info in api.device_list() {
                if matches_usage(info, vid, pid, usage_page, usage) {
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
    })
}

/// List every HID device path matching `vid`/`pid`/`usage_page`/`usage`, one per
/// line (`\n`-separated), NUL-terminated, into `out_buf`. Returns the number of
/// paths written (0 on no match / error / null buffer); `pid == 0` matches any
/// product. Enumeration only — never opens. Truncates cleanly if the buffer fills
/// (stops before overflow, still NUL-terminates); the returned count reflects only
/// paths actually written.
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
    ffi_guard(0, || {
        if out_buf.is_null() || out_len == 0 {
            return 0;
        }
        with_api(0, &[(vid, pid)], |api| {
            // SAFETY: out_buf is non-null and valid for out_len >= 1 bytes (checked
            // at entry), and the caller owns it for the duration of the call.
            let mut out = unsafe { NulJoinWriter::from_raw(out_buf, out_len) };
            for info in api.device_list() {
                // `to_bytes()` excludes the NUL; the writer adds separator + terminator.
                if matches_usage(info, vid, pid, usage_page, usage)
                    && !out.push(info.path().to_bytes())
                {
                    break;
                }
            }
            out.finish()
        })
    })
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
    ffi_guard(0, || {
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
    })
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
    ffi_guard(0, || {
        with_api(0, &[(vid, pid)], |api| {
            for info in api.device_list() {
                if matches_vid_pid(info, vid, pid) {
                    return 1;
                }
            }
            0
        })
    })
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
    // SAFETY: every caller checks out_buf is non-null with out_len >= 1 before
    // reaching here, and the caller owns the buffer for the duration of the call.
    let mut out = unsafe { NulJoinWriter::from_raw(out_buf, out_len) };
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
        if !out.push(record.as_bytes()) {
            break;
        }
    }
    out.finish()
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
    ffi_guard(0, || {
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
    })
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
    ffi_guard(0, || {
        if out_buf.is_null() || out_len == 0 {
            return 0;
        }
        with_api(0, &[(0, 0)], |api| write_hid_rows(api, out_buf, out_len))
    })
}

#[cfg(test)]
mod list_all_tests {
    use super::{parse_vid_pid_filters, tsv_field, NulJoinWriter};

    /// Drives the writer over a plain buffer (the FFI path only adds the raw->slice
    /// cast in `from_raw`), returning the record count and the whole buffer.
    fn join(cap: usize, records: &[&str]) -> (i32, Vec<u8>) {
        let mut buf = vec![0xAAu8; cap];
        let count = {
            let mut out = NulJoinWriter::new(&mut buf);
            for r in records {
                if !out.push(r.as_bytes()) {
                    break;
                }
            }
            out.finish()
        };
        (count, buf)
    }

    #[test]
    fn records_are_newline_joined_and_nul_terminated() {
        let (count, buf) = join(32, &["/dev/a", "/dev/b", "/dev/c"]);
        assert_eq!(count, 3);
        assert_eq!(&buf[..21], b"/dev/a\n/dev/b\n/dev/c\0");
    }

    #[test]
    fn empty_output_is_still_nul_terminated() {
        let (count, buf) = join(8, &[]);
        assert_eq!(count, 0);
        assert_eq!(buf[0], 0);
    }

    #[test]
    fn a_record_that_exactly_fits_with_its_nul_is_written() {
        // "/dev/a\n/dev/b" is 13 bytes + terminator = 14.
        let (count, buf) = join(14, &["/dev/a", "/dev/b"]);
        assert_eq!(count, 2);
        assert_eq!(&buf[..14], b"/dev/a\n/dev/b\0");
    }

    #[test]
    fn overflowing_record_is_dropped_whole_and_earlier_output_survives() {
        // One byte short: the second record (separator + 6 + NUL) cannot fit, so it
        // is not partially copied — the buffer keeps record 1, NUL-terminated, and
        // the count reflects only what was written.
        let (count, buf) = join(13, &["/dev/a", "/dev/b"]);
        assert_eq!(count, 1);
        assert_eq!(&buf[..7], b"/dev/a\0");
        assert!(buf[7..].iter().all(|&b| b == 0xAA), "no partial write");
    }

    #[test]
    fn a_first_record_too_big_for_the_buffer_writes_nothing_but_the_nul() {
        let (count, buf) = join(6, &["/dev/a"]);
        assert_eq!(count, 0);
        assert_eq!(buf[0], 0);
        assert!(buf[1..].iter().all(|&b| b == 0xAA), "no partial write");
    }

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
