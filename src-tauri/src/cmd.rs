use crate::config::get;
use crate::config::StoreWrapper;
use crate::error::Error;
use crate::StringWrapper;
use crate::APP;
use log::{error, info};
use serde_json::{json, Value};
use std::io::Read;
use tauri::Manager;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CropInfo {
    pub padding_left: u32,
    pub padding_top: u32,
}

#[tauri::command(async)]
pub fn show_overlay_error(window: tauri::Window, title: String, body: String) {
    crate::window::OVERLAY_DIALOG_OPEN.store(true, std::sync::atomic::Ordering::SeqCst);
    tauri::api::dialog::message(Some(&window), title, body);
    #[cfg(target_os = "windows")]
    crate::window::finish_overlay_error_dialog();
    #[cfg(not(target_os = "windows"))]
    crate::window::OVERLAY_DIALOG_OPEN.store(false, std::sync::atomic::Ordering::SeqCst);
}

#[tauri::command]
pub fn get_text(state: tauri::State<StringWrapper>) -> String {
    return state.0.lock().unwrap().to_string();
}

#[tauri::command]
pub fn reload_store() {
    let state = APP.get().unwrap().state::<StoreWrapper>();
    let mut store = state.0.lock().unwrap();
    store.load().unwrap();
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
    img2.to_image()
        .save(&app_cache_dir_path)
        .map_err(|e| e.to_string())?;
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
    use base64::{engine::general_purpose, Engine as _};
    use dirs::cache_dir;
    use std::fs::File;
    use std::io::Read;
    let mut app_cache_dir_path = cache_dir().expect("Get Cache Dir Failed");
    app_cache_dir_path.push(&app_handle.config().tauri.bundle.identifier);
    app_cache_dir_path.push("pot_screenshot_cut.png");
    if !app_cache_dir_path.exists() {
        return "".to_string();
    }
    let mut file = File::open(app_cache_dir_path).unwrap();
    let mut vec = Vec::new();
    match file.read_to_end(&mut vec) {
        Ok(_) => {}
        Err(e) => {
            error!("{:?}", e.to_string());
            return "".to_string();
        }
    }
    let base64 = general_purpose::STANDARD.encode(&vec);
    base64.replace("\r\n", "")
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
