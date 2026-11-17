use crate::config::{get, set};
use crate::window::{
    input_translate, last_translate_window, ocr_recognize, ocr_translate, overlay_hotkey,
    overlay_refresh_hotkey, selection_translate,
};
use crate::APP;
use log::{info, warn};
use tauri::{AppHandle, GlobalShortcutManager};

fn register<F>(app_handle: &AppHandle, name: &str, handler: F, key: &str) -> Result<(), String>
where
    F: Fn() + Send + 'static,
{
    let hotkey = {
        if key.is_empty() {
            match get(name) {
                Some(v) => v.as_str().unwrap().to_string(),
                None => {
                    set(name, "");
                    String::new()
                }
            }
        } else {
            key.to_string()
        }
    };

    if !hotkey.is_empty() {
        match app_handle
            .global_shortcut_manager()
            .register(hotkey.as_str(), handler)
        {
            Ok(()) => {
                info!("Registered global shortcut: {} for {}", hotkey, name);
            }
            Err(e) => {
                warn!("Failed to register global shortcut: {} {:?}", hotkey, e);
                return Err(e.to_string());
            }
        };
    }
    Ok(())
}

// Register global shortcuts
pub fn register_shortcut(shortcut: &str) -> Result<(), String> {
    let app_handle = APP.get().unwrap();
    match shortcut {
        "hotkey_selection_translate" => register(
            app_handle,
            "hotkey_selection_translate",
            selection_translate,
            "",
        )?,
        "hotkey_input_translate" => {
            register(app_handle, "hotkey_input_translate", input_translate, "")?
        }
        "hotkey_ocr_recognize" => register(app_handle, "hotkey_ocr_recognize", ocr_recognize, "")?,
        "hotkey_ocr_translate" => register(app_handle, "hotkey_ocr_translate", ocr_translate, "")?,
        "hotkey_overlay_translate" => {
            register(app_handle, "hotkey_overlay_translate", overlay_hotkey, "")?
        }
        "hotkey_overlay_refresh" => {
            register(app_handle, "hotkey_overlay_refresh", overlay_refresh_hotkey, "")?
        }
        "hotkey_last_window" => {
            register(app_handle, "hotkey_last_window", last_translate_window, "")?
        }
        "all" => {
            // 逐个注册并收集失败项：单个热键被其他程序占用时，
            // 不能让后面的热键全部注册不上。
            let hotkeys: [(&str, fn()); 7] = [
                ("hotkey_selection_translate", selection_translate),
                ("hotkey_input_translate", input_translate),
                ("hotkey_ocr_recognize", ocr_recognize),
                ("hotkey_ocr_translate", ocr_translate),
                ("hotkey_overlay_translate", overlay_hotkey),
                ("hotkey_overlay_refresh", overlay_refresh_hotkey),
                ("hotkey_last_window", last_translate_window),
            ];
            let mut failed: Vec<String> = Vec::new();
            for (name, handler) in hotkeys {
                if let Err(e) = register(app_handle, name, handler, "") {
                    failed.push(format!("{name}: {e}"));
                }
            }
            if !failed.is_empty() {
                return Err(failed.join("; "));
            }
        }
        _ => {}
    }
    Ok(())
}

#[tauri::command]
pub fn register_shortcut_by_frontend(name: &str, shortcut: &str) -> Result<(), String> {
    let app_handle = APP.get().unwrap();
    match name {
        "hotkey_selection_translate" => register(
            app_handle,
            "hotkey_selection_translate",
            selection_translate,
            shortcut,
        )?,
        "hotkey_input_translate" => register(
            app_handle,
            "hotkey_input_translate",
            input_translate,
            shortcut,
        )?,
        "hotkey_ocr_recognize" => {
            register(app_handle, "hotkey_ocr_recognize", ocr_recognize, shortcut)?
        }
        "hotkey_ocr_translate" => {
            register(app_handle, "hotkey_ocr_translate", ocr_translate, shortcut)?
        }
        "hotkey_overlay_translate" => {
            register(app_handle, "hotkey_overlay_translate", overlay_hotkey, shortcut)?
        }
        "hotkey_overlay_refresh" => {
            register(app_handle, "hotkey_overlay_refresh", overlay_refresh_hotkey, shortcut)?
        }
        "hotkey_last_window" => {
            register(app_handle, "hotkey_last_window", last_translate_window, shortcut)?
        }
        _ => {}
    }
    Ok(())
}
