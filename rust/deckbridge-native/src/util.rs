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
    buf[off] = (v & 0xff) as u8;
    buf[off + 1] = ((v >> 8) & 0xff) as u8;
    buf[off + 2] = ((v >> 16) & 0xff) as u8;
    buf[off + 3] = ((v >> 24) & 0xff) as u8;
}

pub(crate) fn write_i32_le(buf: &mut [u8], off: usize, v: i32) {
    write_u32_le(buf, off, v as u32);
}

pub(crate) fn write_u16_le(buf: &mut [u8], off: usize, v: u16) {
    buf[off] = (v & 0xff) as u8;
    buf[off + 1] = ((v >> 8) & 0xff) as u8;
}
