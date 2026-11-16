use log::{error, info};

#[tauri::command]
pub fn screenshot(x: i32, y: i32) -> Result<(), String> {
    use crate::APP;
    use dirs::cache_dir;
    use screenshots::{Compression, Screen};
    use std::fs;
    info!("Screenshot screen with position: x={}, y={}", x, y);
    let screens = Screen::all().map_err(|e| {
        error!("Failed to enumerate screens: {}", e);
        e.to_string()
    })?;
    for screen in screens {
        let info = screen.display_info;
        info!("Screen: {:?}", info);
        if info.x == x && info.y == y {
            let handle = APP.get().unwrap();
            let mut app_cache_dir_path = cache_dir().ok_or_else(|| {
                error!("Get Cache Dir Failed");
                "Get Cache Dir Failed".to_string()
            })?;
            app_cache_dir_path.push(&handle.config().tauri.bundle.identifier);
            if !app_cache_dir_path.exists() {
                // 创建目录
                if let Err(e) = fs::create_dir_all(&app_cache_dir_path) {
                    error!("Create Cache Dir Failed: {}", e);
                    return Err(e.to_string());
                }
            }
            app_cache_dir_path.push("pot_screenshot.png");

            let image = match screen.capture() {
                Ok(v) => v,
                Err(e) => {
                    error!("Screen capture failed: {}", e);
                    return Err(e.to_string());
                }
            };
            let buffer = match image.to_png(Compression::Fast) {
                Ok(v) => v,
                Err(e) => {
                    error!("Encode screenshot failed: {}", e);
                    return Err(e.to_string());
                }
            };
            fs::write(app_cache_dir_path, buffer).map_err(|e| {
                error!("Write screenshot failed: {}", e);
                e.to_string()
            })?;
            return Ok(());
        }
    }
    Err(format!("Monitor at ({x}, {y}) not found"))
}
