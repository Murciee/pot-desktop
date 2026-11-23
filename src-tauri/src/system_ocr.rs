use dirs::cache_dir;

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineBox {
    pub text: String,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    pub bg_color: Option<[u8; 3]>,
    pub vertical: bool,
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

/// Detect whether a single OCR line is vertically oriented based on word centers
/// and aspect ratio. Single-word boxes never count as vertical lines.
#[allow(dead_code)]
pub fn is_line_vertical(word_rects: &[(f32, f32, f32, f32)], box_w: f32, box_h: f32) -> bool {
    if word_rects.len() < 2 || box_w <= 0.0 || box_h <= box_w * 1.4 {
        return false;
    }
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
    span_y > span_x * 1.3
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
        let vertical = is_line_vertical(&word_rects, box_w, box_h);

        out.push(RawOcrLine {
            text,
            x: min_x / ocr_scale,
            y: min_y / ocr_scale,
            w: box_w / ocr_scale,
            h: box_h / ocr_scale,
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
            let bg_color = sample_box_bg_color(&orig_rgba, line.x, line.y, line.w, line.h);
            LineBox {
                text: line.text,
                x: line.x,
                y: line.y,
                w: line.w,
                h: line.h,
                bg_color,
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
    fn vertical_detection_requires_multi_word_vertical_layout() {
        assert!(!is_line_vertical(&[(10.0, 10.0, 12.0, 40.0)], 12.0, 40.0));
        assert!(!is_line_vertical(
            &[(10.0, 10.0, 30.0, 16.0), (42.0, 10.0, 30.0, 16.0)],
            62.0,
            16.0
        ));
        assert!(is_line_vertical(
            &[(10.0, 10.0, 14.0, 14.0), (10.0, 30.0, 14.0, 14.0)],
            14.0,
            40.0
        ));
    }
}
