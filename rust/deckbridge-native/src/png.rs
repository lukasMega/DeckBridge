use image::{RgbImage, RgbaImage};

/// Palette sizes tried, in order, when a truecolor PNG overshoots `max_bytes`.
/// Each is an image-derived (median-cut) palette with error-diffusion dithering.
const PALETTE_SIZES: [usize; 2] = [256, 64];

/// Encode an image as PNG, optionally under a byte budget.
///
/// The Ulanzi D200 firmware unzips PNGs out of a page manifest and (on at least
/// one firmware generation) silently drops archives past ~196 KB, and every byte
/// costs ~1 ms of USB time, so a 13-key page has a real per-icon budget.
/// `max_bytes == 0` disables the palette fallback.
///
/// Unlike `encode_jpeg`, exceeding the cap is NOT an error: PNG has no quality
/// knob to blame, and a slightly oversized icon still renders. The smallest
/// candidate is returned instead.
pub(crate) fn encode_png(img: &RgbaImage, max_bytes: usize) -> Result<Vec<u8>, String> {
    // Alpha dropped by hand: DynamicImage conversions pull 16-bit/float code into the build.
    let raw: Vec<u8> = img
        .as_raw()
        .chunks_exact(4)
        .flat_map(|p| [p[0], p[1], p[2]])
        .collect();
    let rgb = RgbImage::from_raw(img.width(), img.height(), raw)
        .ok_or_else(|| "PNG encode error: bad buffer size".to_string())?;

    let truecolor = encode_rgb(&rgb)?;
    if max_bytes == 0 || truecolor.len() <= max_bytes {
        return Ok(truecolor);
    }

    let mut smallest = truecolor;
    for &size in PALETTE_SIZES.iter() {
        let candidate = encode_indexed(&rgb, size)?;
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

fn encode_indexed(rgb: &RgbImage, size: usize) -> Result<Vec<u8>, String> {
    let palette = median_cut(rgb, size);
    let indices = dither(rgb, &palette);
    let flat: Vec<u8> = palette.iter().flatten().copied().collect();

    let mut buf = Vec::new();
    {
        let mut encoder = ::png::Encoder::new(&mut buf, rgb.width(), rgb.height());
        encoder.set_color(::png::ColorType::Indexed);
        encoder.set_depth(::png::BitDepth::Eight);
        encoder.set_palette(flat);
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

/// Median-cut palette: repeatedly split the most populated box at the median of
/// its widest channel, then average each box. Own code on purpose: the usual
/// quantiser crates are GPL/commercial or pull in dependencies we avoid.
fn median_cut(rgb: &RgbImage, size: usize) -> Vec<[u8; 3]> {
    let mut pixels: Vec<[u8; 3]> = rgb.pixels().map(|p| p.0).collect();
    let mut boxes: Vec<std::ops::Range<usize>> = Vec::with_capacity(size);
    boxes.push(0..pixels.len());
    while boxes.len() < size {
        // Split the most populated box that still has colour spread.
        let pick = boxes
            .iter()
            .enumerate()
            .filter(|(_, r)| r.len() > 1 && widest_channel(&pixels[(*r).clone()]).1 > 0)
            .max_by_key(|(_, r)| r.len())
            .map(|(i, _)| i);
        let Some(i) = pick else { break };
        let r = boxes[i].clone();
        let (ch, _) = widest_channel(&pixels[r.clone()]);
        pixels[r.clone()].sort_unstable_by_key(|p| p[ch]);
        let mid = r.start + r.len() / 2;
        boxes[i] = r.start..mid;
        boxes.push(mid..r.end);
    }
    boxes
        .iter()
        .map(|r| {
            let n = r.len().max(1) as u64;
            let mut sum = [0u64; 3];
            for p in &pixels[r.clone()] {
                for c in 0..3 {
                    sum[c] += u64::from(p[c]);
                }
            }
            [(sum[0] / n) as u8, (sum[1] / n) as u8, (sum[2] / n) as u8]
        })
        .collect()
}

/// (channel index, spread) of the channel with the widest min..max range.
fn widest_channel(px: &[[u8; 3]]) -> (usize, u8) {
    let mut lo = [255u8; 3];
    let mut hi = [0u8; 3];
    for p in px {
        for c in 0..3 {
            lo[c] = lo[c].min(p[c]);
            hi[c] = hi[c].max(p[c]);
        }
    }
    (0..3)
        .map(|c| (c, hi[c] - lo[c]))
        .max_by_key(|&(_, spread)| spread)
        .unwrap_or((0, 0))
}

fn nearest(palette: &[[u8; 3]], c: [i32; 3]) -> usize {
    let mut best = 0;
    let mut best_d = i32::MAX;
    for (i, p) in palette.iter().enumerate() {
        let d = (0..3).map(|k| (c[k] - i32::from(p[k])).pow(2)).sum::<i32>();
        if d < best_d {
            best_d = d;
            best = i;
        }
    }
    best
}

/// Floyd-Steinberg error diffusion (left-to-right) onto `palette`. Smooths the
/// banding a plain nearest-colour map leaves on gradients.
fn dither(rgb: &RgbImage, palette: &[[u8; 3]]) -> Vec<u8> {
    let (w, h) = (rgb.width() as usize, rgb.height() as usize);
    let mut out = vec![0u8; w * h];
    // Error rows carry one pixel of padding on each side to skip edge checks.
    let mut cur = vec![[0i32; 3]; w + 2];
    let mut next = vec![[0i32; 3]; w + 2];
    for y in 0..h {
        for x in 0..w {
            let px = rgb.get_pixel(x as u32, y as u32).0;
            let e = cur[x + 1];
            let want: [i32; 3] =
                std::array::from_fn(|k| (i32::from(px[k]) + e[k] / 16).clamp(0, 255));
            let idx = nearest(palette, want);
            out[y * w + x] = idx as u8;
            let got = palette[idx];
            for k in 0..3 {
                let err = want[k] - i32::from(got[k]);
                cur[x + 2][k] += err * 7;
                next[x][k] += err * 3;
                next[x + 1][k] += err * 5;
                next[x + 2][k] += err;
            }
        }
        std::mem::swap(&mut cur, &mut next);
        next.iter_mut().for_each(|e| *e = [0; 3]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(w: u32, h: u32, c: [u8; 3]) -> RgbaImage {
        RgbaImage::from_pixel(w, h, image::Rgba([c[0], c[1], c[2], 255]))
    }

    #[test]
    fn emits_a_png_signature() {
        let out = encode_png(&solid(196, 196, [10, 20, 30]), 0).unwrap();
        assert_eq!(&out[..8], &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    }

    #[test]
    fn round_trips_through_the_decoder() {
        let out = encode_png(&solid(8, 4, [200, 100, 50]), 0).unwrap();
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
        let mut seed: u32 = 1;
        let mut img = RgbaImage::new(96, 96);
        for p in img.pixels_mut() {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            *p = image::Rgba([
                (seed >> 24) as u8,
                (seed >> 16) as u8,
                (seed >> 8) as u8,
                255,
            ]);
        }
        let full = encode_png(&img, 0).unwrap();
        let capped = encode_png(&img, full.len() / 2).unwrap();
        assert!(
            capped.len() < full.len(),
            "{} !< {}",
            capped.len(),
            full.len()
        );
    }

    #[test]
    fn adaptive_palette_keeps_a_gradient_close() {
        let rgb = RgbImage::from_fn(64, 64, |x, y| {
            image::Rgb([(x * 4) as u8, (y * 4) as u8, 128])
        });
        let palette = median_cut(&rgb, 64);
        assert!(palette.len() <= 64);
        let idx = dither(&rgb, &palette);
        // Mean absolute error per channel stays small for a smooth gradient.
        let mut err = 0u64;
        for (i, p) in rgb.pixels().enumerate() {
            let got = palette[idx[i] as usize];
            err +=
                p.0.iter()
                    .zip(got)
                    .map(|(a, b)| u64::from(a.abs_diff(b)))
                    .sum::<u64>();
        }
        assert!(
            err / (64 * 64 * 3) < 12,
            "mean error {}",
            err / (64 * 64 * 3)
        );
    }

    #[test]
    fn two_color_image_gets_two_palette_entries() {
        let rgb = RgbImage::from_fn(16, 16, |x, _| {
            if x < 8 {
                image::Rgb([255, 0, 0])
            } else {
                image::Rgb([0, 0, 255])
            }
        });
        let palette = median_cut(&rgb, 64);
        assert_eq!(palette.len(), 2);
    }
}
