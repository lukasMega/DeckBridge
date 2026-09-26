#[cfg(feature = "usb")]
mod hid;

#[cfg(target_os = "windows")]
mod mdns_windows;

mod blit;
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
    use crate::pad::{pad_to_canvas, FILL_CROP_OVERSIZE};
    use crate::transform::transform;
    use crate::util::{write_i32_le, write_u16_le, write_u32_le};
    use image::imageops::FilterType;
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
        // 60000x60000 declared dimensions exceed the 800x500 Limits — must be
        // rejected before any pixel-data allocation is attempted.
        let bomb = make_bmp_header(60_000, 60_000);
        let result = transform(
            &bomb, 64, 64, 0, 80, false, 0, false, false, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        );
        assert!(result.is_err(), "expected oversized BMP to be rejected");
    }

    #[test]
    fn normal_roundtrip_still_works() {
        // A small in-limits image must still decode and encode fine.
        let img = DynamicImage::new_rgb8(8, 8);
        let bmp = encode_bmp(img, 0).expect("encode_bmp should succeed");

        let out = transform(
            &bmp, 8, 8, 0, 80, true, 0, false, false, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        )
        .expect("transform should succeed for an in-limits image");
        assert!(!out.is_empty(), "JPEG output should be non-empty");
    }

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
            let out = pad_to_canvas(&src, 12, 12, fill_mode, FilterType::Triangle);
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
        let out = pad_to_canvas(&src, 12, 12, 1, FilterType::Triangle).to_rgba8();
        // (0,0) is outside the centred 8×8 block (offset 2..10) → border, black.
        assert_eq!(*out.get_pixel(0, 0), image::Rgba([0, 0, 0, 255]));
    }

    #[test]
    fn pad_to_canvas_average_border() {
        let src = DynamicImage::ImageRgba8(make_test_src());
        let out = pad_to_canvas(&src, 12, 12, 2, FilterType::Triangle).to_rgba8();
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
        let out = pad_to_canvas(&src, 12, 12, 3, FilterType::Triangle).to_rgba8();
        // Canvas (0,0) clamps to source (0,0) — the blue corner pixel.
        assert_eq!(*out.get_pixel(0, 0), image::Rgba([0, 0, 255, 255]));
        // Canvas (11,11) clamps to source (7,7) — solid red.
        assert_eq!(*out.get_pixel(11, 11), image::Rgba([255, 0, 0, 255]));
    }

    #[test]
    fn pad_to_canvas_larger_than_canvas_falls_back_to_resize() {
        let src = DynamicImage::new_rgba8(20, 20);
        let out = pad_to_canvas(&src, 12, 12, 3, FilterType::Triangle);
        assert_eq!(out.width(), 12);
        assert_eq!(out.height(), 12);
    }

    #[test]
    fn crop_oversize_trims_centre_one_to_one() {
        // 120×120 into 112×112 (Stream Deck + art on an AKP05E key): trim 4 px per side.
        let mut src = image::RgbaImage::new(120, 120);
        src.put_pixel(4, 4, image::Rgba([0, 0, 255, 255]));
        src.put_pixel(115, 115, image::Rgba([0, 255, 0, 255]));
        let src = DynamicImage::ImageRgba8(src);
        for fill in [1u32, 2, 3] {
            let out = pad_to_canvas(
                &src,
                112,
                112,
                fill | FILL_CROP_OVERSIZE,
                FilterType::Triangle,
            )
            .to_rgba8();
            assert_eq!(out.dimensions(), (112, 112));
            assert_eq!(*out.get_pixel(0, 0), image::Rgba([0, 0, 255, 255]));
            assert_eq!(*out.get_pixel(111, 111), image::Rgba([0, 255, 0, 255]));
        }
    }

    #[test]
    fn crop_oversize_pads_undersize_axis() {
        // 800×100 into 176×112: crop x, pad y (black) → rows 0..6 are border.
        let mut src = image::RgbaImage::new(800, 100);
        for p in src.pixels_mut() {
            *p = image::Rgba([255, 0, 0, 255]);
        }
        let src = DynamicImage::ImageRgba8(src);
        let out =
            pad_to_canvas(&src, 176, 112, 1 | FILL_CROP_OVERSIZE, FilterType::Triangle).to_rgba8();
        assert_eq!(out.dimensions(), (176, 112));
        assert_eq!(*out.get_pixel(0, 0), image::Rgba([0, 0, 0, 255]));
        assert_eq!(*out.get_pixel(0, 6), image::Rgba([255, 0, 0, 255]));
        assert_eq!(*out.get_pixel(0, 106), image::Rgba([0, 0, 0, 255]));
    }

    #[test]
    fn region_crop_then_crop_fit_is_one_to_one() {
        // cropRect (20,10,112,112) of a 160×130 frame into a 112×112 key: the region's
        // corners land exactly on the output corners, no resampling.
        let mut src = image::RgbImage::from_pixel(160, 130, image::Rgb([255, 0, 0]));
        src.put_pixel(20, 10, image::Rgb([0, 0, 255]));
        src.put_pixel(131, 121, image::Rgb([0, 255, 0]));
        let bmp = encode_bmp(DynamicImage::ImageRgb8(src), 0).expect("encode_bmp");
        let out = transform(
            &bmp,
            112,
            112,
            0,
            80,
            false,
            0,
            false,
            false,
            1,
            0,
            0,
            0,
            0,
            3 | FILL_CROP_OVERSIZE,
            0,
            20,
            10,
            112,
            112,
        )
        .expect("transform with region crop");
        let out = image::load_from_memory(&out).expect("decode BMP").to_rgb8();
        assert_eq!(out.dimensions(), (112, 112));
        assert_eq!(*out.get_pixel(0, 0), image::Rgb([0, 0, 255]));
        assert_eq!(*out.get_pixel(111, 111), image::Rgb([0, 255, 0]));
        assert_eq!(*out.get_pixel(1, 1), image::Rgb([255, 0, 0]));
    }

    #[test]
    fn region_crop_is_clamped_to_source() {
        // A rect past the right/bottom edge is clamped, not rejected.
        let bmp = encode_bmp(DynamicImage::new_rgb8(16, 16), 0).expect("encode_bmp");
        let out = transform(
            &bmp, 16, 16, 0, 80, false, 0, false, false, 1, 0, 0, 0, 0, 0, 0, 12, 12, 100, 100,
        )
        .expect("oversize region must clamp");
        let out = image::load_from_memory(&out).expect("decode BMP");
        assert_eq!((out.width(), out.height()), (16, 16));
    }

    #[test]
    fn crop_oversize_smaller_source_matches_pad() {
        let src = DynamicImage::ImageRgba8(make_test_src());
        for fill in [1u32, 2, 3] {
            let pad = pad_to_canvas(&src, 12, 12, fill, FilterType::Triangle).to_rgba8();
            let crop = pad_to_canvas(
                &src,
                12,
                12,
                fill | FILL_CROP_OVERSIZE,
                FilterType::Triangle,
            )
            .to_rgba8();
            assert_eq!(pad, crop);
        }
    }
}
