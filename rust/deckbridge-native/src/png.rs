use image::{DynamicImage, RgbImage};

/// Palette ladder walked when a truecolor PNG overshoots `max_bytes`: levels per
/// channel (R, G, B). Each step keeps the product <= 256 so the palette fits an
/// 8-bit indexed PNG, and trades colour fidelity for size the way the JPEG
/// quality ladder in jpeg.rs trades detail for size.
const PALETTE_LADDER: [(u32, u32, u32); 4] = [(6, 7, 6), (5, 5, 5), (4, 4, 4), (3, 3, 3)];

/// Encode an image as PNG, optionally under a byte budget.
///
/// The Ulanzi D200 firmware unzips PNGs out of a page manifest and (on at least
/// one firmware generation) silently drops archives past ~196 KB, so a 13-key
/// page has a real per-icon budget. `max_bytes == 0` disables the ladder.
///
/// Unlike `encode_jpeg`, exceeding the cap is NOT an error: PNG has no quality
/// knob to blame, and a slightly oversized icon still renders. The smallest
/// candidate is returned instead.
pub(crate) fn encode_png(img: DynamicImage, max_bytes: usize) -> Result<Vec<u8>, String> {
    let rgb = img.to_rgb8();

    let truecolor = encode_rgb(&rgb)?;
    if max_bytes == 0 || truecolor.len() <= max_bytes {
        return Ok(truecolor);
    }

    let mut smallest = truecolor;
    for &levels in PALETTE_LADDER.iter() {
        let candidate = encode_indexed(&rgb, levels)?;
        if candidate.len() <= max_bytes {
            return Ok(candidate);
        }
        if candidate.len() < smallest.len() {
            smallest = candidate;
        }
    }
    Ok(smallest)
}

fn encode_rgb(rgb: &RgbImage) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    {
        let mut encoder = ::png::Encoder::new(&mut buf, rgb.width(), rgb.height());
        encoder.set_color(::png::ColorType::Rgb);
        encoder.set_depth(::png::BitDepth::Eight);
        encoder.set_compression(::png::Compression::High);
        encoder.set_filter(::png::Filter::Adaptive);
        let mut writer = encoder
            .write_header()
            .map_err(|e| format!("PNG header error: {}", e))?;
        writer
            .write_image_data(rgb.as_raw())
            .map_err(|e| format!("PNG encode error: {}", e))?;
        writer
            .finish()
            .map_err(|e| format!("PNG finish error: {}", e))?;
    }
    Ok(buf)
}

/// Uniform quantisation: each channel is bucketed into `levels` steps and the
/// bucket triple indexes a precomputed palette. No dependency on a quantiser
/// crate — the palette is regular by construction, so the mapping is a divide
/// rather than a nearest-colour search.
fn encode_indexed(rgb: &RgbImage, levels: (u32, u32, u32)) -> Result<Vec<u8>, String> {
    let (lr, lg, lb) = levels;
    let palette = build_palette(levels);
    let indices: Vec<u8> = rgb
        .pixels()
        .map(|p| {
            let ri = bucket(p.0[0], lr);
            let gi = bucket(p.0[1], lg);
            let bi = bucket(p.0[2], lb);
            // Palette size is lr*lg*lb <= 256 by construction, so this fits a u8.
            (ri * lg * lb + gi * lb + bi) as u8
        })
        .collect();

    let mut buf = Vec::new();
    {
        let mut encoder = ::png::Encoder::new(&mut buf, rgb.width(), rgb.height());
        encoder.set_color(::png::ColorType::Indexed);
        encoder.set_depth(::png::BitDepth::Eight);
        encoder.set_palette(palette);
        encoder.set_compression(::png::Compression::High);
        encoder.set_filter(::png::Filter::Adaptive);
        let mut writer = encoder
            .write_header()
            .map_err(|e| format!("PNG header error: {}", e))?;
        writer
            .write_image_data(&indices)
            .map_err(|e| format!("PNG encode error: {}", e))?;
        writer
            .finish()
            .map_err(|e| format!("PNG finish error: {}", e))?;
    }
    Ok(buf)
}

/// Channel value -> bucket index in 0..levels.
fn bucket(v: u8, levels: u32) -> u32 {
    let scaled = u32::from(v) * levels / 256;
    scaled.min(levels - 1)
}

/// Bucket index -> the channel value at the centre of that bucket's range,
/// stretched so bucket 0 is 0 and the top bucket is 255.
fn level_value(i: u32, levels: u32) -> u8 {
    if levels <= 1 {
        return 0;
    }
    ((i * 255) / (levels - 1)) as u8
}

fn build_palette(levels: (u32, u32, u32)) -> Vec<u8> {
    let (lr, lg, lb) = levels;
    let mut palette = Vec::with_capacity((lr * lg * lb * 3) as usize);
    for r in 0..lr {
        for g in 0..lg {
            for b in 0..lb {
                palette.push(level_value(r, lr));
                palette.push(level_value(g, lg));
                palette.push(level_value(b, lb));
            }
        }
    }
    palette
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(w: u32, h: u32, c: [u8; 3]) -> DynamicImage {
        DynamicImage::ImageRgb8(RgbImage::from_pixel(w, h, image::Rgb(c)))
    }

    #[test]
    fn emits_a_png_signature() {
        let out = encode_png(solid(196, 196, [10, 20, 30]), 0).unwrap();
        assert_eq!(&out[..8], &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    }

    #[test]
    fn round_trips_through_the_decoder() {
        let out = encode_png(solid(8, 4, [200, 100, 50]), 0).unwrap();
        let decoder = ::png::Decoder::new(std::io::Cursor::new(&out));
        let mut reader = decoder.read_info().unwrap();
        let mut buf = vec![0; reader.output_buffer_size().unwrap()];
        let info = reader.next_frame(&mut buf).unwrap();
        assert_eq!((info.width, info.height), (8, 4));
        assert_eq!(&buf[..3], &[200, 100, 50]);
    }

    #[test]
    fn palette_ladder_shrinks_a_noisy_image() {
        // Per-pixel noise defeats the filters, so truecolor is genuinely large.
        let mut img = RgbImage::new(96, 96);
        for (x, y, p) in img.enumerate_pixels_mut() {
            *p = image::Rgb([
                (x * 7 % 256) as u8,
                (y * 13 % 256) as u8,
                ((x * y) % 256) as u8,
            ]);
        }
        let full = encode_png(DynamicImage::ImageRgb8(img.clone()), 0).unwrap();
        let capped = encode_png(DynamicImage::ImageRgb8(img), full.len() / 2).unwrap();
        assert!(
            capped.len() < full.len(),
            "{} !< {}",
            capped.len(),
            full.len()
        );
    }

    #[test]
    fn bucket_covers_the_full_range() {
        assert_eq!(bucket(0, 4), 0);
        assert_eq!(bucket(255, 4), 3);
        assert_eq!(level_value(0, 4), 0);
        assert_eq!(level_value(3, 4), 255);
    }
}
