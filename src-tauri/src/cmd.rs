use crate::config::get;
use crate::error::Error;
use crate::StringWrapper;
use crate::APP;
use log::{error, info};
use serde_json::{json, Value};
use std::io::Read;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CropInfo {
    pub padding_left: u32,
    pub padding_top: u32,
}

fn cache_file_path(
    app_handle: &tauri::AppHandle,
    filename: &str,
) -> Result<std::path::PathBuf, String> {
    let mut path = dirs::cache_dir().ok_or_else(|| "Get Cache Dir Failed".to_string())?;
    path.push(&app_handle.config().tauri.bundle.identifier);
    if !path.exists() {
        std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    }
    path.push(filename);
    Ok(path)
}

pub fn overlay_cut_path(app_handle: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    cache_file_path(app_handle, "pot_overlay_cut.png")
}

pub fn copy_screenshot_cut_to_overlay(app_handle: &tauri::AppHandle) {
    let src = match cache_file_path(app_handle, "pot_screenshot_cut.png") {
        Ok(p) => p,
        Err(e) => {
            log::warn!("Failed to resolve screenshot cut path: {}", e);
            return;
        }
    };
    let dst = match overlay_cut_path(app_handle) {
        Ok(p) => p,
        Err(e) => {
            log::warn!("Failed to resolve overlay cut path: {}", e);
            return;
        }
    };
    if src.exists() {
        if let Err(e) = std::fs::copy(&src, &dst) {
            log::warn!("Failed to copy screenshot cut to overlay cut: {}", e);
        }
    }
}

fn encode_file_base64(path: &std::path::Path) -> String {
    use base64::{engine::general_purpose, Engine as _};
    use std::fs::File;
    if !path.exists() {
        return String::new();
    }
    let mut file = match File::open(path) {
        Ok(f) => f,
        Err(e) => {
            error!("{:?}", e.to_string());
            return String::new();
        }
    };
    let mut vec = Vec::new();
    if let Err(e) = file.read_to_end(&mut vec) {
        error!("{:?}", e.to_string());
        return String::new();
    }
    general_purpose::STANDARD.encode(&vec).replace("\r\n", "")
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrImagePayload {
    pub base64: String,
    pub mime_type: String,
}

fn save_rgba_png_fast(img: &image::RgbaImage, dest_path: &std::path::Path) -> Result<(), String> {
    use image::codecs::png::{CompressionType, FilterType, PngEncoder};
    use image::ImageEncoder;
    use std::io::BufWriter;

    let file = std::fs::File::create(dest_path).map_err(|e| e.to_string())?;
    let writer = BufWriter::new(file);
    let encoder = PngEncoder::new_with_quality(writer, CompressionType::Fast, FilterType::Sub);
    encoder
        .write_image(
            img.as_raw(),
            img.width(),
            img.height(),
            image::ExtendedColorType::Rgba8,
        )
        .map_err(|e| e.to_string())
}

fn encode_ocr_image_payload(
    path: &std::path::Path,
    max_dimension: u32,
) -> Result<OcrImagePayload, String> {
    use base64::{engine::general_purpose, Engine as _};
    use image::codecs::jpeg::JpegEncoder;
    use image::imageops::FilterType;
    use image::ImageEncoder;

    let raw_bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let img = image::load_from_memory(&raw_bytes).map_err(|e| e.to_string())?;
    let max_dim = max_dimension.max(256);
    let resized = img.width() > max_dim || img.height() > max_dim;
    let processed = if resized {
        img.resize(max_dim, max_dim, FilterType::Triangle)
    } else {
        img
    };

    let rgb = processed.to_rgb8();
    let mut jpeg_bytes = Vec::new();
    JpegEncoder::new_with_quality(&mut jpeg_bytes, 88)
        .write_image(
            rgb.as_raw(),
            rgb.width(),
            rgb.height(),
            image::ExtendedColorType::Rgb8,
        )
        .map_err(|e| e.to_string())?;

    if !resized && raw_bytes.len() <= jpeg_bytes.len() {
        return Ok(OcrImagePayload {
            base64: general_purpose::STANDARD.encode(&raw_bytes),
            mime_type: "image/png".to_string(),
        });
    }

    Ok(OcrImagePayload {
        base64: general_purpose::STANDARD.encode(&jpeg_bytes),
        mime_type: "image/jpeg".to_string(),
    })
}

fn save_padded_crop(
    img: &image::RgbaImage,
    left: u32,
    top: u32,
    width: u32,
    height: u32,
    scale_factor: f64,
    dest_path: &std::path::Path,
) -> Result<CropInfo, String> {
    let padding = (8.0 * scale_factor.max(1.0)).round() as u32;
    let image_width = img.width();
    let image_height = img.height();
    let right = left.saturating_add(width).min(image_width);
    let bottom = top.saturating_add(height).min(image_height);
    if right <= left || bottom <= top {
        return Err("Invalid cut area after clamping".to_string());
    }
    let padded_left = left.saturating_sub(padding);
    let padded_top = top.saturating_sub(padding);
    let padded_right = right.saturating_add(padding).min(image_width);
    let padded_bottom = bottom.saturating_add(padding).min(image_height);
    let padded_width = padded_right - padded_left;
    let padded_height = padded_bottom - padded_top;
    info!(
        "Padded overlay crop: {}x{}+{}+{} (padding {})",
        padded_width, padded_height, padded_left, padded_top, padding
    );
    let cropped =
        image::imageops::crop_imm(img, padded_left, padded_top, padded_width, padded_height)
            .to_image();
    save_rgba_png_fast(&cropped, dest_path)?;
    Ok(CropInfo {
        padding_left: left - padded_left,
        padding_top: top - padded_top,
    })
}

#[tauri::command]
pub fn get_ocr_image_payload(
    app_handle: tauri::AppHandle,
    image_file: Option<String>,
    max_dimension: Option<u32>,
) -> Result<OcrImagePayload, String> {
    let target = match image_file.as_deref() {
        Some("pot_overlay_cut.png") => "pot_overlay_cut.png",
        _ => "pot_screenshot_cut.png",
    };
    let primary = cache_file_path(&app_handle, target)?;
    let path = if primary.exists() {
        primary
    } else if target == "pot_overlay_cut.png" {
        cache_file_path(&app_handle, "pot_screenshot_cut.png")?
    } else {
        return Err("OCR image file not found".to_string());
    };
    encode_ocr_image_payload(&path, max_dimension.unwrap_or(1600))
}

#[tauri::command]
pub fn get_overlay_base64(app_handle: tauri::AppHandle) -> String {
    if let Ok(overlay_path) = overlay_cut_path(&app_handle) {
        if overlay_path.exists() {
            return encode_file_base64(&overlay_path);
        }
    }
    if let Ok(screenshot_path) = cache_file_path(&app_handle, "pot_screenshot_cut.png") {
        return encode_file_base64(&screenshot_path);
    }
    String::new()
}

#[tauri::command(async)]
pub fn capture_overlay_region(
    app_handle: tauri::AppHandle,
    monitor_x: i32,
    monitor_y: i32,
    left: u32,
    top: u32,
    width: u32,
    height: u32,
    scale_factor: f64,
) -> Result<CropInfo, String> {
    let target_x = monitor_x + left as i32;
    let target_y = monitor_y + top as i32;

    #[cfg(target_os = "windows")]
    {
        let (rgba, mon_x, mon_y) =
            crate::screenshot::capture_monitor_rgba(monitor_x, monitor_y, Some((target_x, target_y)))?;
        let rel_left = if mon_x == monitor_x {
            left
        } else {
            (target_x - mon_x).max(0) as u32
        };
        let rel_top = if mon_y == monitor_y {
            top
        } else {
            (target_y - mon_y).max(0) as u32
        };
        let dest = overlay_cut_path(&app_handle)?;
        return save_padded_crop(&rgba, rel_left, rel_top, width, height, scale_factor, &dest);
    }

    #[cfg(not(target_os = "windows"))]
    {
        use screenshots::Screen;

        let screens = Screen::all().map_err(|e| e.to_string())?;
        let screen = screens
            .iter()
            .find(|s| s.display_info.x == monitor_x && s.display_info.y == monitor_y)
            .or_else(|| {
                screens.iter().find(|s| {
                    let d = s.display_info;
                    let w = ((d.width as f32) * d.scale_factor).round() as i32;
                    let h = ((d.height as f32) * d.scale_factor).round() as i32;
                    target_x >= d.x && target_x < d.x + w && target_y >= d.y && target_y < d.y + h
                })
            })
            .or_else(|| screens.iter().find(|s| s.display_info.is_primary))
            .or_else(|| screens.first())
            .ok_or_else(|| format!("Monitor at ({monitor_x}, {monitor_y}) not found"))?;

        let captured = screen.capture().map_err(|e| e.to_string())?;
        let cap_w = captured.width();
        let cap_h = captured.height();
        let rgba = image::RgbaImage::from_raw(cap_w, cap_h, Vec::from(captured))
            .ok_or_else(|| "Failed to wrap captured screen buffer".to_string())?;

        let info = screen.display_info;
        let rel_left = if info.x == monitor_x {
            left
        } else {
            (target_x - info.x).max(0) as u32
        };
        let rel_top = if info.y == monitor_y {
            top
        } else {
            (target_y - info.y).max(0) as u32
        };

        let dest = overlay_cut_path(&app_handle)?;
        save_padded_crop(&rgba, rel_left, rel_top, width, height, scale_factor, &dest)
    }
}

#[tauri::command]
pub fn get_text(state: tauri::State<StringWrapper>) -> String {
    return state.0.lock().unwrap().to_string();
}

#[tauri::command]
pub fn reload_store() {
    crate::config::reload();
}

/// Crop `pot_screenshot.png` with the same padding rules used by the UI.
/// `scale_factor` is the DPI factor of the monitor the screenshot belongs to.
pub fn cut_image_at(
    left: u32,
    top: u32,
    width: u32,
    height: u32,
    scale_factor: f64,
) -> Result<CropInfo, String> {
    use dirs::cache_dir;
    use image::GenericImage;
    info!("Cut image: {}x{}+{}+{}", width, height, left, top);
    let mut app_cache_dir_path = cache_dir().ok_or("Get Cache Dir Failed")?;
    let app_handle = APP.get().ok_or("App handle not ready")?;
    app_cache_dir_path.push(&app_handle.config().tauri.bundle.identifier);
    app_cache_dir_path.push("pot_screenshot.png");
    if !app_cache_dir_path.exists() {
        return Err("pot_screenshot.png not found".to_string());
    }
    let mut img = image::open(&app_cache_dir_path).map_err(|e| e.to_string())?;
    // Add a small padding so characters touching the selection edge are kept.
    let padding = (8.0 * scale_factor).round() as u32;
    let image_width = img.width();
    let image_height = img.height();
    let right = (left.saturating_add(width)).min(image_width);
    let bottom = (top.saturating_add(height)).min(image_height);
    if right <= left || bottom <= top {
        return Err("Invalid cut area after clamping".to_string());
    }
    let padded_left = left.saturating_sub(padding);
    let padded_top = top.saturating_sub(padding);
    let padded_right = right.saturating_add(padding).min(image_width);
    let padded_bottom = bottom.saturating_add(padding).min(image_height);
    let padded_width = padded_right - padded_left;
    let padded_height = padded_bottom - padded_top;
    info!(
        "Padded cut area: {}x{}+{}+{} (padding {})",
        padded_width, padded_height, padded_left, padded_top, padding
    );
    let img2 = img.sub_image(padded_left, padded_top, padded_width, padded_height);
    app_cache_dir_path.pop();
    app_cache_dir_path.push("pot_screenshot_cut.png");
    save_rgba_png_fast(&img2.to_image(), &app_cache_dir_path)?;
    Ok(CropInfo {
        padding_left: left - padded_left,
        padding_top: top - padded_top,
    })
}

#[tauri::command]
pub fn cut_image(
    left: u32,
    top: u32,
    width: u32,
    height: u32,
    window: tauri::Window,
) -> Result<CropInfo, String> {
    cut_image_at(
        left,
        top,
        width,
        height,
        window.scale_factor().unwrap_or(1.0),
    )
}

#[tauri::command]
pub fn get_base64(app_handle: tauri::AppHandle) -> String {
    match cache_file_path(&app_handle, "pot_screenshot_cut.png") {
        Ok(path) => encode_file_base64(&path),
        Err(_) => String::new(),
    }
}

#[tauri::command]
pub fn copy_img(app_handle: tauri::AppHandle, width: usize, height: usize) -> Result<(), Error> {
    use arboard::{Clipboard, ImageData};
    use dirs::cache_dir;
    use image::ImageReader;
    use std::borrow::Cow;

    let mut app_cache_dir_path = cache_dir().expect("Get Cache Dir Failed");
    app_cache_dir_path.push(&app_handle.config().tauri.bundle.identifier);
    app_cache_dir_path.push("pot_screenshot_cut.png");
    let data = ImageReader::open(app_cache_dir_path)?.decode()?;

    let img = ImageData {
        width,
        height,
        bytes: Cow::from(data.as_bytes()),
    };
    let result = Clipboard::new()?.set_image(img)?;
    Ok(result)
}

#[tauri::command]
pub fn set_proxy() -> Result<bool, ()> {
    let host = match get("proxy_host") {
        Some(v) => v.as_str().unwrap().to_string(),
        None => return Err(()),
    };
    let port = match get("proxy_port") {
        Some(v) => v.as_i64().unwrap(),
        None => return Err(()),
    };
    let no_proxy = match get("no_proxy") {
        Some(v) => v.as_str().unwrap().to_string(),
        None => return Err(()),
    };
    let proxy = format!("http://{}:{}", host, port);

    std::env::set_var("http_proxy", &proxy);
    std::env::set_var("https_proxy", &proxy);
    std::env::set_var("all_proxy", &proxy);
    std::env::set_var("no_proxy", &no_proxy);
    Ok(true)
}

#[tauri::command]
pub fn unset_proxy() -> Result<bool, ()> {
    std::env::remove_var("http_proxy");
    std::env::remove_var("https_proxy");
    std::env::remove_var("all_proxy");
    std::env::remove_var("no_proxy");
    Ok(true)
}

#[tauri::command]
pub fn install_plugin(path_list: Vec<String>) -> Result<i32, Error> {
    let mut success_count = 0;

    for path in path_list {
        if !path.ends_with("potext") {
            continue;
        }
        let path = std::path::Path::new(&path);
        let file_name = path.file_name().unwrap().to_str().unwrap();
        let file_name = file_name.replace(".potext", "");
        if !file_name.starts_with("plugin") {
            return Err(Error::Error(
                "Invalid Plugin: file name must start with plugin".into(),
            ));
        }

        let mut zip = zip::ZipArchive::new(std::fs::File::open(path)?)?;
        #[allow(unused_mut)]
        let mut plugin_type: String;
        if let Ok(mut info) = zip.by_name("info.json") {
            let mut content = String::new();
            info.read_to_string(&mut content)?;
            let json: serde_json::Value = serde_json::from_str(&content)?;
            plugin_type = json["plugin_type"]
                .as_str()
                .ok_or(Error::Error("can't find plugin type in info.json".into()))?
                .to_string();
        } else {
            return Err(Error::Error("Invalid Plugin: miss info.json".into()));
        }
        if zip.by_name("main.js").is_err() {
            return Err(Error::Error("Invalid Plugin: miss main.js".into()));
        }
        let config_path = dirs::config_dir().unwrap();
        let config_path =
            config_path.join(APP.get().unwrap().config().tauri.bundle.identifier.clone());
        let config_path = config_path.join("plugins");
        let config_path = config_path.join(plugin_type);
        let plugin_path = config_path.join(file_name);
        std::fs::create_dir_all(&config_path)?;
        zip.extract(&plugin_path)?;

        success_count += 1;
    }
    Ok(success_count)
}

#[tauri::command]
pub fn run_binary(
    plugin_type: String,
    plugin_name: String,
    cmd_name: String,
    args: Vec<String>,
) -> Result<Value, Error> {
    #[cfg(target_os = "windows")]
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    let config_path = dirs::config_dir().unwrap();
    let config_path = config_path.join(APP.get().unwrap().config().tauri.bundle.identifier.clone());
    let config_path = config_path.join("plugins");
    let config_path = config_path.join(plugin_type);
    let plugin_path = config_path.join(plugin_name);

    #[cfg(target_os = "windows")]
    let mut cmd = Command::new(&cmd_name);
    #[cfg(target_os = "windows")]
    let cmd = cmd.creation_flags(0x08000000);
    #[cfg(not(target_os = "windows"))]
    let mut cmd = Command::new(&cmd_name);

    let output = cmd.args(args).current_dir(plugin_path).output()?;
    Ok(json!({
        "stdout": String::from_utf8_lossy(&output.stdout).to_string(),
        "stderr": String::from_utf8_lossy(&output.stderr).to_string(),
        "status": output.status.code().unwrap_or(-1),
    }))
}

#[tauri::command]
pub fn font_list() -> Result<Vec<String>, Error> {
    use font_kit::source::SystemSource;
    let source = SystemSource::new();

    Ok(source.all_families()?)
}

#[tauri::command]
pub fn open_devtools(window: tauri::Window) {
    if !window.is_devtools_open() {
        window.open_devtools();
    } else {
        window.close_devtools();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose, Engine as _};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_image_path(name: &str) -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("pot_cmd_test_{}_{}_{}.png", name, std::process::id(), nanos))
    }

    #[test]
    fn encode_ocr_image_payload_downscales_oversized_images_to_jpeg() {
        let path = temp_image_path("large");
        let img = image::RgbaImage::from_fn(2400, 1200, |x, y| {
            image::Rgba([(x % 256) as u8, (y % 256) as u8, ((x + y) % 256) as u8, 255])
        });
        save_rgba_png_fast(&img, &path).unwrap();

        let payload = encode_ocr_image_payload(&path, 1600).unwrap();
        let _ = std::fs::remove_file(&path);

        assert_eq!(payload.mime_type, "image/jpeg");
        let decoded_bytes = general_purpose::STANDARD.decode(&payload.base64).unwrap();
        let decoded = image::load_from_memory(&decoded_bytes).unwrap();
        assert_eq!(decoded.width(), 1600);
        assert_eq!(decoded.height(), 800);
    }

    #[test]
    fn encode_ocr_image_payload_keeps_valid_small_png_or_jpeg() {
        let path = temp_image_path("tiny");
        let img = image::RgbaImage::from_pixel(64, 32, image::Rgba([255, 255, 255, 255]));
        save_rgba_png_fast(&img, &path).unwrap();

        let payload = encode_ocr_image_payload(&path, 1600).unwrap();
        let _ = std::fs::remove_file(&path);

        assert!(payload.mime_type == "image/png" || payload.mime_type == "image/jpeg");
        let decoded_bytes = general_purpose::STANDARD.decode(&payload.base64).unwrap();
        let decoded = image::load_from_memory(&decoded_bytes).unwrap();
        assert_eq!(decoded.width(), 64);
        assert_eq!(decoded.height(), 32);
    }
}
