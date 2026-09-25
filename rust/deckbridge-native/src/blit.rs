use crate::transform::decode_limited;
use crate::util::{ffi_guard, write_err};

/// Decode `input` and copy it into a top-down RGB24 `canvas` (`cw`×`ch`) at (x, y),
/// clipped to the canvas. The Stream Deck + app sends most touch-strip updates as
/// small patches (dial feedback), which must land inside the strip, not replace it.
pub(crate) fn blit_rgb(
    canvas: &mut [u8],
    cw: u32,
    ch: u32,
    input: &[u8],
    x: u32,
    y: u32,
) -> Result<(), String> {
    let needed = cw as usize * ch as usize * 3;
    if canvas.len() < needed {
        return Err(format!("canvas too small: {} < {}", canvas.len(), needed));
    }
    let patch = decode_limited(input)?.to_rgb8();
    if x >= cw || y >= ch {
        return Ok(());
    }
    let w = patch.width().min(cw - x) as usize;
    let h = patch.height().min(ch - y) as usize;
    let src_stride = patch.width() as usize * 3;
    let dst_stride = cw as usize * 3;
    let src = patch.as_raw();
    for row in 0..h {
        let s = row * src_stride;
        let d = (y as usize + row) * dst_stride + x as usize * 3;
        canvas[d..d + w * 3].copy_from_slice(&src[s..s + w * 3]);
    }
    Ok(())
}

/// Blit an encoded image (JPEG/BMP) into a caller-owned RGB24 canvas, in place.
///
/// Returns `0` on success, `-1` decode/size error (UTF-8 message written into
/// err_buf, NUL-terminated), `-3` panic caught at the FFI boundary.
///
/// # Safety
/// `canvas` must be valid for `cw * ch * 3` writable bytes, `input` for `input_len`
/// bytes, and `err_buf` for `err_cap` bytes (or null), for the duration of the call.
#[allow(clippy::too_many_arguments)]
#[no_mangle]
pub unsafe extern "C" fn image_proc_blit(
    canvas: *mut u8,
    cw: u32,
    ch: u32,
    input: *const u8,
    input_len: usize,
    x: u32,
    y: u32,
    err_buf: *mut u8,
    err_cap: usize,
) -> i32 {
    ffi_guard(-3, || {
        if canvas.is_null() || input.is_null() {
            write_err("null pointer argument", err_buf, err_cap);
            return -1;
        }
        // SAFETY: both pointers are non-null (checked above) and valid for the
        // stated lengths per the fn contract.
        let (canvas, input) = unsafe {
            (
                std::slice::from_raw_parts_mut(canvas, cw as usize * ch as usize * 3),
                std::slice::from_raw_parts(input, input_len),
            )
        };
        match blit_rgb(canvas, cw, ch, input, x, y) {
            Ok(()) => 0,
            Err(msg) => {
                write_err(&msg, err_buf, err_cap);
                -1
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::blit_rgb;
    use crate::bmp::encode_bmp;
    use image::{DynamicImage, Rgb, RgbImage};

    /// Widths stay multiples of 4: encode_bmp writes unpadded rows.
    fn bmp(w: u32, h: u32, px: [u8; 3]) -> Vec<u8> {
        encode_bmp(
            DynamicImage::ImageRgb8(RgbImage::from_pixel(w, h, Rgb(px))),
            0,
        )
        .unwrap()
    }

    #[test]
    fn patch_lands_at_offset_and_leaves_the_rest() {
        let mut canvas = vec![0u8; 8 * 4 * 3];
        blit_rgb(&mut canvas, 8, 4, &bmp(4, 2, [9, 8, 7]), 3, 1).unwrap();
        let at = |x: usize, y: usize| &canvas[(y * 8 + x) * 3..(y * 8 + x) * 3 + 3];
        assert_eq!(at(3, 1), [9, 8, 7]);
        assert_eq!(at(6, 2), [9, 8, 7]);
        assert_eq!(at(2, 1), [0, 0, 0]);
        assert_eq!(at(7, 1), [0, 0, 0]);
        assert_eq!(at(3, 3), [0, 0, 0]);
    }

    #[test]
    fn patch_is_clipped_to_the_canvas() {
        let mut canvas = vec![0u8; 4 * 2 * 3];
        blit_rgb(&mut canvas, 4, 2, &bmp(4, 4, [1, 1, 1]), 2, 1).unwrap();
        assert_eq!(canvas.iter().filter(|&&b| b == 1).count(), 2 * 3);
        blit_rgb(&mut canvas, 4, 2, &bmp(4, 1, [5, 5, 5]), 9, 9).unwrap();
    }

    #[test]
    fn short_canvas_is_an_error() {
        let mut canvas = vec![0u8; 5];
        assert!(blit_rgb(&mut canvas, 4, 2, &bmp(4, 1, [0, 0, 0]), 0, 0).is_err());
    }
}
