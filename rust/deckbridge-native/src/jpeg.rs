use image::DynamicImage;

pub(crate) fn encode_jpeg(
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
