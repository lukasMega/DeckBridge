use crate::util::{write_i32_le, write_u16_le, write_u32_le};
use image::DynamicImage;

pub(crate) fn encode_bmp(img: DynamicImage, ppm: i32) -> Result<Vec<u8>, String> {
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
