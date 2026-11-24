use dirs::cache_dir;

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineBox {
    pub text: String,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    pub line_size: f32,
    pub bg_color: Option<[u8; 3]>,
    pub fg_color: Option<[u8; 3]>,
    pub font_weight: u16,
    pub vertical: bool,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayImageAnalysis {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    pub line_size: Option<f32>,
    pub line_count: u32,
    pub vertical: bool,
    pub bg_color: Option<[u8; 3]>,
    pub fg_color: Option<[u8; 3]>,
    pub font_weight: u16,
}

fn is_cjk_char(ch: char) -> bool {
    matches!(
        ch as u32,
        0x3400..=0x9FFF | 0xF900..=0xFAFF | 0x3040..=0x30FF | 0xAC00..=0xD7AF
    )
}

#[allow(dead_code)]
fn median_channel(values: &mut Vec<u8>) -> u8 {
    if values.is_empty() {
        return 255;
    }
    values.sort_unstable();
    let mid = values.len() / 2;
    if values.len() % 2 == 0 {
        ((values[mid - 1] as u16 + values[mid] as u16) / 2) as u8
    } else {
        values[mid]
    }
}

/// Sample the perimeter just outside `[x, y, x+w, y+h]` on the unscaled image
/// and compute per-channel medians so stray glyph strokes do not skew the fill color.
#[allow(dead_code)]
pub fn sample_box_bg_color(
    img: &image::RgbaImage,
    x: f32,
    y: f32,
    w: f32,
    h: f32,
) -> Option<[u8; 3]> {
    let img_w = img.width() as i32;
    let img_h = img.height() as i32;
    if img_w <= 0 || img_h <= 0 {
        return None;
    }

    let left = (x.floor() as i32 - 2).clamp(0, img_w - 1);
    let top = (y.floor() as i32 - 2).clamp(0, img_h - 1);
    let right = ((x + w).ceil() as i32 + 1).clamp(0, img_w - 1);
    let bottom = ((y + h).ceil() as i32 + 1).clamp(0, img_h - 1);

    let mut rs = Vec::with_capacity(48);
    let mut gs = Vec::with_capacity(48);
    let mut bs = Vec::with_capacity(48);

    let mut push_px = |px: i32, py: i32| {
        let p = img.get_pixel(px as u32, py as u32);
        rs.push(p[0]);
        gs.push(p[1]);
        bs.push(p[2]);
    };

    let h_span = (right - left).max(1);
    let h_step = (h_span / 12).max(1);
    let mut cx = left;
    while cx <= right {
        push_px(cx, top);
        if bottom != top {
            push_px(cx, bottom);
        }
        cx += h_step;
    }

    let v_span = (bottom - top).max(1);
    let v_step = (v_span / 12).max(1);
    let mut cy = top + v_step;
    while cy < bottom {
        push_px(left, cy);
        if right != left {
            push_px(right, cy);
        }
        cy += v_step;
    }

    if rs.is_empty() {
        return None;
    }
    Some([
        median_channel(&mut rs),
        median_channel(&mut gs),
        median_channel(&mut bs),
    ])
}

/// Detect whether a single OCR line is vertically oriented based on word centers,
/// aspect ratio, and single-word multi-character heuristics.
#[allow(dead_code)]
pub fn is_line_vertical(
    word_rects: &[(f32, f32, f32, f32)],
    box_w: f32,
    box_h: f32,
    text: &str,
) -> bool {
    if word_rects.is_empty() || box_w <= 0.0 || box_h <= box_w * 1.35 {
        return false;
    }
    if word_rects.len() >= 2 {
        let mut min_cx = f32::MAX;
        let mut max_cx = f32::MIN;
        let mut min_cy = f32::MAX;
        let mut max_cy = f32::MIN;
        for &(wx, wy, ww, wh) in word_rects {
            let cx = wx + ww * 0.5;
            let cy = wy + wh * 0.5;
            min_cx = min_cx.min(cx);
            max_cx = max_cx.max(cx);
            min_cy = min_cy.min(cy);
            max_cy = max_cy.max(cy);
        }
        let span_x = (max_cx - min_cx).max(1.0);
        let span_y = max_cy - min_cy;
        return span_y > span_x * 1.25;
    }

    let cjk_chars = text.chars().filter(|&ch| is_cjk_char(ch)).count();
    let non_ws_chars = text.chars().filter(|ch| !ch.is_whitespace()).count();
    (cjk_chars >= 2 && box_h >= box_w * 1.45) || (non_ws_chars >= 2 && box_h >= box_w * 1.85)
}

fn median_f32(values: &mut [f32]) -> f32 {
    if values.is_empty() {
        return 0.0;
    }
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let mid = values.len() / 2;
    if values.len() % 2 == 0 {
        (values[mid - 1] + values[mid]) * 0.5
    } else {
        values[mid]
    }
}

fn percentile_f32(values: &mut [f32], p: f32) -> f32 {
    if values.is_empty() {
        return 0.0;
    }
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let idx = ((values.len() - 1) as f32 * p.clamp(0.0, 1.0)).round() as usize;
    values[idx.min(values.len() - 1)]
}

fn extract_bands(counts: &[usize], noise_floor: usize, max_gap: usize) -> Vec<(usize, usize)> {
    let mut active: Vec<bool> = counts.iter().map(|&c| c > noise_floor).collect();
    let len = active.len();
    let mut i = 0;
    while i < len {
        if active[i] {
            let mut gap_start = i + 1;
            while gap_start < len && active[gap_start] {
                gap_start += 1;
            }
            let mut gap_end = gap_start;
            while gap_end < len && !active[gap_end] {
                gap_end += 1;
            }
            if gap_end < len && gap_end > gap_start && (gap_end - gap_start) <= max_gap {
                for flag in &mut active[gap_start..gap_end] {
                    *flag = true;
                }
                i = gap_end;
                continue;
            }
            i = gap_end;
        } else {
            i += 1;
        }
    }

    let mut bands = Vec::new();
    let mut idx = 0;
    while idx < len {
        if active[idx] {
            let start = idx;
            while idx < len && active[idx] {
                idx += 1;
            }
            bands.push((start, idx - start));
        } else {
            idx += 1;
        }
    }
    bands
}

fn dominant_interior_bg(
    img: &image::RgbaImage,
    rx: u32,
    ry: u32,
    rw: u32,
    rh: u32,
) -> Option<[u8; 3]> {
    use std::collections::HashMap;

    let pad_x = if rw >= 12 { 2 } else { 0 };
    let pad_y = if rh >= 12 { 2 } else { 0 };
    let x0 = rx + pad_x;
    let y0 = ry + pad_y;
    let span_w = rw.saturating_sub(pad_x * 2).max(1);
    let span_h = rh.saturating_sub(pad_y * 2).max(1);

    let step_x = (span_w / 32).max(1);
    let step_y = (span_h / 32).max(1);

    let mut buckets: HashMap<(u8, u8, u8), Vec<[u8; 3]>> = HashMap::new();
    let mut y = y0;
    while y < y0 + span_h {
        let mut x = x0;
        while x < x0 + span_w {
            let p = img.get_pixel(x, y);
            let key = (p[0] >> 3, p[1] >> 3, p[2] >> 3);
            buckets.entry(key).or_default().push([p[0], p[1], p[2]]);
            x += step_x;
        }
        y += step_y;
    }

    let best = buckets.into_values().max_by_key(|samples| samples.len())?;
    let mut rs: Vec<u8> = best.iter().map(|c| c[0]).collect();
    let mut gs: Vec<u8> = best.iter().map(|c| c[1]).collect();
    let mut bs: Vec<u8> = best.iter().map(|c| c[2]).collect();
    Some([
        median_channel(&mut rs),
        median_channel(&mut gs),
        median_channel(&mut bs),
    ])
}

/// Analyze a cropped image region in pure Rust to extract tight text bounds,
/// horizontal/vertical orientation, calibrated line thickness, foreground/background
/// colors, and stroke-width-based font weight.
pub fn analyze_image_region(
    img: &image::RgbaImage,
    region_x: u32,
    region_y: u32,
    region_w: u32,
    region_h: u32,
) -> OverlayImageAnalysis {
    let img_w = img.width();
    let img_h = img.height();
    let rx = region_x.min(img_w);
    let ry = region_y.min(img_h);
    let rw = region_w.min(img_w.saturating_sub(rx));
    let rh = region_h.min(img_h.saturating_sub(ry));

    let bg_color = if rw >= 32 && rh >= 32 {
        dominant_interior_bg(img, rx, ry, rw, rh)
            .or_else(|| sample_box_bg_color(img, rx as f32, ry as f32, rw as f32, rh as f32))
    } else if rw > 0 && rh > 0 {
        sample_box_bg_color(img, rx as f32, ry as f32, rw as f32, rh as f32)
    } else {
        None
    };

    let fallback = OverlayImageAnalysis {
        x: 0.0,
        y: 0.0,
        w: region_w as f32,
        h: region_h as f32,
        line_size: None,
        line_count: 1,
        vertical: false,
        bg_color,
        fg_color: None,
        font_weight: 400,
    };

    if rw < 4 || rh < 4 {
        return fallback;
    }

    let bg = bg_color.unwrap_or([255, 255, 255]);
    let step: u32 = if rw.max(rh) > 1200 { 2 } else { 1 };
    let work_w = (rw / step).max(1);
    let work_h = (rh / step).max(1);
    let total_px = (work_w * work_h) as usize;

    let mut dists = vec![0u8; total_px];
    let mut hist = [0usize; 256];

    for wy in 0..work_h {
        let py = ry + wy * step;
        for wx in 0..work_w {
            let px = rx + wx * step;
            let p = img.get_pixel(px, py);
            let d = p[0]
                .abs_diff(bg[0])
                .max(p[1].abs_diff(bg[1]))
                .max(p[2].abs_diff(bg[2]));
            let idx = (wy * work_w + wx) as usize;
            dists[idx] = d;
            hist[d as usize] += 1;
        }
    }

    let p95_target = ((total_px as f32) * 0.95).ceil() as usize;
    let mut cum = 0usize;
    let mut p95 = 0u8;
    for (val, &count) in hist.iter().enumerate() {
        cum += count;
        if cum >= p95_target {
            p95 = val as u8;
            break;
        }
    }

    // Sparse text on a large canvas may occupy < 5% of pixels, so also inspect
    // the highest contrast reached by at least a small cluster of pixels.
    let min_ink_cluster = (total_px / 500).clamp(4, 16);
    let mut above = 0usize;
    let mut peak_contrast = 0u8;
    for val in (0..=255).rev() {
        above += hist[val];
        if above >= min_ink_cluster {
            peak_contrast = val as u8;
            break;
        }
    }
    let contrast = p95.max(peak_contrast);
    if contrast < 22 {
        return fallback;
    }

    let thresh = (contrast as f32 * 0.35).clamp(26.0, 85.0).round() as u8;
    let mut comp_id = vec![0u32; total_px];
    let mut comps: Vec<(u32, u32, u32, u32, usize)> = Vec::new();
    let mut stack: Vec<(u32, u32)> = Vec::new();

    for wy in 0..work_h {
        for wx in 0..work_w {
            let start_idx = (wy * work_w + wx) as usize;
            if dists[start_idx] < thresh || comp_id[start_idx] != 0 {
                continue;
            }
            let id = (comps.len() + 1) as u32;
            comp_id[start_idx] = id;
            stack.push((wx, wy));

            let mut min_x = wx;
            let mut max_x = wx;
            let mut min_y = wy;
            let mut max_y = wy;
            let mut area = 0usize;

            while let Some((cx, cy)) = stack.pop() {
                area += 1;
                min_x = min_x.min(cx);
                max_x = max_x.max(cx);
                min_y = min_y.min(cy);
                max_y = max_y.max(cy);

                let ny_start = cy.saturating_sub(1);
                let ny_end = (cy + 1).min(work_h - 1);
                let nx_start = cx.saturating_sub(1);
                let nx_end = (cx + 1).min(work_w - 1);

                for ny in ny_start..=ny_end {
                    for nx in nx_start..=nx_end {
                        let nidx = (ny * work_w + nx) as usize;
                        if dists[nidx] >= thresh && comp_id[nidx] == 0 {
                            comp_id[nidx] = id;
                            stack.push((nx, ny));
                        }
                    }
                }
            }

            comps.push((min_x, min_y, max_x, max_y, area));
        }
    }

    let min_comp_area = if step > 1 { 2 } else { 4 };
    let mut valid = vec![false; comps.len()];
    let mut valid_count = 0usize;

    for (idx, &(min_x, min_y, max_x, max_y, area)) in comps.iter().enumerate() {
        if area < min_comp_area {
            continue;
        }
        let cw = max_x - min_x + 1;
        let ch = max_y - min_y + 1;
        let touches_edge = min_x <= 1 || min_y <= 1 || max_x + 2 >= work_w || max_y + 2 >= work_h;
        if touches_edge {
            let thin_horiz_border =
                cw as f32 > work_w as f32 * 0.65 && (ch as f32) < (work_h as f32 * 0.12).max(6.0);
            let thin_vert_border =
                ch as f32 > work_h as f32 * 0.65 && (cw as f32) < (work_w as f32 * 0.12).max(6.0);
            let hollow_frame = cw as f32 > work_w as f32 * 0.85
                && ch as f32 > work_h as f32 * 0.85
                && (area as f32) < ((cw * ch) as f32) * 0.18;
            if thin_horiz_border || thin_vert_border || hollow_frame {
                continue;
            }
        }
        valid[idx] = true;
        valid_count += 1;
    }

    if valid_count == 0 {
        return fallback;
    }

    let mut tx_min = work_w;
    let mut ty_min = work_h;
    let mut tx_max = 0u32;
    let mut ty_max = 0u32;
    let mut char_estimates = Vec::with_capacity(valid_count);

    for (idx, &(min_x, min_y, max_x, max_y, _)) in comps.iter().enumerate() {
        if !valid[idx] {
            continue;
        }
        tx_min = tx_min.min(min_x);
        ty_min = ty_min.min(min_y);
        tx_max = tx_max.max(max_x);
        ty_max = ty_max.max(max_y);

        let cw = (max_x - min_x + 1) as f32;
        let ch = (max_y - min_y + 1) as f32;
        char_estimates.push(cw.max(ch).min(cw.min(ch) * 2.2));
    }

    let pad_work = (2 / step).max(1);
    let bx0 = tx_min.saturating_sub(pad_work);
    let by0 = ty_min.saturating_sub(pad_work);
    let bx1 = (tx_max + 1 + pad_work).min(work_w);
    let by1 = (ty_max + 1 + pad_work).min(work_h);
    let bw = bx1.saturating_sub(bx0);
    let bh = by1.saturating_sub(by0);
    if bw == 0 || bh == 0 {
        return fallback;
    }

    let mut fg_rs = Vec::new();
    let mut fg_gs = Vec::new();
    let mut fg_bs = Vec::new();
    let mut total_ink_px = 0usize;
    let mut row_ink = vec![0usize; bh as usize];
    let mut col_ink = vec![0usize; bw as usize];
    let mut mask_box = vec![false; (bw * bh) as usize];

    for wy in by0..by1 {
        let local_y = (wy - by0) as usize;
        let py = ry + wy * step;
        for wx in bx0..bx1 {
            let local_x = (wx - bx0) as usize;
            let cid = comp_id[(wy * work_w + wx) as usize];
            if cid > 0 && valid[(cid - 1) as usize] {
                mask_box[local_y * (bw as usize) + local_x] = true;
                row_ink[local_y] += 1;
                col_ink[local_x] += 1;
                total_ink_px += 1;
                let p = img.get_pixel(rx + wx * step, py);
                fg_rs.push(p[0]);
                fg_gs.push(p[1]);
                fg_bs.push(p[2]);
            }
        }
    }

    let fg_color = if fg_rs.is_empty() {
        None
    } else {
        Some([
            median_channel(&mut fg_rs),
            median_channel(&mut fg_gs),
            median_channel(&mut fg_bs),
        ])
    };

    let mut transitions = 0usize;
    let bw_usize = bw as usize;
    let bh_usize = bh as usize;
    for y in 0..bh_usize {
        let mut prev = false;
        for x in 0..bw_usize {
            let cur = mask_box[y * bw_usize + x];
            if cur != prev {
                transitions += 1;
                prev = cur;
            }
        }
        if prev {
            transitions += 1;
        }
    }
    for x in 0..bw_usize {
        let mut prev = false;
        for y in 0..bh_usize {
            let cur = mask_box[y * bw_usize + x];
            if cur != prev {
                transitions += 1;
                prev = cur;
            }
        }
        if prev {
            transitions += 1;
        }
    }
    let mean_stroke_width = (2.0 * total_ink_px as f32) / (transitions.max(1) as f32);

    let est_char = percentile_f32(&mut char_estimates, 0.75).max(8.0);
    let row_gap = (est_char * 0.14).round().max(1.0) as usize;
    let col_gap = (est_char * 0.18).round().max(2.0) as usize;
    let row_bands = extract_bands(&row_ink, 0, row_gap);
    let col_bands = extract_bands(&col_ink, 0, col_gap);

    let orient_row_gap = (est_char * 0.32).round().max(2.0) as usize;
    let row_bands_orient = extract_bands(&row_ink, 0, orient_row_gap);

    let substantial_col_bands: Vec<(usize, usize, f32, f32, bool)> = col_bands
        .iter()
        .filter_map(|&(cx, cw)| {
            let mut min_y = bh_usize;
            let mut max_y = 0usize;
            for y in 0..bh_usize {
                if (cx..cx + cw).any(|x| mask_box[y * bw_usize + x]) {
                    min_y = min_y.min(y);
                    max_y = max_y.max(y);
                }
            }
            if max_y < min_y {
                return None;
            }
            let ch = max_y - min_y + 1;
            let mut c_min_cx = f32::MAX;
            let mut c_max_cx = f32::MIN;
            let mut c_min_cy = f32::MAX;
            let mut c_max_cy = f32::MIN;
            let mut band_comp_count = 0usize;
            let abs_x0 = bx0 + cx as u32;
            let abs_x1 = abs_x0 + cw as u32;
            for (idx, &(min_x, cmin_y, max_x, cmax_y, _)) in comps.iter().enumerate() {
                if !valid[idx] {
                    continue;
                }
                if max_x >= abs_x0 && min_x < abs_x1 {
                    let ccx = (min_x + max_x) as f32 * 0.5;
                    let ccy = (cmin_y + cmax_y) as f32 * 0.5;
                    c_min_cx = c_min_cx.min(ccx);
                    c_max_cx = c_max_cx.max(ccx);
                    c_min_cy = c_min_cy.min(ccy);
                    c_max_cy = c_max_cy.max(ccy);
                    band_comp_count += 1;
                }
            }
            let stacked = band_comp_count >= 2
                && (c_max_cy - c_min_cy) > (c_max_cx - c_min_cx).max(1.0) * 1.25;
            Some((cx, cw, cw as f32, ch as f32, stacked))
        })
        .collect();

    let substantial_row_bands: Vec<(usize, usize, f32, f32)> = row_bands
        .iter()
        .filter_map(|&(ry_band, rh_band)| {
            let mut min_x = bw_usize;
            let mut max_x = 0usize;
            for x in 0..bw_usize {
                if (ry_band..ry_band + rh_band).any(|y| mask_box[y * bw_usize + x]) {
                    min_x = min_x.min(x);
                    max_x = max_x.max(x);
                }
            }
            if max_x < min_x {
                return None;
            }
            let rw_actual = max_x - min_x + 1;
            Some((ry_band, rh_band, rw_actual as f32, rh_band as f32))
        })
        .collect();

    let mut orient_row_aspects: Vec<f32> = row_bands_orient
        .iter()
        .filter_map(|&(ry_band, rh_band)| {
            let mut min_x = bw_usize;
            let mut max_x = 0usize;
            for x in 0..bw_usize {
                if (ry_band..ry_band + rh_band).any(|y| mask_box[y * bw_usize + x]) {
                    min_x = min_x.min(x);
                    max_x = max_x.max(x);
                }
            }
            if max_x < min_x || rh_band == 0 {
                return None;
            }
            Some((max_x - min_x + 1) as f32 / rh_band as f32)
        })
        .collect();

    let vertical = if substantial_col_bands.len() >= 2 {
        let mut col_aspects: Vec<f32> = substantial_col_bands
            .iter()
            .map(|&(_, _, cw, ch, _)| ch / cw.max(1.0))
            .collect();
        let med_col_aspect = median_f32(&mut col_aspects);
        let med_row_orient_aspect = median_f32(&mut orient_row_aspects);
        let stacked_cols = substantial_col_bands
            .iter()
            .filter(|&&(_, _, _, _, stacked)| stacked)
            .count();
        med_col_aspect >= 1.8
            && stacked_cols >= 1
            && (row_bands_orient.len() <= 2 || med_row_orient_aspect < med_col_aspect)
            && med_row_orient_aspect < med_col_aspect
    } else if col_bands.len() == 1 && (bh as f32) > (bw as f32) * 1.65 {
        let mut c_min_cx = f32::MAX;
        let mut c_max_cx = f32::MIN;
        let mut c_min_cy = f32::MAX;
        let mut c_max_cy = f32::MIN;
        let mut count = 0usize;
        for (idx, &(min_x, cmin_y, max_x, cmax_y, _)) in comps.iter().enumerate() {
            if !valid[idx] {
                continue;
            }
            let ccx = (min_x + max_x) as f32 * 0.5;
            let ccy = (cmin_y + cmax_y) as f32 * 0.5;
            c_min_cx = c_min_cx.min(ccx);
            c_max_cx = c_max_cx.max(ccx);
            c_min_cy = c_min_cy.min(ccy);
            c_max_cy = c_max_cy.max(ccy);
            count += 1;
        }
        count >= 2 && (c_max_cy - c_min_cy) > (c_max_cx - c_min_cx).max(1.0) * 1.4
    } else {
        false
    };

    let raw_ink_line_size = if vertical {
        let mut widths: Vec<f32> = substantial_col_bands
            .iter()
            .filter(|&&(_, _, cw, _, _)| cw >= est_char * 0.35)
            .map(|&(_, _, cw, _, _)| cw)
            .collect();
        if widths.is_empty() {
            widths = substantial_col_bands.iter().map(|&(_, _, cw, _, _)| cw).collect();
        }
        if widths.is_empty() {
            bw as f32
        } else {
            median_f32(&mut widths)
        }
    } else {
        let mut heights: Vec<f32> = substantial_row_bands
            .iter()
            .filter(|&&(_, _, _, rh_b)| rh_b >= est_char * 0.35)
            .map(|&(_, _, _, rh_b)| rh_b)
            .collect();
        if heights.is_empty() {
            heights = substantial_row_bands.iter().map(|&(_, _, _, rh_b)| rh_b).collect();
        }
        if heights.is_empty() {
            bh as f32
        } else {
            median_f32(&mut heights)
        }
    };

    let scale_f = step as f32;
    let calibrated_line_size = (raw_ink_line_size * scale_f * 1.04).max(7.0);
    let line_count = if vertical {
        substantial_col_bands.len().max(1) as u32
    } else {
        substantial_row_bands.len().max(1) as u32
    };

    let stroke_ratio = mean_stroke_width / raw_ink_line_size.max(1.0);
    let font_weight = if stroke_ratio >= 0.135 {
        700
    } else if stroke_ratio >= 0.105 {
        600
    } else {
        400
    };

    OverlayImageAnalysis {
        x: (bx0 as f32) * scale_f,
        y: (by0 as f32) * scale_f,
        w: ((bw as f32) * scale_f).min(rw as f32),
        h: ((bh as f32) * scale_f).min(rh as f32),
        line_size: Some(calibrated_line_size),
        line_count,
        vertical,
        bg_color,
        fg_color,
        font_weight,
    }
}

#[tauri::command(async)]
pub fn analyze_overlay_image(
    app_handle: tauri::AppHandle,
    padding_left: u32,
    padding_top: u32,
    width: u32,
    height: u32,
) -> Result<OverlayImageAnalysis, String> {
    let overlay_path = crate::cmd::overlay_cut_path(&app_handle)?;
    let source_path = if overlay_path.exists() {
        overlay_path
    } else {
        let mut fallback = cache_dir().ok_or_else(|| "Get Cache Dir Failed".to_string())?;
        fallback.push(&app_handle.config().tauri.bundle.identifier);
        fallback.push("pot_screenshot_cut.png");
        fallback
    };

    let rgba = image::open(&source_path)
        .map_err(|e| e.to_string())?
        .to_rgba8();
    Ok(analyze_image_region(
        &rgba,
        padding_left,
        padding_top,
        width.max(1),
        height.max(1),
    ))
}

/// Score raw (un-normalized) OCR line strings so `auto` chooses the language
/// engine that reads the image with the fewest intra-line CJK gaps or noise.
#[allow(dead_code)]
pub fn score_ocr_lines(raw_texts: &[&str]) -> f32 {
    let mut cjk = 0usize;
    let mut word_alpha = 0usize;
    let mut isolated_alpha = 0usize;
    let mut digits = 0usize;
    let mut intra_cjk_gaps = 0usize;
    let mut replacement = 0usize;

    for &line in raw_texts {
        let mut prev_non_space_cjk = false;
        let mut saw_space_since_cjk = false;
        let mut alpha_run = 0usize;

        let flush_alpha = |run: &mut usize, word: &mut usize, iso: &mut usize| {
            if *run >= 2 {
                *word += *run;
            } else if *run == 1 {
                *iso += 1;
            }
            *run = 0;
        };

        for ch in line.chars() {
            if ch == '\u{FFFD}' {
                flush_alpha(&mut alpha_run, &mut word_alpha, &mut isolated_alpha);
                replacement += 1;
                prev_non_space_cjk = false;
                saw_space_since_cjk = false;
            } else if ch.is_whitespace() {
                flush_alpha(&mut alpha_run, &mut word_alpha, &mut isolated_alpha);
                if prev_non_space_cjk {
                    saw_space_since_cjk = true;
                }
            } else if is_cjk_char(ch) {
                flush_alpha(&mut alpha_run, &mut word_alpha, &mut isolated_alpha);
                if prev_non_space_cjk && saw_space_since_cjk {
                    intra_cjk_gaps += 1;
                }
                cjk += 1;
                prev_non_space_cjk = true;
                saw_space_since_cjk = false;
            } else if ch.is_alphabetic() {
                alpha_run += 1;
                prev_non_space_cjk = false;
                saw_space_since_cjk = false;
            } else if ch.is_ascii_digit() {
                flush_alpha(&mut alpha_run, &mut word_alpha, &mut isolated_alpha);
                digits += 1;
                prev_non_space_cjk = false;
                saw_space_since_cjk = false;
            } else {
                flush_alpha(&mut alpha_run, &mut word_alpha, &mut isolated_alpha);
                prev_non_space_cjk = false;
                saw_space_since_cjk = false;
            }
        }
        flush_alpha(&mut alpha_run, &mut word_alpha, &mut isolated_alpha);
    }

    (cjk as f32) * 2.5
        + (word_alpha as f32) * 1.2
        + (isolated_alpha as f32) * 0.2
        + (digits as f32) * 0.3
        - (intra_cjk_gaps as f32) * 1.5
        - (replacement as f32) * 5.0
}

#[tauri::command(async)]
#[cfg(target_os = "windows")]
pub fn system_ocr(app_handle: tauri::AppHandle, lang: &str) -> Result<String, String> {
    use windows::core::HSTRING;
    use windows::Globalization::Language;
    use windows::Graphics::Imaging::BitmapDecoder;
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::{FileAccessMode, StorageFile};

    let mut app_cache_dir_path = cache_dir().expect("Get Cache Dir Failed");
    app_cache_dir_path.push(&app_handle.config().tauri.bundle.identifier);
    app_cache_dir_path.push("pot_screenshot_cut.png");

    let path = app_cache_dir_path.to_string_lossy().replace("\\\\?\\", "");

    let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(path))
        .unwrap()
        .get()
        .unwrap();

    let bitmap = BitmapDecoder::CreateWithIdAsync(
        BitmapDecoder::PngDecoderId().unwrap(),
        &file.OpenAsync(FileAccessMode::Read).unwrap().get().unwrap(),
    )
    .unwrap()
    .get()
    .unwrap();

    let bitmap = bitmap.GetSoftwareBitmapAsync().unwrap().get().unwrap();

    let engine = match lang {
        "auto" => OcrEngine::TryCreateFromUserProfileLanguages(),
        _ => {
            if let Ok(language) = Language::CreateLanguage(&HSTRING::from(lang)) {
                OcrEngine::TryCreateFromLanguage(&language)
            } else {
                return Err("Language Error".to_string());
            }
        }
    };

    match engine {
        Ok(v) => Ok(v
            .RecognizeAsync(&bitmap)
            .unwrap()
            .get()
            .unwrap()
            .Text()
            .unwrap()
            .to_string_lossy()),
        Err(e) => {
            if e.to_string().contains("0x00000000") {
                Err("Language package not installed!\n\nSee: https://learn.microsoft.com/zh-cn/windows/powertoys/text-extractor#supported-languages".to_string())
            } else {
                Err(e.to_string())
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn create_software_bitmap_from_rgba(
    rgba: &image::RgbaImage,
) -> Result<windows::Graphics::Imaging::SoftwareBitmap, String> {
    use windows::Graphics::Imaging::{BitmapAlphaMode, BitmapPixelFormat, SoftwareBitmap};
    use windows::Storage::Streams::DataWriter;

    let width = rgba.width();
    let height = rgba.height();
    let mut bgra = Vec::with_capacity((width * height * 4) as usize);
    for px in rgba.pixels() {
        bgra.push(px[2]);
        bgra.push(px[1]);
        bgra.push(px[0]);
        bgra.push(px[3]);
    }
    let writer = DataWriter::new().map_err(|e| e.to_string())?;
    writer.WriteBytes(&bgra).map_err(|e| e.to_string())?;
    let buffer = writer.DetachBuffer().map_err(|e| e.to_string())?;
    SoftwareBitmap::CreateCopyWithAlphaFromBuffer(
        &buffer,
        BitmapPixelFormat::Bgra8,
        width as i32,
        height as i32,
        BitmapAlphaMode::Premultiplied,
    )
    .map_err(|e| e.to_string())
}

#[cfg(target_os = "windows")]
struct RawOcrLine {
    text: String,
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    word_p75: f32,
    vertical: bool,
}

#[cfg(target_os = "windows")]
fn recognize_with_engine(
    engine: &windows::Media::Ocr::OcrEngine,
    bitmap: &windows::Graphics::Imaging::SoftwareBitmap,
    ocr_scale: f32,
) -> Result<Vec<RawOcrLine>, String> {
    let result = engine
        .RecognizeAsync(bitmap)
        .map_err(|e| e.to_string())?
        .get()
        .map_err(|e| e.to_string())?;
    let lines = result.Lines().map_err(|e| e.to_string())?;

    let mut out = Vec::new();
    let line_count = lines.Size().map_err(|e| e.to_string())?;
    for i in 0..line_count {
        let line = lines.GetAt(i).map_err(|e| e.to_string())?;
        let text = line
            .Text()
            .map_err(|e| e.to_string())?
            .to_string_lossy();
        if text.trim().is_empty() {
            continue;
        }

        let words = line.Words().map_err(|e| e.to_string())?;
        let word_count = words.Size().map_err(|e| e.to_string())?;
        let mut word_rects = Vec::with_capacity(word_count as usize);
        let mut min_x = f32::MAX;
        let mut min_y = f32::MAX;
        let mut max_x = f32::MIN;
        let mut max_y = f32::MIN;
        for j in 0..word_count {
            let word = words.GetAt(j).map_err(|e| e.to_string())?;
            let rect = word.BoundingRect().map_err(|e| e.to_string())?;
            min_x = min_x.min(rect.X);
            min_y = min_y.min(rect.Y);
            max_x = max_x.max(rect.X + rect.Width);
            max_y = max_y.max(rect.Y + rect.Height);
            word_rects.push((rect.X, rect.Y, rect.Width, rect.Height));
        }
        if word_rects.is_empty() {
            continue;
        }
        let box_w = max_x - min_x;
        let box_h = max_y - min_y;
        let vertical = is_line_vertical(&word_rects, box_w, box_h, &text);
        let mut word_spans: Vec<f32> = word_rects
            .iter()
            .map(|&(_, _, ww, wh)| (if vertical { ww } else { wh }) / ocr_scale)
            .collect();
        let word_p75 = percentile_f32(&mut word_spans, 0.75);

        out.push(RawOcrLine {
            text,
            x: min_x / ocr_scale,
            y: min_y / ocr_scale,
            w: box_w / ocr_scale,
            h: box_h / ocr_scale,
            word_p75,
            vertical,
        });
    }
    Ok(out)
}

#[cfg(target_os = "windows")]
fn collect_auto_engines() -> Vec<windows::Media::Ocr::OcrEngine> {
    use std::collections::HashSet;
    use windows::Media::Ocr::OcrEngine;

    let mut langs = Vec::new();
    if let Ok(available) = OcrEngine::AvailableRecognizerLanguages() {
        let count = available.Size().unwrap_or(0);
        for i in 0..count {
            if let Ok(lang) = available.GetAt(i) {
                let tag = lang
                    .LanguageTag()
                    .map(|s| s.to_string_lossy().to_lowercase())
                    .unwrap_or_default();
                langs.push((tag, lang));
            }
        }
    }

    let priority = ["zh-hans", "zh-cn", "en-us", "en", "ja", "ko"];
    let mut ordered = Vec::new();
    let mut seen = HashSet::new();

    for prefix in priority {
        for (tag, lang) in &langs {
            if (tag == prefix || tag.starts_with(&format!("{prefix}-"))) && seen.insert(tag.clone()) {
                ordered.push(lang.clone());
            }
        }
    }
    for (tag, lang) in &langs {
        if seen.insert(tag.clone()) {
            ordered.push(lang.clone());
        }
    }

    let mut engines = Vec::new();
    for lang in ordered.into_iter().take(6) {
        if let Ok(engine) = OcrEngine::TryCreateFromLanguage(&lang) {
            engines.push(engine);
        }
    }
    if engines.is_empty() {
        if let Ok(engine) = OcrEngine::TryCreateFromUserProfileLanguages() {
            engines.push(engine);
        }
    }
    engines
}

#[tauri::command(async)]
#[cfg(target_os = "windows")]
pub fn system_ocr_boxes(app_handle: tauri::AppHandle, lang: &str) -> Result<Vec<LineBox>, String> {
    use windows::core::HSTRING;
    use windows::Globalization::Language;
    use windows::Media::Ocr::OcrEngine;

    let overlay_path = crate::cmd::overlay_cut_path(&app_handle)?;
    let source_path = if overlay_path.exists() {
        overlay_path
    } else {
        let mut fallback = cache_dir().ok_or_else(|| "Get Cache Dir Failed".to_string())?;
        fallback.push(&app_handle.config().tauri.bundle.identifier);
        fallback.push("pot_screenshot_cut.png");
        fallback
    };

    let orig_rgba = image::open(&source_path)
        .map_err(|e| e.to_string())?
        .to_rgba8();
    let orig_w = orig_rgba.width();
    let orig_h = orig_rgba.height();
    if orig_w == 0 || orig_h == 0 {
        return Ok(Vec::new());
    }

    let max_dim = OcrEngine::MaxImageDimension().unwrap_or(2600);
    let can_upscale = orig_w < 1600
        && orig_h < 1600
        && orig_w.saturating_mul(2) <= max_dim
        && orig_h.saturating_mul(2) <= max_dim;

    let (ocr_scale, ocr_rgba) = if can_upscale {
        let resized = image::imageops::resize(
            &orig_rgba,
            orig_w * 2,
            orig_h * 2,
            image::imageops::FilterType::Lanczos3,
        );
        (2.0f32, resized)
    } else {
        (1.0f32, orig_rgba.clone())
    };

    let bitmap = create_software_bitmap_from_rgba(&ocr_rgba)?;

    let raw_lines = if lang != "auto" {
        let language =
            Language::CreateLanguage(&HSTRING::from(lang)).map_err(|_| "Language Error".to_string())?;
        let engine = OcrEngine::TryCreateFromLanguage(&language).map_err(|e| {
            if e.to_string().contains("0x00000000") {
                "Language package not installed!\n\nSee: https://learn.microsoft.com/zh-cn/windows/powertoys/text-extractor#supported-languages".to_string()
            } else {
                e.to_string()
            }
        })?;
        recognize_with_engine(&engine, &bitmap, ocr_scale)?
    } else {
        let engines = collect_auto_engines();
        let mut best_lines: Option<Vec<RawOcrLine>> = None;
        let mut best_score = f32::NEG_INFINITY;
        for engine in &engines {
            if let Ok(lines) = recognize_with_engine(engine, &bitmap, ocr_scale) {
                if lines.is_empty() {
                    continue;
                }
                let refs: Vec<&str> = lines.iter().map(|l| l.text.as_str()).collect();
                let score = score_ocr_lines(&refs);
                if score > best_score {
                    best_score = score;
                    best_lines = Some(lines);
                }
            }
        }
        best_lines.unwrap_or_default()
    };

    Ok(raw_lines
        .into_iter()
        .map(|line| {
            let rx = line.x.max(0.0).floor() as u32;
            let ry = line.y.max(0.0).floor() as u32;
            let rw = line.w.max(1.0).ceil() as u32;
            let rh = line.h.max(1.0).ceil() as u32;
            let analysis = analyze_image_region(&orig_rgba, rx, ry, rw, rh);
            let bg_color = analysis
                .bg_color
                .or_else(|| sample_box_bg_color(&orig_rgba, line.x, line.y, line.w, line.h));
            let line_size = match analysis.line_size {
                Some(ink_size) if line.word_p75 > 0.0 => {
                    ink_size.clamp(line.word_p75 * 0.78, line.word_p75 * 0.95)
                }
                Some(ink_size) => ink_size,
                None => (line.word_p75 * 0.90).max(7.0),
            };
            LineBox {
                text: line.text,
                x: line.x,
                y: line.y,
                w: line.w,
                h: line.h,
                line_size,
                bg_color,
                fg_color: analysis.fg_color,
                font_weight: analysis.font_weight,
                vertical: line.vertical,
            }
        })
        .collect())
}

#[tauri::command(async)]
#[cfg(not(target_os = "windows"))]
pub fn system_ocr_boxes(_app_handle: tauri::AppHandle, _lang: &str) -> Result<Vec<LineBox>, String> {
    Err("only windows".to_string())
}

#[tauri::command(async)]
#[cfg(target_os = "macos")]
pub fn system_ocr(app_handle: tauri::AppHandle, lang: &str) -> Result<String, String> {
    let mut app_cache_dir_path = cache_dir().expect("Get Cache Dir Failed");
    app_cache_dir_path.push(&app_handle.config().tauri.bundle.identifier);
    app_cache_dir_path.push("pot_screenshot_cut.png");

    let arch = std::env::consts::ARCH;
    let bin_path = match app_handle
        .path_resolver()
        .resolve_resource(format!("resources/ocr-{arch}-apple-darwin"))
    {
        Some(v) => v,
        None => return Err("Failed to resolve ocr binary".to_string()),
    };

    match std::process::Command::new("chmod")
        .arg("+x")
        .arg(bin_path.to_str().unwrap())
        .output()
    {
        Ok(_) => {}
        Err(e) => return Err(e.to_string()),
    }

    let output = match std::process::Command::new(bin_path)
        .arg(app_cache_dir_path.to_str().unwrap())
        .arg(lang)
        .output()
    {
        Ok(v) => v,
        Err(e) => return Err(e.to_string()),
    };

    if output.status.success() {
        let content = String::from_utf8(output.stdout).unwrap_or_default();
        Ok(content)
    } else {
        let content = String::from_utf8(output.stderr).unwrap_or_default();
        Err(content)
    }
}

#[tauri::command(async)]
#[cfg(target_os = "linux")]
pub fn system_ocr(app_handle: tauri::AppHandle, lang: &str) -> Result<String, String> {
    let mut app_cache_dir_path = cache_dir().expect("Get Cache Dir Failed");
    app_cache_dir_path.push(&app_handle.config().tauri.bundle.identifier);
    app_cache_dir_path.push("pot_screenshot_cut.png");
    let mut args = ["", ""];
    if lang != "auto" {
        args = ["-l", lang];
    }

    let output = match std::process::Command::new("tesseract")
        .arg(app_cache_dir_path.to_str().unwrap())
        .arg("stdout")
        .args(args)
        .output()
    {
        Ok(v) => v,
        Err(e) => {
            if e.to_string().contains("os error 2") {
                return Err("Tesseract not installed!".to_string());
            }
            return Err(e.to_string());
        }
    };
    if output.status.success() {
        let content = String::from_utf8(output.stdout).unwrap_or_default();
        Ok(content)
    } else {
        let content = String::from_utf8(output.stderr).unwrap_or_default();

        if content.contains("data") {
            if lang == "auto" {
                return Err(
                    "Language data not installed!\nPlease try install tesseract-ocr-eng"
                        .to_string(),
                );
            } else {
                return Err(format!(
                    "Language data not installed!\nPlease try install tesseract-ocr-{lang}"
                ));
            }
        }
        Err(content)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn score_prefers_clean_cjk_over_gapped_or_latin_noise() {
        let clean = score_ocr_lines(&["你好世界", "第二行中文"]);
        let gapped = score_ocr_lines(&["你 好 世 界", "第 二 行 中 文"]);
        let noise = score_ocr_lines(&["i l 1 0", "\u{FFFD}"]);
        assert!(clean > gapped);
        assert!(gapped > noise);
    }

    #[test]
    fn score_does_not_penalize_across_line_boundaries() {
        let multi = score_ocr_lines(&["第一行", "第二行"]);
        let single_with_gap = score_ocr_lines(&["第一行 第二行"]);
        assert!(multi > single_with_gap);
    }

    #[test]
    fn sample_bg_color_ignores_interior_text_and_outlier_edges() {
        let mut img = image::RgbaImage::from_pixel(40, 40, image::Rgba([20, 30, 40, 255]));
        for y in 12..28 {
            for x in 10..30 {
                img.put_pixel(x, y, image::Rgba([240, 240, 240, 255]));
            }
        }
        img.put_pixel(8, 10, image::Rgba([255, 0, 0, 255]));
        let color = sample_box_bg_color(&img, 10.0, 12.0, 20.0, 16.0).unwrap();
        assert_eq!(color, [20, 30, 40]);
    }

    #[test]
    fn vertical_detection_handles_multi_word_and_single_cjk_compound() {
        assert!(!is_line_vertical(&[(10.0, 10.0, 8.0, 30.0)], 8.0, 30.0, "I"));
        assert!(!is_line_vertical(
            &[(10.0, 10.0, 36.0, 16.0)],
            36.0,
            16.0,
            "会長"
        ));
        assert!(is_line_vertical(
            &[(10.0, 10.0, 14.0, 36.0)],
            14.0,
            36.0,
            "会長"
        ));
        assert!(!is_line_vertical(
            &[(10.0, 10.0, 30.0, 16.0), (42.0, 10.0, 30.0, 16.0)],
            62.0,
            16.0,
            "hello world"
        ));
        assert!(is_line_vertical(
            &[(10.0, 10.0, 14.0, 14.0), (10.0, 30.0, 14.0, 14.0)],
            14.0,
            40.0,
            "縦書き"
        ));
    }

    fn draw_block_glyph(
        img: &mut image::RgbaImage,
        x: u32,
        y: u32,
        size: u32,
        stroke: u32,
        fg: image::Rgba<u8>,
    ) {
        let s = stroke.max(1);
        for dy in 0..size {
            for dx in 0..size {
                if dx < s || dx + s >= size || dy < s || dy + s >= size {
                    img.put_pixel(x + dx, y + dy, fg);
                }
            }
        }
    }

    #[test]
    fn analyze_image_region_detects_vertical_columns_horizontal_lines_borders_and_weight() {
        let bg = image::Rgba([250, 250, 250, 255]);
        let fg = image::Rgba([20, 20, 20, 255]);

        // 1. 4-column vertical manga layout (including short 2-char leftmost column)
        let mut vertical_img = image::RgbaImage::from_pixel(260, 240, bg);
        let cols = [(185, 6), (135, 5), (85, 6), (35, 2)];
        for (cx, count) in cols {
            for r in 0..count {
                draw_block_glyph(&mut vertical_img, cx, 20 + r * 32, 26, 3, fg);
            }
        }
        let v_res = analyze_image_region(&vertical_img, 0, 0, 260, 240);
        assert!(v_res.vertical);
        assert_eq!(v_res.line_count, 4);
        assert!(v_res.line_size.unwrap() >= 22.0 && v_res.line_size.unwrap() <= 32.0);
        assert_eq!(v_res.fg_color, Some([20, 20, 20]));

        // 2. Single-column vertical strip
        let mut strip_img = image::RgbaImage::from_pixel(120, 180, bg);
        for r in 0..3 {
            draw_block_glyph(&mut strip_img, 46, 20 + r * 34, 26, 3, fg);
        }
        let s_res = analyze_image_region(&strip_img, 0, 0, 120, 180);
        assert!(s_res.vertical);
        assert_eq!(s_res.line_count, 1);

        // 3. 3-line horizontal paragraph with outer 2px border frame
        let mut horiz_img = image::RgbaImage::from_pixel(300, 180, bg);
        for x in 0..300 {
            horiz_img.put_pixel(x, 0, fg);
            horiz_img.put_pixel(x, 179, fg);
        }
        for y in 0..180 {
            horiz_img.put_pixel(0, y, fg);
            horiz_img.put_pixel(299, y, fg);
        }
        for row in 0..3 {
            for col in 0..7 {
                draw_block_glyph(&mut horiz_img, 30 + col * 28, 30 + row * 36, 22, 2, fg);
            }
        }
        let h_res = analyze_image_region(&horiz_img, 0, 0, 300, 180);
        assert!(!h_res.vertical);
        assert_eq!(h_res.line_count, 3);
        assert!(h_res.x >= 25.0 && h_res.w <= 240.0);
        assert!(h_res.line_size.unwrap() >= 18.0 && h_res.line_size.unwrap() <= 27.0);
        assert_eq!(h_res.font_weight, 400);

        // 4. Bold horizontal text
        let mut bold_img = image::RgbaImage::from_pixel(240, 80, bg);
        for col in 0..5 {
            draw_block_glyph(&mut bold_img, 20 + col * 36, 20, 28, 6, fg);
        }
        let b_res = analyze_image_region(&bold_img, 0, 0, 240, 80);
        assert!(!b_res.vertical);
        assert!(b_res.font_weight >= 600);
    }
}
