use crate::util::{write_i32_le, write_u16_le, write_u32_le};
use image::RgbaImage;

pub(crate) fn encode_bmp(img: &RgbaImage, ppm: i32) -> Result<Vec<u8>, String> {
    let w = img.width() as usize;
    let h = img.height() as usize;
    let row_bytes = w * 3;
    // BMP rows are padded to 4 bytes; readers reject short files.
    let stride = (row_bytes + 3) & !3;
    let pixel_bytes = stride * h;
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
    write_u32_le(&mut buf, 34, pixel_bytes as u32); // biSizeImage
    write_i32_le(&mut buf, 38, ppm); // horizontal ppm
    write_i32_le(&mut buf, 42, ppm); // vertical ppm

    // Pixel data: BMP is bottom-up, BGR order.
    let pixels = img.as_raw(); // RGBA (alpha dropped), row-major top-to-bottom
    for row in 0..h {
        let bmp_row = h - 1 - row; // bottom-up
        let src_off = row * w * 4;
        let dst_off = 54 + bmp_row * stride;
        for col in 0..w {
            let r = pixels[src_off + col * 4];
            let g = pixels[src_off + col * 4 + 1];
            let b = pixels[src_off + col * 4 + 2];
            buf[dst_off + col * 3] = b; // BGR
            buf[dst_off + col * 3 + 1] = g;
            buf[dst_off + col * 3 + 2] = r;
        }
    }

    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::encode_bmp;
    use image::{DynamicImage, Rgb, RgbImage, RgbaImage};

    fn rgba(src: &RgbImage) -> RgbaImage {
        DynamicImage::ImageRgb8(src.clone()).to_rgba8()
    }

    fn gradient(w: u32, h: u32) -> RgbImage {
        RgbImage::from_fn(w, h, |x, y| {
            Rgb([(x * 7 + y) as u8, (y * 5 + x) as u8, (x + y * 3) as u8])
        })
    }

    #[test]
    fn unaligned_widths_round_trip() {
        for w in [1u32, 2, 3, 5, 85, 150] {
            let src = gradient(w, 7);
            let bmp = encode_bmp(&rgba(&src), 0).unwrap();
            let out = image::load_from_memory(&bmp).unwrap().to_rgb8();
            assert_eq!(out.dimensions(), (w, 7), "w={w}");
            assert_eq!(out.as_raw(), src.as_raw(), "w={w}");
        }
    }

    #[test]
    fn layout_is_padded_and_sizes_match() {
        for w in [1u32, 2, 3, 5, 85, 150] {
            let h = 4usize;
            let bmp = encode_bmp(&rgba(&gradient(w, h as u32)), 0).unwrap();
            let w = w as usize;
            let stride = (w * 3 + 3) & !3;
            assert_eq!(bmp.len(), 54 + stride * h, "w={w}");
            assert_eq!(
                u32::from_le_bytes(bmp[2..6].try_into().unwrap()) as usize,
                bmp.len()
            );
            assert_eq!(
                u32::from_le_bytes(bmp[34..38].try_into().unwrap()) as usize,
                stride * h
            );
            for row in 0..h {
                let pad = &bmp[54 + row * stride + w * 3..54 + (row + 1) * stride];
                assert!(pad.iter().all(|&b| b == 0), "w={w} row={row}");
            }
        }
    }

    #[test]
    fn aligned_width_matches_unpadded_layout() {
        let src = gradient(80, 80);
        let bmp = encode_bmp(&rgba(&src), 0).unwrap();
        assert_eq!(bmp.len(), 19254);
        let raw = src.as_raw();
        for row in 0..80usize {
            let dst = 54 + (79 - row) * 240;
            for col in 0..80usize {
                let s = row * 240 + col * 3;
                assert_eq!(
                    bmp[dst + col * 3..dst + col * 3 + 3],
                    [raw[s + 2], raw[s + 1], raw[s]]
                );
            }
        }
    }
}
