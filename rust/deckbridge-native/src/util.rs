use std::panic::{catch_unwind, AssertUnwindSafe};

/// Panic guard shared by every `extern "C"` entry point: unwinding across the FFI
/// boundary is undefined behaviour, so a caught panic returns `default` instead
/// (the workspace profile keeps `panic = "unwind"` for exactly this).
pub(crate) fn ffi_guard<T>(default: T, f: impl FnOnce() -> T) -> T {
    catch_unwind(AssertUnwindSafe(f)).unwrap_or(default)
}

pub(crate) fn write_err(msg: &str, err_buf: *mut u8, err_cap: usize) {
    if err_buf.is_null() || err_cap == 0 {
        return;
    }
    let bytes = msg.as_bytes();
    let copy_len = bytes.len().min(err_cap - 1);
    // SAFETY: err_buf is non-null with capacity err_cap (checked above); copy_len
    // is clamped to err_cap - 1, so the write and the trailing NUL stay in bounds.
    unsafe {
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), err_buf, copy_len);
        *err_buf.add(copy_len) = 0;
    }
}

pub(crate) fn write_u32_le(buf: &mut [u8], off: usize, v: u32) {
    buf[off..off + 4].copy_from_slice(&v.to_le_bytes());
}

pub(crate) fn write_i32_le(buf: &mut [u8], off: usize, v: i32) {
    buf[off..off + 4].copy_from_slice(&v.to_le_bytes());
}

pub(crate) fn write_u16_le(buf: &mut [u8], off: usize, v: u16) {
    buf[off..off + 2].copy_from_slice(&v.to_le_bytes());
}
