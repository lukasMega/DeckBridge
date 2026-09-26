use image::{imageops::FilterType, DynamicImage};

/// `fill_mode` bit: centre-crop axes where the source is larger than the canvas
/// instead of falling back to a resize (resizeMode 'crop').
pub(crate) const FILL_CROP_OVERSIZE: u32 = 4;

/// Place a source image 1:1 into a `w`×`h` canvas, centred with a floor split
/// (top-left bias: offset = floor((canvas - src) / 2)).
///
/// `fill_mode` low bits: 1 = black border, 2 = average-colour border, 3 = edge-clamp
/// (replicate nearest source pixel). Without `FILL_CROP_OVERSIZE`, a source larger
/// than the canvas in either axis cannot be padded without cropping, so it falls back
/// to a resize with `filter`; with it, the oversize axes are centre-cropped.
pub(crate) fn pad_to_canvas(
    src: &DynamicImage,
    w: u32,
    h: u32,
    fill_mode: u32,
    filter: FilterType,
) -> DynamicImage {
    let s = src.to_rgba8();
    let (sw, sh) = (s.width(), s.height());
    let crop = fill_mode & FILL_CROP_OVERSIZE != 0;
    if !crop && (sw > w || sh > h) {
        return src.resize_exact(w, h, filter);
    }
    // Negative offset = centre-crop on that axis.
    let off_x = (w as i64 - sw as i64).div_euclid(2);
    let off_y = (h as i64 - sh as i64).div_euclid(2);
    let fill = match fill_mode & !FILL_CROP_OVERSIZE {
        2 => Some(average_rgba(&s)),
        3 => None,
        _ => Some(image::Rgba([0, 0, 0, 255])),
    };
    let mut out = image::RgbaImage::new(w, h);
    for y in 0..h {
        let sy = y as i64 - off_y;
        for x in 0..w {
            let sx = x as i64 - off_x;
            let inside = (0..sw as i64).contains(&sx) && (0..sh as i64).contains(&sy);
            let px = match fill {
                Some(f) if !inside => f,
                // Inside, or edge-clamp: one clamp covers interior, edges and corners.
                _ => *s.get_pixel(
                    sx.clamp(0, sw as i64 - 1) as u32,
                    sy.clamp(0, sh as i64 - 1) as u32,
                ),
            };
            out.put_pixel(x, y, px);
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
