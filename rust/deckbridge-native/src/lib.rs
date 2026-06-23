use image::{imageops::FilterType, DynamicImage};
use std::io::Cursor;
use std::panic::{catch_unwind, AssertUnwindSafe};

#[cfg(feature = "usb")]
mod hid;

// Encoder backend features are mutually exclusive: both crates link as
// `jpeg_encoder` (the fork keeps the upstream lib name).
#[cfg(all(feature = "jpeg-upstream", feature = "jpeg-fork"))]
compile_error!("enable exactly one encoder backend: `jpeg-upstream` (default) or `jpeg-fork` (use --no-default-features)");
#[cfg(not(any(feature = "jpeg-upstream", feature = "jpeg-fork")))]
compile_error!("enable an encoder backend: `jpeg-upstream` (default) or `jpeg-fork`");

fn write_err(msg: &str, err_buf: *mut u8, err_cap: usize) {
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

fn write_u32_le(buf: &mut [u8], off: usize, v: u32) {
    buf[off] = (v & 0xff) as u8;
    buf[off + 1] = ((v >> 8) & 0xff) as u8;
    buf[off + 2] = ((v >> 16) & 0xff) as u8;
    buf[off + 3] = ((v >> 24) & 0xff) as u8;
}

fn write_i32_le(buf: &mut [u8], off: usize, v: i32) {
    write_u32_le(buf, off, v as u32);
}

fn write_u16_le(buf: &mut [u8], off: usize, v: u16) {
    buf[off] = (v & 0xff) as u8;
    buf[off + 1] = ((v >> 8) & 0xff) as u8;
}

fn encode_bmp(img: DynamicImage, ppm: i32) -> Result<Vec<u8>, String> {
    let rgb = img.to_rgb8();
    let w = rgb.width() as usize;
    let h = rgb.height() as usize;
    let row_bytes = w * 3;
    let pixel_bytes = row_bytes * h;
    let file_size = 54 + pixel_bytes;

    let mut buf = vec![0u8; file_size];

    // BITMAPFILEHEADER (14 bytes)
    buf[0] = 0x42;
    buf[1] = 0x4d; // 'BM'
    write_u32_le(&mut buf, 2, file_size as u32);
    write_u32_le(&mut buf, 10, 54); // pixel data offset

    // BITMAPINFOHEADER (40 bytes at offset 14)
    write_u32_le(&mut buf, 14, 40); // header size
    write_i32_le(&mut buf, 18, w as i32);
    write_i32_le(&mut buf, 22, h as i32);
    write_u16_le(&mut buf, 26, 1); // color planes
    write_u16_le(&mut buf, 28, 24); // bits per pixel
    write_i32_le(&mut buf, 38, ppm); // horizontal ppm
    write_i32_le(&mut buf, 42, ppm); // vertical ppm

    // Pixel data: BMP is bottom-up, BGR order.
    let pixels = rgb.as_raw(); // RGB, row-major top-to-bottom
    for row in 0..h {
        let bmp_row = h - 1 - row; // bottom-up
        let src_off = row * row_bytes;
        let dst_off = 54 + bmp_row * row_bytes;
        for col in 0..w {
            let r = pixels[src_off + col * 3];
            let g = pixels[src_off + col * 3 + 1];
            let b = pixels[src_off + col * 3 + 2];
            buf[dst_off + col * 3] = b; // BGR
            buf[dst_off + col * 3 + 1] = g;
            buf[dst_off + col * 3 + 2] = r;
        }
    }

    Ok(buf)
}

fn encode_jpeg(
    img: DynamicImage,
    quality: u32,
    max_bytes: usize,
    skip_resize: bool,
) -> Result<Vec<u8>, String> {
    // quality arrives as 1..=100 percent
    let mut q = quality.clamp(1, 100) as u8;

    // jpeg-encoder (not the `image` crate's encoder) with 4:2:0 chroma
    // subsampling, baseline, single interleaved scan — the format the K1 Pro
    // firmware decoder requires (probe round 5). With the `jpeg-fork` feature
    // the vendored fork additionally keeps optimized Huffman tables
    // interleaved (~20% smaller files; upstream would switch to one scan per
    // component, which the device can't decode) — see
    // .claude/plans/K1Pro/jpeg-artifact-findings.md.
    let rgb = img.to_rgb8();
    let (w, h) = (rgb.width(), rgb.height());
    let w16 = u16::try_from(w).map_err(|_| format!("image width {} exceeds u16", w))?;
    let h16 = u16::try_from(h).map_err(|_| format!("image height {} exceeds u16", h))?;

    loop {
        let mut buf = Vec::new();
        let mut encoder = jpeg_encoder::Encoder::new(&mut buf, q);
        encoder.set_sampling_factor(jpeg_encoder::SamplingFactor::F_2_2); // 4:2:0
                                                                          // Fork only: upstream would emit non-interleaved scans here (device-fatal).
        #[cfg(feature = "jpeg-fork")]
        encoder.set_optimized_huffman_tables(true);
        if let Err(e) = encoder.encode(rgb.as_raw(), w16, h16, jpeg_encoder::ColorType::Rgb) {
            return Err(format!("Encode error: {}", e));
        }

        if skip_resize || max_bytes == 0 || buf.len() <= max_bytes || q <= 1 {
            if !skip_resize && max_bytes > 0 && buf.len() > max_bytes {
                return Err(format!(
                    "JPEG output {} bytes exceeds limit {} at quality {}",
                    buf.len(),
                    max_bytes,
                    q
                ));
            }
            return Ok(buf);
        }

        if q > 5 {
            q -= 5;
        } else {
            q = 1;
        }
    }
}

/// Pad a source image into a `w`×`h` canvas, centred with a floor split (top-left
/// bias: offset = (canvas - src) / 2, rounding down). Inputs larger than the canvas
/// in either axis cannot be padded without cropping, so fall back to a resize.
///
/// `fill_mode`: 1 = black border, 2 = average-colour border, 3 = edge-clamp
/// (replicate nearest source pixel — interior, edges, and corners in one loop).
fn pad_to_canvas(src: &DynamicImage, w: u32, h: u32, fill_mode: u32) -> DynamicImage {
    let s = src.to_rgba8();
    let (sw, sh) = (s.width(), s.height());
    if sw > w || sh > h {
        return src.resize_exact(w, h, FilterType::Triangle);
    }
    let off_x = (w - sw) / 2; // floor → top-left bias
    let off_y = (h - sh) / 2;
    let mut out = image::RgbaImage::new(w, h);

    match fill_mode {
        3 => {
            // edge-clamp: one loop covers interior + edges + corners
            for y in 0..h {
                let sy = (y as i32 - off_y as i32).clamp(0, sh as i32 - 1) as u32;
                for x in 0..w {
                    let sx = (x as i32 - off_x as i32).clamp(0, sw as i32 - 1) as u32;
                    out.put_pixel(x, y, *s.get_pixel(sx, sy));
                }
            }
        }
        _ => {
            // 1 = black, 2 = average
            let fill = if fill_mode == 2 {
                average_rgba(&s)
            } else {
                image::Rgba([0, 0, 0, 255])
            };
            for p in out.pixels_mut() {
                *p = fill;
            }
            image::imageops::overlay(&mut out, &s, off_x as i64, off_y as i64);
        }
    }
    DynamicImage::ImageRgba8(out)
}

/// Mean RGB colour of an RGBA image, alpha forced to 255.
fn average_rgba(s: &image::RgbaImage) -> image::Rgba<u8> {
    let (mut r, mut g, mut b) = (0u64, 0u64, 0u64);
    let n = (s.width() * s.height()) as u64;
    for p in s.pixels() {
        r += p[0] as u64;
        g += p[1] as u64;
        b += p[2] as u64;
    }
    image::Rgba([(r / n) as u8, (g / n) as u8, (b / n) as u8, 255])
}

/// Private transform helper: decode, rotate/flip, resize, encode (JPEG or BMP).
/// EXIF auto-rotate is intentionally not performed (dropped for binary size — see plan).
// The flat parameter list mirrors the FFI ABI of image_proc_transform.
#[allow(clippy::too_many_arguments)]
fn transform(
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a minimal 54-byte BMP header (BITMAPFILEHEADER + BITMAPINFOHEADER)
    /// declaring the given dimensions, with no pixel data — enough for the
    /// decoder's dimension check to trip the configured `Limits`.
    fn make_bmp_header(width: i32, height: i32) -> Vec<u8> {
        let mut buf = vec![0u8; 54];

        // BITMAPFILEHEADER (14 bytes)
        buf[0] = 0x42;
        buf[1] = 0x4d; // 'BM'
        write_u32_le(&mut buf, 2, 54); // file size (header only)
        write_u32_le(&mut buf, 10, 54); // pixel data offset

        // BITMAPINFOHEADER (40 bytes at offset 14)
        write_u32_le(&mut buf, 14, 40); // header size
        write_i32_le(&mut buf, 18, width);
        write_i32_le(&mut buf, 22, height);
        write_u16_le(&mut buf, 26, 1); // color planes
        write_u16_le(&mut buf, 28, 24); // bits per pixel

        buf
    }

    #[test]
    fn bomb_rejected() {
        // 60000x60000 declared dimensions exceed the 500x500 Limits — must be
        // rejected before any pixel-data allocation is attempted.
        let bomb = make_bmp_header(60_000, 60_000);
        let result = transform(
            &bomb, 64, 64, 0, 80, false, 0, false, false, 0, 0, 0, 0, 0, 0, 0,
        );
        assert!(result.is_err(), "expected oversized BMP to be rejected");
    }

    #[test]
    fn normal_roundtrip_still_works() {
        // A small in-limits image must still decode and encode fine.
        let img = DynamicImage::new_rgb8(8, 8);
        let bmp = encode_bmp(img, 0).expect("encode_bmp should succeed");

        let out = transform(
            &bmp, 8, 8, 0, 80, true, 0, false, false, 0, 0, 0, 0, 0, 0, 0,
        )
        .expect("transform should succeed for an in-limits image");
        assert!(!out.is_empty(), "JPEG output should be non-empty");
    }

    // ── pad_to_canvas ──────────────────────────────────────────────────────────

    fn make_test_src() -> image::RgbaImage {
        // 8×8 RGBA, all pixels solid red except a distinct blue top-left corner
        // pixel, used to verify edge-clamp corner replication.
        let mut img = image::RgbaImage::new(8, 8);
        for p in img.pixels_mut() {
            *p = image::Rgba([255, 0, 0, 255]);
        }
        img.put_pixel(0, 0, image::Rgba([0, 0, 255, 255]));
        img
    }

    #[test]
    fn pad_to_canvas_dims_and_offset() {
        let src = DynamicImage::ImageRgba8(make_test_src());
        for fill_mode in [1u32, 2, 3] {
            let out = pad_to_canvas(&src, 12, 12, fill_mode);
            assert_eq!(out.width(), 12);
            assert_eq!(out.height(), 12);
            let rgba = out.to_rgba8();
            // offset = floor((12-8)/2) = 2 → source (0,0) lands at canvas (2,2)
            assert_eq!(*rgba.get_pixel(2, 2), image::Rgba([0, 0, 255, 255]));
        }
    }

    #[test]
    fn pad_to_canvas_black_border() {
        let src = DynamicImage::ImageRgba8(make_test_src());
        let out = pad_to_canvas(&src, 12, 12, 1).to_rgba8();
        // (0,0) is outside the centred 8×8 block (offset 2..10) → border, black.
        assert_eq!(*out.get_pixel(0, 0), image::Rgba([0, 0, 0, 255]));
    }

    #[test]
    fn pad_to_canvas_average_border() {
        let src = DynamicImage::ImageRgba8(make_test_src());
        let out = pad_to_canvas(&src, 12, 12, 2).to_rgba8();
        // src is almost entirely red with one blue pixel; average should be
        // close to red (not black, not blue).
        let border = out.get_pixel(0, 0);
        assert!(
            border[0] > border[2],
            "average border should lean red, got {:?}",
            border
        );
        assert_ne!(*border, image::Rgba([0, 0, 0, 255]));
    }

    #[test]
    fn pad_to_canvas_edge_clamp_corner_matches_source() {
        let src = DynamicImage::ImageRgba8(make_test_src());
        let out = pad_to_canvas(&src, 12, 12, 3).to_rgba8();
        // Canvas (0,0) clamps to source (0,0) — the blue corner pixel.
        assert_eq!(*out.get_pixel(0, 0), image::Rgba([0, 0, 255, 255]));
        // Canvas (11,11) clamps to source (7,7) — solid red.
        assert_eq!(*out.get_pixel(11, 11), image::Rgba([255, 0, 0, 255]));
    }

    #[test]
    fn pad_to_canvas_larger_than_canvas_falls_back_to_resize() {
        let src = DynamicImage::new_rgba8(20, 20);
        let out = pad_to_canvas(&src, 12, 12, 3);
        assert_eq!(out.width(), 12);
        assert_eq!(out.height(), 12);
    }
}
