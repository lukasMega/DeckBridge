#[cfg(feature = "usb")]
mod hid;

#[cfg(target_os = "windows")]
mod mdns_windows;

mod bmp;
mod jpeg;
mod pad;
mod transform;
mod util;

// Encoder backend features are mutually exclusive: both crates link as
// `jpeg_encoder` (the fork keeps the upstream lib name).
#[cfg(all(feature = "jpeg-upstream", feature = "jpeg-fork"))]
compile_error!("enable exactly one encoder backend: `jpeg-upstream` (default) or `jpeg-fork` (use --no-default-features)");
#[cfg(not(any(feature = "jpeg-upstream", feature = "jpeg-fork")))]
compile_error!("enable an encoder backend: `jpeg-upstream` (default) or `jpeg-fork`");

#[cfg(test)]
mod tests {
    use crate::bmp::encode_bmp;
    use crate::pad::pad_to_canvas;
    use crate::transform::transform;
    use crate::util::{write_i32_le, write_u16_le, write_u32_le};
    use image::DynamicImage;

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
