use image::{imageops::FilterType, DynamicImage};

/// Pad a source image into a `w`×`h` canvas, centred with a floor split (top-left
/// bias: offset = (canvas - src) / 2, rounding down). Inputs larger than the canvas
/// in either axis cannot be padded without cropping, so fall back to a resize.
///
/// `fill_mode`: 1 = black border, 2 = average-colour border, 3 = edge-clamp
/// (replicate nearest source pixel — interior, edges, and corners in one loop).
pub(crate) fn pad_to_canvas(src: &DynamicImage, w: u32, h: u32, fill_mode: u32) -> DynamicImage {
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
