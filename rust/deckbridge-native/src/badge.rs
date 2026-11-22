use image::{Rgba, RgbaImage};

const RED: [u8; 3] = [220, 38, 38];
const WHITE: [u8; 3] = [255, 255, 255];

fn blend(px: &mut Rgba<u8>, color: [u8; 3], cover: f32) {
    for (dst, src) in px.0.iter_mut().zip(color) {
        *dst = (*dst as f32 + (src as f32 - *dst as f32) * cover).round() as u8;
    }
    px.0[3] = 255;
}

/// Draw a red circle with a white "!" in one corner of `img`: 1 = top-left, 2 = top-right,
/// 3 = bottom-right, 4 = bottom-left. Any other value draws nothing. The circle's diameter
/// is about 22 % of the shorter side; it stays inside the image on any size.
pub(crate) fn draw_badge(img: &mut RgbaImage, corner: u32) {
    if !(1..=4).contains(&corner) {
        return;
    }
    let (w, h) = img.dimensions();
    let side = w.min(h);
    let d = (side * 22 / 100).max(6).min(side);
    if d == 0 {
        return;
    }
    let margin = (d / 8).max(1);
    let x0 = if corner == 2 || corner == 3 {
        w.saturating_sub(d + margin)
    } else {
        margin.min(w - d)
    };
    let y0 = if corner == 3 || corner == 4 {
        h.saturating_sub(d + margin)
    } else {
        margin.min(h - d)
    };

    let r = d as f32 / 2.0;
    let (cx, cy) = (x0 as f32 + r, y0 as f32 + r);
    let half_bar = (r * 0.14).max(0.5);
    // The bar spans the upper part of the circle, the dot sits below it.
    let (bar_top, bar_bottom) = (cy - r * 0.55, cy + r * 0.12);
    let (dot_cy, dot_r) = (cy + r * 0.5, half_bar.max(0.7));

    for y in y0..y0 + d {
        for x in x0..x0 + d {
            let (fx, fy) = (x as f32 + 0.5, y as f32 + 0.5);
            let cover = (r - (fx - cx).hypot(fy - cy) + 0.5).clamp(0.0, 1.0);
            if cover <= 0.0 {
                continue;
            }
            let px = img.get_pixel_mut(x, y);
            blend(px, RED, cover);
            let in_bar = (fx - cx).abs() <= half_bar && fy >= bar_top && fy <= bar_bottom;
            let in_dot = (fx - cx).hypot(fy - dot_cy) <= dot_r;
            if in_bar || in_dot {
                blend(px, WHITE, cover);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::draw_badge;
    use image::{Rgba, RgbaImage};

    fn black(w: u32, h: u32) -> RgbaImage {
        RgbaImage::from_pixel(w, h, Rgba([0, 0, 0, 255]))
    }

    fn is_red(p: &Rgba<u8>) -> bool {
        p[0] > 150 && p[1] < 100
    }

    /// Red pixel counts per quadrant: [top-left, top-right, bottom-right, bottom-left].
    fn quadrants(img: &RgbaImage) -> [usize; 4] {
        let (hw, hh) = (img.width() / 2, img.height() / 2);
        let mut q = [0; 4];
        for (x, y, p) in img.enumerate_pixels() {
            if is_red(p) {
                q[match (x >= hw, y >= hh) {
                    (false, false) => 0,
                    (true, false) => 1,
                    (true, true) => 2,
                    (false, true) => 3,
                }] += 1;
            }
        }
        q
    }

    #[test]
    fn each_corner_gets_only_its_own_quadrant() {
        for corner in 1..=4u32 {
            let mut img = black(72, 72);
            draw_badge(&mut img, corner);
            let q = quadrants(&img);
            for (i, n) in q.iter().enumerate() {
                if i == corner as usize - 1 {
                    assert!(*n > 40, "corner {corner}: badge missing ({q:?})");
                } else {
                    assert_eq!(*n, 0, "corner {corner}: stray red in quadrant {i}");
                }
            }
            assert!(img.pixels().any(|p| p[0] > 240 && p[1] > 240 && p[2] > 240));
        }
    }

    #[test]
    fn zero_or_unknown_corner_changes_nothing() {
        for corner in [0u32, 5, 99] {
            let mut img = black(72, 72);
            draw_badge(&mut img, corner);
            assert_eq!(img, black(72, 72));
        }
    }

    #[test]
    fn tiny_and_odd_images_do_not_panic() {
        for (w, h) in [(1, 1), (3, 3), (5, 2), (6, 6), (100, 7), (7, 100)] {
            for corner in 1..=4u32 {
                draw_badge(&mut black(w, h), corner);
            }
        }
    }
}
