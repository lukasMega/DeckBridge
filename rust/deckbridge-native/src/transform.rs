use crate::bmp::encode_bmp;
use crate::jpeg::encode_jpeg;
use crate::pad::pad_to_canvas;
use crate::util::write_err;
use image::imageops::FilterType;
use std::io::Cursor;
use std::panic::{catch_unwind, AssertUnwindSafe};

/// Private transform helper: decode, rotate/flip, resize, encode (JPEG or BMP).
/// EXIF auto-rotate is intentionally not performed (dropped for binary size — see plan).
// The flat parameter list mirrors the FFI ABI of image_proc_transform.
#[allow(clippy::too_many_arguments)]
pub(crate) fn transform(
    input: &[u8],
    width: u32,
    height: u32,
    max_bytes: usize,
    quality: u32,
    skip_resize: bool,
    rotate: u32,
    flip_h: bool,
    flip_v: bool,
    format: i32,
    bmp_ppm: i32,
    blur_sigma_tenths: u32,
    resize_filter: u32,
    sharpen_sigma_tenths: u32,
    fill_mode: u32,
    crop_px: u32,
) -> Result<Vec<u8>, String> {
    // Decompression-bomb defense: cap dimensions and intermediate allocations
    // before decoding (S3) — bytes arrive from the LAN unauthenticated.
    let mut reader = image::ImageReader::new(Cursor::new(input))
        .with_guessed_format()
        .map_err(|e| format!("Image format error: {}", e))?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(500);
    limits.max_image_height = Some(500);
    limits.max_alloc = Some(900 * 1024);
    reader.limits(limits);
    let mut img = match reader.decode() {
        Ok(i) => i,
        Err(e) => return Err(format!("Image load error: {}", e)),
    };

    // Crop the source frame symmetrically before any rotate/flip/resize (the K1 Pro
    // is fed an 80×80 Mini BMP whose outer ~10 px is dead border). Skip when the crop
    // would leave nothing — guards tiny inputs and the no-op (crop_px == 0) case.
    if crop_px > 0 {
        let (w, h) = (img.width(), img.height());
        if w > 2 * crop_px && h > 2 * crop_px {
            img = img.crop_imm(crop_px, crop_px, w - 2 * crop_px, h - 2 * crop_px);
        }
    }

    if fill_mode == 0 {
        // unchanged: rotate → flip → (optional) resize
        img = match rotate {
            90 => img.rotate90(),
            180 => img.rotate180(),
            270 => img.rotate270(),
            _ => img,
        };
        if flip_h {
            img = img.fliph();
        }
        if flip_v {
            img = img.flipv();
        }

        if !skip_resize {
            let filter = match resize_filter {
                1 => FilterType::Nearest,
                2 => FilterType::Lanczos3,
                _ => FilterType::Triangle,
            };
            img = img.resize_exact(width, height, filter);
        }
    } else {
        // Pad in the SOURCE frame (bias is anchored pre-rotation), then rotate/flip.
        img = pad_to_canvas(&img, width, height, fill_mode);
        img = match rotate {
            90 => img.rotate90(),
            180 => img.rotate180(),
            270 => img.rotate270(),
            _ => img,
        };
        if flip_h {
            img = img.fliph();
        }
        if flip_v {
            img = img.flipv();
        }
    }

    if blur_sigma_tenths > 0 {
        let sigma = blur_sigma_tenths as f32 / 10.0;
        img = image::DynamicImage::ImageRgba8(image::imageops::blur(&img, sigma));
    }

    // Unsharp mask after resize to recover crispness lost to upscaling (e.g. the
    // 293S's 72→85 enlarge). threshold 0 = sharpen every pixel.
    if sharpen_sigma_tenths > 0 {
        let sigma = sharpen_sigma_tenths as f32 / 10.0;
        img = image::DynamicImage::ImageRgba8(image::imageops::unsharpen(&img, sigma, 0));
    }

    // Only true passthrough (skip_resize with no padding) is exempt from max_bytes
    // enforcement; pad mode must still honour the cap (pad output is small, so this
    // rarely triggers).
    let lenient = skip_resize && fill_mode == 0;
    match format {
        1 => encode_bmp(img, bmp_ppm),
        _ => encode_jpeg(img, quality, max_bytes, lenient),
    }
}

/// Transform an image: explicit rotate/flip, optional resize to width×height,
/// then encode as JPEG (iterative quality down to <= max_bytes) or BMP. Result into `out_buf`.
/// (EXIF auto-rotate is intentionally not performed.)
///
/// format: 0 = JPEG, 1 = BMP. max_bytes: JPEG size cap (0 = no cap; ignored for BMP).
/// quality: 1..=100 percent (JPEG only). skip_resize / flip_h / flip_v: 0 or 1.
/// resize_filter: 0 = Triangle (default), 1 = Nearest.
/// fill_mode: 0 = resize (current behaviour, honours skip_resize); 1 = pad with a
/// black border; 2 = pad with an average-colour border; 3 = pad with an edge-clamp
/// (replicate) border. Pad modes (>0) keep the source pixels 1:1, centre them in a
/// width×height canvas with a floor-split (top-left bias) offset, fill the border
/// per the mode, and pad BEFORE rotate/flip so the centring bias is anchored to the
/// source frame. Inputs larger than the canvas in either axis fall back to a resize.
/// crop_px: pixels trimmed from every side of the source before rotate/flip/resize
/// (0 = none); ignored when it would leave a non-positive dimension.
///
/// Returns the number of bytes written into `out_buf` (>= 0), or a negative error code:
/// `-1` transform/encode error (UTF-8 message written into err_buf, NUL-terminated),
/// `-2` out_buf too small (out_cap insufficient) — caller may grow and retry,
/// `-3` panic caught at the FFI boundary.
///
/// # Safety
/// `jpeg_in`, `out_buf`, and `err_buf` must each be valid for `jpeg_in_len`,
/// `out_cap`, and `err_cap` bytes respectively (or null, which is handled), and
/// remain owned by the caller for the duration of the call.
#[allow(clippy::too_many_arguments)]
#[no_mangle]
pub unsafe extern "C" fn image_proc_transform(
    jpeg_in: *const u8,
    jpeg_in_len: usize,
    width: u32,
    height: u32,
    max_bytes: usize,
    quality: u32,     // 1..=100 (percent)
    skip_resize: i32, // 0 / 1
    rotate: u32,      // 0 | 90 | 180 | 270 (CW)
    flip_h: i32,      // 0 / 1
    flip_v: i32,      // 0 / 1
    format: i32,      // 0 = JPEG, 1 = BMP
    bmp_ppm: i32,
    blur_sigma_tenths: u32,    // Gaussian sigma × 10; 0 = no blur
    resize_filter: u32,        // 0 = Triangle (default), 1 = Nearest
    sharpen_sigma_tenths: u32, // unsharp-mask sigma × 10; 0 = no sharpen
    fill_mode: u32,            // 0 = resize; 1 = pad-black; 2 = pad-average; 3 = pad-edge-clamp
    crop_px: u32, // pixels to crop from every side of the source before resize; 0 = none
    out_buf: *mut u8,
    out_cap: usize,
    err_buf: *mut u8,
    err_cap: usize,
) -> i32 {
    let result = catch_unwind(AssertUnwindSafe(|| {
        if jpeg_in.is_null() || out_buf.is_null() {
            write_err("null pointer argument", err_buf, err_cap);
            return -1i32;
        }
        // SAFETY: jpeg_in is non-null (checked above) and, per the fn contract, valid
        // for jpeg_in_len bytes for the duration of the call.
        let input = unsafe { std::slice::from_raw_parts(jpeg_in, jpeg_in_len) };

        match transform(
            input,
            width,
            height,
            max_bytes,
            quality,
            skip_resize != 0,
            rotate,
            flip_h != 0,
            flip_v != 0,
            format,
            bmp_ppm,
            blur_sigma_tenths,
            resize_filter,
            sharpen_sigma_tenths,
            fill_mode,
            crop_px,
        ) {
            Ok(bytes) => {
                if bytes.len() > out_cap {
                    return -2;
                }
                // SAFETY: out_buf is non-null (checked above) and valid for out_cap
                // bytes per the fn contract; the bytes.len() <= out_cap guard above
                // keeps the copy in bounds.
                unsafe {
                    std::ptr::copy_nonoverlapping(bytes.as_ptr(), out_buf, bytes.len());
                }
                bytes.len() as i32
            }
            Err(msg) => {
                write_err(&msg, err_buf, err_cap);
                -1
            }
        }
    }));
    result.unwrap_or(-3)
}
